"""Wait for the uploaded Pages artifact to appear in the workflow run's REST API."""

import json
import os
import subprocess
import time


WAIT_SECONDS = 105
POLL_SECONDS = 5
API_TIMEOUT_SECONDS = 10


def wait_for_artifact(repository, run_id, name, uploaded_id):
    endpoint = f"repos/{repository}/actions/runs/{run_id}/artifacts"
    command = ["gh", "api", "--method", "GET", "--paginate", "--slurp",
               "-H", "Cache-Control: no-cache", endpoint, "-f", f"name={name}"]
    target = f'Pages artifact "{name}" (ID {uploaded_id}) in workflow run {run_id}'
    deadline = time.monotonic() + WAIT_SECONDS
    status = "artifact lookup did not complete"
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=True,
                                    timeout=min(API_TIMEOUT_SECONDS, remaining))
            matches = [artifact for page in json.loads(result.stdout) for artifact in page["artifacts"]
                       if artifact["name"] == name and (artifact.get("workflow_run") or {}).get("id") == run_id]
        except subprocess.CalledProcessError as exc:
            status = f"GitHub API request failed (gh exit {exc.returncode}): {' '.join(exc.stderr.split())}"
        except subprocess.TimeoutExpired:
            status = "GitHub API request timed out"
        except (ValueError, KeyError, TypeError):
            status = "GitHub API returned an invalid artifact list"
        else:
            # deploy-pages rejects duplicate names even if one of the records is expired.
            if len(matches) > 1:
                raise RuntimeError(f"Multiple artifacts match {target}: found {len(matches)}")
            if not matches:
                status = "no exact match for this workflow run"
            elif matches[0].get("expired") is not False:
                status = "matching artifact is expired or has no expiration status"
            elif matches[0].get("id") != uploaded_id:
                status = f"matching artifact has unexpected ID {matches[0].get('id')}"
            else:
                print(f"Found exactly one unexpired {target}")
                return

        delay = min(POLL_SECONDS, deadline - time.monotonic())
        if delay > 0:
            time.sleep(delay)

    raise RuntimeError(f"Timed out after {WAIT_SECONDS}s waiting for {target}: {status}")


if __name__ == "__main__":
    try:
        wait_for_artifact(os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_RUN_ID"]),
                          os.environ["PAGES_ARTIFACT_NAME"], int(os.environ["PAGES_ARTIFACT_ID"]))
    except (RuntimeError, ValueError) as exc:
        print(f"::error::{exc}", flush=True)
        raise SystemExit(1) from exc
