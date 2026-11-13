"""Build Pages without writing generated data back to Git.

Published JSON is durable state; successful Actions artifacts add a checkpoint.
Restore failures stop publication. Parser failures publish new application code
with the restored football data. Both existing parsers run in a temporary folder.
"""
import argparse
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

import requests

# Support both imports in tests and `python scripts/build_pages.py`.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch_data import check_calendar_update, check_scorers_update, retain_calendar_source_ids
from scripts import multi_club_sources, multi_club_schema, multi_club_rosters, multi_club_matches, cfu_sync

ROOT = Path(__file__).resolve().parents[1]
MAX_JSON = 5_000_000
STAT_NUMBERS = ("league_games", "league_goals", "league_penalty_goals", "league_minutes",
                "league_starts", "league_substitutions")
STAT_FIELDS = (*STAT_NUMBERS, "profile_url", "photo_url", "photo_source_url")


class InvalidData(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidData(message)


def timestamp(data):
    value = datetime.fromisoformat(data["updated"].replace("Z", "+00:00"))
    require(value.tzinfo is not None, "updated must include a timezone")
    return value


def roster(data):
    names = []
    for members in data["squad"].values():
        require(isinstance(members, list), "Invalid squad group")
        for value in members:
            require(isinstance(value, str) and "|" in value, "Invalid squad entry")
            name, count = value.rsplit("|", 1)
            require(bool(name.strip()) and count.isdigit(), "Invalid player name/count")
            names.append(name)
    require(len(names) == len(set(names)), "Duplicate squad members")
    return set(names)


def identities(rows, field):
    require(isinstance(rows, list), f"Invalid list: {field}")
    require(all(isinstance(row, dict) and row.get(field) is not None for row in rows),
            f"Missing identity: {field}")
    ids = {str(row[field]) for row in rows}
    require(len(ids) == len(rows), f"Duplicate identity: {field}")
    return ids


def validate(data, previous=None):
    """Reject incomplete responses, including plausible but truncated HTML parses."""
    section = 'root'
    try:
        require(isinstance(data, dict), "JSON must be an object")
        stamp = timestamp(data)
        require(stamp <= datetime.now(timezone.utc) + timedelta(minutes=5), "Future updated")
        section = 'club.table'
        table = data["table"]
        require(isinstance(table, list) and len(table) >= 5, "Incomplete standings")
        for row in table:
            require(isinstance(row, list) and len(row) >= 4 and isinstance(row[0], str)
                    and type(row[1]) is int and row[1] >= 0 and type(row[3]) is int
                    and re.fullmatch(r"\d+[-–]\d+", row[2]), "Invalid standings row")
        require(any(re.sub(r'[«»"\s]', '', r[0]).casefold() == "фксудак" for r in table),
                "Sudak missing from standings")
        for key, size in (("res", 6), ("next", 4), ("news", 4)):
            section = 'club.' + key
            require(isinstance(data[key], list), f"Invalid {key}")
            require(all(isinstance(r, list) and len(r) >= size for r in data[key]),
                    f"Invalid {key} row")
        section = 'club.res'
        require(len(data["res"]) >= 3, "Incomplete results")
        require(all(type(r[i]) is int and r[i] >= 0 for r in data["res"] for i in (2, 3)),
                "Invalid score")
        section = 'club.squad'
        require(isinstance(data["squad"], dict), "Invalid squad")
        names = roster(data)
        require(len(names) >= 10, "Incomplete squad")
        require(isinstance(data["coach"], str) and bool(data["coach"].strip()), "Missing coach")
        section = 'club.player_stats_2026'
        stats = data["player_stats_2026"]
        require(stats["season"] == 2026, "Wrong player season")
        require(identities(stats["players"], "name") == names, "Player profiles differ from squad")
        for player in stats["players"]:
            require(all(player.get(f) is None or (type(player[f]) is int and player[f] >= 0)
                        for f in STAT_NUMBERS), "Invalid player statistics")
        section = 'club.match_details'
        details = data["match_details"]
        require(isinstance(details, dict), "Invalid match protocols")
        require(all(isinstance(v, dict) and v.get("status") in ("available", "unavailable")
                    for v in details.values()), "Invalid protocol status")
        for key, detail in details.items():
            section = f'club.match_details[{key}] source_id={detail.get("id")}'
            if detail["status"] == "available":
                require(detail.get("id") and detail.get("date") and detail.get("home")
                        and detail.get("away") and isinstance(detail.get("lineups"), dict)
                        and isinstance(detail.get("events"), list), "Incomplete protocol")
        section = 'championship.calendar'
        hub = data["championship"]
        require(hub["season"] == 2026, "Wrong championship season")
        calendar = hub["calendar"]
        require(len(identities(calendar["rounds"], "id")) >= 22, "Incomplete rounds")
        require(len(identities(calendar["teams"], "id")) >= 5, "Incomplete championship teams")
        require(bool(identities(calendar["matches"], "id")), "Empty championship calendar")
        check_calendar_update(calendar, previous['championship']['calendar'] if previous else None)
        section = 'championship.scorers'
        identities(hub["scorers"]["players"], "id")
        check_scorers_update(hub['scorers'], previous['championship']['scorers'] if previous else None)
        if previous is not None:
            section = 'club.retention'
            require(stamp >= timestamp(previous), "Older football data")
            require(roster(previous) <= names, "Lost published players")
            require(len(data["res"]) >= len(previous["res"]), "Lost published results")
            require(len(table) >= len(previous["table"]), "Lost standings teams")
            require(bool(data["news"]) or not previous["news"], "Lost news")
            for key, old in previous["match_details"].items():
                section = f'club.match_details[{key}] source_id={old.get("id")}'
                if old["status"] == "available":
                    new = details.get(key, {})
                    require(new.get("status") == "available" and new.get("id") == old.get("id"),
                            "Lost published match protocol")
                    for field in ("venue", "time", "competition", "round", "lineups"):
                        if old.get(field):
                            require(bool(new.get(field)), f"Lost protocol field: {field}")
                    for field in ("goals", "events"):
                        if old.get(field):
                            require(isinstance(new.get(field), list) and len(new[field]) >= len(old[field]),
                                    f"Truncated protocol {field}")
                    if old.get("events_complete"):
                        require(new.get("events_complete") is True, "Incomplete protocol events")
            players = {p["name"]: p for p in stats["players"]}
            for old in previous["player_stats_2026"]["players"]:
                section = f'club.player_stats_2026[{old["name"]}]'
                for field in STAT_FIELDS:
                    if old.get(field) is not None:
                        require(players.get(old["name"], {}).get(field) is not None,
                                f"Lost confirmed player field: {field}")
            # Calendar history is durable; scorers is a bounded published list.
            # Both retention contracts were checked above, including cutoff
            # evidence for legitimate ranking turnover.
        section = 'platform'
        if "platform" in data:
            multi_club_schema.validate_platform(data["platform"],
                previous.get("platform") if previous is not None else None)
        elif previous is not None:
            require("platform" not in previous, "Lost platform block")
    except (KeyError, TypeError, AttributeError, IndexError, ValueError) as exc:
        raise InvalidData(f'{section}: {exc}') from exc
    return data


def decode_json(raw):
    require(len(raw) <= MAX_JSON, "Oversized JSON")
    def invalid_constant(value):
        raise InvalidData(f"Invalid JSON number: {value}")
    return validate(json.loads(raw, parse_constant=invalid_constant))


def published_data(site_url, session=None):
    session = session or requests.Session()
    for attempt in range(3):
        try:
            response = session.get(site_url.rstrip("/") + "/data.json",
                                   params={"pages-refresh": time.time_ns()}, timeout=30,
                                   headers={"Cache-Control": "no-cache", "Accept": "application/json"})
            response.raise_for_status()
            return decode_json(response.content)
        except (requests.RequestException, ValueError) as exc:
            if attempt == 2:
                raise RuntimeError("Cannot restore valid published data; site left unchanged") from exc
            time.sleep(2)


def successful_checkpoint(repository, token, session=None, include_cfu=False):
    """Read the newest successful production checkpoint, never a failed/PR run.

    API failures are fatal: ignoring a checkpoint could accept stale CDN data.
    No checkpoint (initial migration or retention expiry) is valid; Pages remains
    the durable source. Artifact creation order also handles old workflow reruns.
    """
    session = session or requests.Session()
    api = f"https://api.github.com/repos/{repository}"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    url = api + "/actions/artifacts?per_page=100"
    while url:
        response = session.get(url, headers=headers, timeout=30)
        response.raise_for_status()
        candidates = []
        for artifact in response.json()["artifacts"]:
            run = artifact.get("workflow_run", {})
            if (re.fullmatch(r"football-state-\d+-\d+", artifact["name"])
                    and not artifact["expired"] and run.get("head_branch") == "main"
                    and run.get("head_repository_id") == run.get("repository_id")):
                candidates.append(artifact)
        for artifact in sorted(candidates, key=lambda a: a["created_at"], reverse=True):
            run_id = artifact["workflow_run"]["id"]
            result = session.get(api + f"/actions/runs/{run_id}", headers=headers, timeout=30)
            result.raise_for_status()
            run = result.json()
            if (run["conclusion"] != "success" or run["status"] != "completed"
                    or run["event"] not in ("push", "schedule", "workflow_dispatch")
                    or run["path"] != ".github/workflows/update.yml"):
                continue
            result = session.get(api + f'/actions/artifacts/{artifact["id"]}/zip',
                                 headers=headers, timeout=60)
            result.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
                entries = [n for n in archive.namelist() if n.split("/")[-1] == "data.json"]
                require(len(entries) == 1, "Checkpoint has no unique data.json")
                require(archive.getinfo(entries[0]).file_size <= MAX_JSON, "Oversized checkpoint")
                data = decode_json(archive.read(entries[0]))
                if not include_cfu:
                    return data
                states = [n for n in archive.namelist() if n.split('/')[-1] == cfu_sync.PUBLIC_STATE]
                require(len(states) <= 1, 'Ambiguous CFU checkpoint')
                cfu = None
                if states:
                    require(archive.getinfo(states[0]).file_size <= MAX_JSON, 'Oversized CFU checkpoint')
                    cfu = cfu_sync.validate_state(json.loads(archive.read(states[0])))
                return data, cfu
        url = response.links.get("next", {}).get("url")
    return (None, None) if include_cfu else None


def football_revision(data):
    # Enrichment advances the publication revision, not the legacy football core.
    p = data.get('platform')
    return multi_club_schema.stamp(p['sourceUpdatedAt']) if p else timestamp(data)


def choose_baseline(seed, live, checkpoint=None):
    candidates = [validate(d) for d in (seed, live, checkpoint) if d is not None]
    core = max(candidates, key=lambda d: (football_revision(d), timestamp(d)))
    baseline = copy.deepcopy(core)
    for candidate in candidates:
        # Migrate snapshots that already lost a technical match URL when its
        # teaser rotated. An existing conflicting ID is never overwritten.
        retain_calendar_source_ids(baseline['championship']['calendar'], candidate['championship']['calendar'])
    baseline["updated"] = max(candidates, key=timestamp)["updated"]
    # Old production JSON remains valid during rollout. Carry its newest known
    # optional platform forward rather than discarding it for a newer legacy root.
    platforms = [d for d in candidates if "platform" in d]
    if platforms:
        # A standings-only refresh can share the same sourceUpdatedAt with the
        # seed. Its enclosing publication revision breaks that tie; seed order
        # must not roll back an already published extension.
        newest = max(platforms, key=lambda d: (
            multi_club_schema.stamp(d["platform"]["sourceUpdatedAt"]), timestamp(d)))
        baseline["platform"] = copy.deepcopy(newest["platform"])
        for candidate in platforms:
            if candidate is newest:
                continue
            baseline["platform"] = multi_club_rosters.merge_roster_enrichment(baseline["platform"], candidate["platform"])
            baseline["platform"] = multi_club_matches.merge_protocols(baseline["platform"], candidate["platform"])
        if "platform" not in core:
            baseline["platform"] = multi_club_sources.project_snapshot(
                baseline, baseline["platform"], source_updated_at=football_revision(core).isoformat())
    for previous in candidates:
        validate(baseline, previous)
    return copy.deepcopy(baseline)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")


def warning(section, exc, retained):
    message = f'{section}: {type(exc).__name__}: {exc}; using last-good {retained}'
    # Keep source/exception text inside one Actions annotation.
    message = message.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
    print(f'::warning::{message}')


def refresh_summary(previous, data):
    changed = [key for key in data if data[key] != previous.get(key)]
    kept = [key for key in data if data[key] == previous.get(key)]
    print(f'RFFK snapshot: updated sections={changed}; retained sections={kept}; revision={data["updated"]}')
    old = {m['id']: m for m in previous['championship']['calendar']['matches']}
    fields = ('source_id', 'date', 'time', 'status', 'home_score', 'away_score')
    for m in data['championship']['calendar']['matches']:
        if any(m.get(f) != old.get(m['id'], {}).get(f) for f in fields):
            print(f'RFFK championship.calendar: match_id={m["id"]} source_id={m["source_id"]} '
                  f'date={m["date"]} status={m["status"]} score={m["home_score"]}:{m["away_score"]}')
    for name in ('calendar', 'scorers'):
        value = data['championship'][name]
        if value.get('stale'):
            print(f'::warning::championship.{name}: last-good section retained; lastVerifiedAt={value.get("updated")}')


def refresh(baseline, work, runner=subprocess.run, platform_loader=None, roster_loader=None, match_loader=None):
    """Run existing parsers in isolation; promote only validated snapshots."""
    accepted = copy.deepcopy(baseline)
    core_revision = football_revision(baseline)
    for script in ("fetch_data.py", "update_player_stats.py"):
        write_json(work / "data.json", accepted)
        # Never let main's old cache override statistics from the previous run.
        write_json(work / "player_stats_cache_2026.json", accepted["player_stats_2026"])
        try:
            runner([sys.executable, str(ROOT / script)], cwd=work, check=True, timeout=480)
            raw = (work / "data.json").read_bytes()
            # Existing fetch_data intentionally reconstructs the old root object.
            # Restore only a missing extension, then validate before promotion.
            candidate = decode_json(raw)
            if "platform" not in candidate and "platform" in accepted:
                candidate["platform"] = copy.deepcopy(accepted["platform"])
            # fetch_data uses minute precision; our deployed revision uses
            # seconds. A second manual run in that same minute is still fresh.
            if candidate == accepted:
                continue
            old_stamp, new_stamp = timestamp(accepted), timestamp(candidate)
            require(new_stamp >= core_revision.replace(second=0, microsecond=0), "Older legacy football snapshot")
            next_core_revision = max(core_revision, new_stamp)
            if new_stamp < old_stamp:
                candidate["updated"] = accepted["updated"]
            if "platform" in candidate:
                # Validate one coherent snapshot, rather than accepting new
                # legacy matches with the previous platform until a later step.
                candidate['platform'] = multi_club_sources.project_snapshot(
                    candidate, accepted.get('platform'), source_updated_at=next_core_revision.isoformat())
            validate(candidate, accepted)
            accepted = candidate
            core_revision = next_core_revision
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            warning(script, exc, f'football data revision={accepted["updated"]}; '
                    f'calendar lastVerifiedAt={accepted["championship"]["calendar"].get("updated")}')
    if platform_loader is not None or accepted != baseline or "platform" not in accepted:
        try:
            accepted["platform"] = multi_club_sources.update_platform(
                accepted, previous=accepted.get("platform"), loader=platform_loader,
                source_updated_at=core_revision.isoformat())
        except (ValueError, TypeError, KeyError) as exc:
            warning('platform', exc, 'extension')
    if roster_loader is not None:
        try:
            accepted['platform'], _ = multi_club_rosters.sync_platform(accepted['platform'], roster_loader)
        except (ValueError, TypeError, KeyError) as exc:
            warning('club-rosters', exc, 'extension')
    if match_loader is not None:
        try:
            accepted['platform'], _ = multi_club_matches.sync_platform(accepted['platform'], match_loader)
        except (ValueError, TypeError, KeyError) as exc:
            warning('match-protocols', exc, 'extension')
    # Enrichment can change without fetch_data advancing its minute timestamp.
    # Every changed payload needs a newer revision for already-open PWA clients.
    if accepted != baseline:
        accepted["updated"] = max(datetime.now(timezone.utc), timestamp(baseline) + timedelta(seconds=1)).isoformat(timespec="seconds")
    validate(accepted, baseline)
    refresh_summary(baseline, accepted)
    return accepted


def stage_site(source, output, data, cfu=None):
    require(not output.exists(), "Output directory already exists")
    output.mkdir(parents=True)
    # Preserve application assets and future static files, exclude build tools.
    excluded = {"tests", "scripts", "docs", "__pycache__", "node_modules", "_site", "_state"}
    for item in source.iterdir():
        if item.name.startswith(".") or item.name in excluded or item.suffix in (".py", ".md", ".txt"):
            continue
        if item.name in ("data.json", "player_stats_cache_2026.json"):
            continue
        target = output / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    write_json(output / "data.json", data)
    if cfu is not None or all((source / name).exists() for name in (cfu_sync.CALENDAR_FILE, cfu_sync.DETAILS_FILE)):
        cfu_sync.stage(output, cfu if cfu is not None else cfu_sync.seed_state(source))
    (output / ".nojekyll").touch()
    for name in ("index.html", "sw.js", "manifest.json", "icon-192.png", "icon-512.png"):
        require((output / name).is_file(), f"Missing PWA asset: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--output", type=Path, default=Path("_site"))
    parser.add_argument('--force-cfu', action='store_true', default=os.environ.get('CFU_FORCE') == 'true',
                        help='One explicit manual CFU check outside matchday slots')
    args = parser.parse_args()
    cfu_sync.require_current_workflow(ROOT, os.environ['GITHUB_REPOSITORY'], os.environ['GH_TOKEN'],
                                       os.environ.get('GITHUB_WORKFLOW_SHA'))
    seed = decode_json((ROOT / "data.json").read_bytes())
    live = published_data(args.site_url)
    checkpoint, cfu_checkpoint = successful_checkpoint(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"], include_cfu=True)
    baseline = choose_baseline(seed, live, checkpoint)
    cfu_baseline = cfu_sync.choose_state(cfu_sync.seed_state(ROOT),
                                         cfu_sync.published_state(args.site_url), cfu_checkpoint)
    with tempfile.TemporaryDirectory(prefix="sudak-pages-") as directory:
        data = refresh(baseline, Path(directory), platform_loader=multi_club_sources.fetch_season,
                       roster_loader=multi_club_rosters.NetworkLoader(),
                       match_loader=multi_club_matches.NetworkLoader())
    cfu = cfu_sync.refresh(cfu_baseline, rosters=json.loads((ROOT / 'cfu-premier-rosters-2026.json').read_text()),
                           force=args.force_cfu)
    stage_site(ROOT, args.output, data, cfu=cfu)
    state = ROOT / "_state"
    state.mkdir(exist_ok=True)
    write_json(state / "player_stats_cache_2026.json", data["player_stats_2026"])
    print(f'Pages ready: updated={data["updated"]}, players={len(roster(data))}, '
          f'protocols={len(data["match_details"])}, rounds={len(data["championship"]["calendar"]["rounds"])}')


if __name__ == "__main__":
    main()
