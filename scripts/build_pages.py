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
from scripts import multi_club_sources, multi_club_schema

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
    try:
        require(isinstance(data, dict), "JSON must be an object")
        stamp = timestamp(data)
        require(stamp <= datetime.now(timezone.utc) + timedelta(minutes=5), "Future updated")
        table = data["table"]
        require(isinstance(table, list) and len(table) >= 5, "Incomplete standings")
        for row in table:
            require(isinstance(row, list) and len(row) >= 4 and isinstance(row[0], str)
                    and type(row[1]) is int and row[1] >= 0 and type(row[3]) is int
                    and re.fullmatch(r"\d+[-–]\d+", row[2]), "Invalid standings row")
        require(any(re.sub(r'[«»"\s]', '', r[0]).casefold() == "фксудак" for r in table),
                "Sudak missing from standings")
        for key, size in (("res", 6), ("next", 4), ("news", 4)):
            require(isinstance(data[key], list), f"Invalid {key}")
            require(all(isinstance(r, list) and len(r) >= size for r in data[key]),
                    f"Invalid {key} row")
        require(len(data["res"]) >= 3, "Incomplete results")
        require(all(type(r[i]) is int and r[i] >= 0 for r in data["res"] for i in (2, 3)),
                "Invalid score")
        require(isinstance(data["squad"], dict), "Invalid squad")
        names = roster(data)
        require(len(names) >= 10, "Incomplete squad")
        require(isinstance(data["coach"], str) and bool(data["coach"].strip()), "Missing coach")
        stats = data["player_stats_2026"]
        require(stats["season"] == 2026, "Wrong player season")
        require(identities(stats["players"], "name") == names, "Player profiles differ from squad")
        for player in stats["players"]:
            require(all(player.get(f) is None or (type(player[f]) is int and player[f] >= 0)
                        for f in STAT_NUMBERS), "Invalid player statistics")
        details = data["match_details"]
        require(isinstance(details, dict), "Invalid match protocols")
        require(all(isinstance(v, dict) and v.get("status") in ("available", "unavailable")
                    for v in details.values()), "Invalid protocol status")
        for detail in details.values():
            if detail["status"] == "available":
                require(detail.get("id") and detail.get("date") and detail.get("home")
                        and detail.get("away") and isinstance(detail.get("lineups"), dict)
                        and isinstance(detail.get("events"), list), "Incomplete protocol")
        hub = data["championship"]
        require(hub["season"] == 2026, "Wrong championship season")
        calendar = hub["calendar"]
        require(len(identities(calendar["rounds"], "id")) >= 22, "Incomplete rounds")
        require(len(identities(calendar["teams"], "id")) >= 5, "Incomplete championship teams")
        require(bool(identities(calendar["matches"], "id")), "Empty championship calendar")
        identities(hub["scorers"]["players"], "id")
        if previous is not None:
            require(stamp >= timestamp(previous), "Older football data")
            require(roster(previous) <= names, "Lost published players")
            require(len(data["res"]) >= len(previous["res"]), "Lost published results")
            require(len(table) >= len(previous["table"]), "Lost standings teams")
            require(bool(data["news"]) or not previous["news"], "Lost news")
            for key, old in previous["match_details"].items():
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
                for field in STAT_FIELDS:
                    if old.get(field) is not None:
                        require(players.get(old["name"], {}).get(field) is not None,
                                f"Lost confirmed player field: {field}")
            for section, key in (("calendar", "rounds"), ("calendar", "matches"),
                                 ("calendar", "teams"), ("scorers", "players")):
                require(identities(previous["championship"][section][key], "id")
                        <= identities(hub[section][key], "id"), f"Lost championship {key}")
        if "platform" in data:
            multi_club_schema.validate_platform(data["platform"],
                previous.get("platform") if previous is not None else None)
        elif previous is not None:
            require("platform" not in previous, "Lost platform block")
    except (KeyError, TypeError, AttributeError, IndexError, ValueError) as exc:
        raise InvalidData(str(exc)) from exc
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


def successful_checkpoint(repository, token, session=None):
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
                return decode_json(archive.read(entries[0]))
        url = response.links.get("next", {}).get("url")
    return None


def choose_baseline(seed, live, checkpoint=None):
    candidates = [validate(d) for d in (seed, live, checkpoint) if d is not None]
    baseline = copy.deepcopy(max(candidates, key=timestamp))
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
    for previous in candidates:
        validate(baseline, previous)
    return copy.deepcopy(baseline)


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1, allow_nan=False) + "\n", encoding="utf-8")


def refresh(baseline, work, runner=subprocess.run, platform_loader=None):
    """Run existing parsers in isolation; promote only validated snapshots."""
    accepted = copy.deepcopy(baseline)
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
            old_stamp, new_stamp = timestamp(accepted), timestamp(candidate)
            if old_stamp.replace(second=0, microsecond=0) <= new_stamp < old_stamp:
                candidate["updated"] = accepted["updated"]
            validate(candidate, accepted)
            accepted = candidate
        except (subprocess.SubprocessError, OSError, ValueError) as exc:
            print(f"::warning::{script}: {type(exc).__name__}; using last-good football data")
    if platform_loader is not None or accepted != baseline or "platform" not in accepted:
        try:
            accepted["platform"] = multi_club_sources.update_platform(
                accepted, previous=accepted.get("platform"), loader=platform_loader)
        except (ValueError, TypeError, KeyError) as exc:
            print(f"::warning::platform: {type(exc).__name__}; using last-good extension")
    # Enrichment can change without fetch_data advancing its minute timestamp.
    # Every changed payload needs a newer revision for already-open PWA clients.
    if accepted != baseline:
        accepted["updated"] = max(datetime.now(timezone.utc), timestamp(baseline) + timedelta(seconds=1)).isoformat(timespec="seconds")
    validate(accepted, baseline)
    return accepted


def stage_site(source, output, data):
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
    (output / ".nojekyll").touch()
    for name in ("index.html", "sw.js", "manifest.json", "icon-192.png", "icon-512.png"):
        require((output / name).is_file(), f"Missing PWA asset: {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-url", required=True)
    parser.add_argument("--output", type=Path, default=Path("_site"))
    args = parser.parse_args()
    seed = decode_json((ROOT / "data.json").read_bytes())
    live = published_data(args.site_url)
    checkpoint = successful_checkpoint(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    baseline = choose_baseline(seed, live, checkpoint)
    with tempfile.TemporaryDirectory(prefix="sudak-pages-") as directory:
        data = refresh(baseline, Path(directory), platform_loader=multi_club_sources.fetch_season)
    stage_site(ROOT, args.output, data)
    state = ROOT / "_state"
    state.mkdir(exist_ok=True)
    write_json(state / "player_stats_cache_2026.json", data["player_stats_2026"])
    print(f'Pages ready: updated={data["updated"]}, players={len(roster(data))}, '
          f'protocols={len(data["match_details"])}, rounds={len(data["championship"]["calendar"]["rounds"])}')


if __name__ == "__main__":
    main()
