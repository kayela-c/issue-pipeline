#!/usr/bin/env python3
"""Smoke test for a deployed issue-pipeline environment (docs/ARCHITECTURE.md
section 9, Phase 5 accept criterion).

Runs the full happy path against a live site: track a repo, submit raw notes,
wait for drafting, approve the first draft, post it to Gitea, and confirm it
shows up with a Gitea issue number. Authenticates as a bearer PAT, exactly
like a background job would (docs/ARCHITECTURE.md section 5, "Auth wrapper").

Usage:
    pip install -r scripts/requirements.txt
    python scripts/smoke_test.py --base-url https://<site>.netlify.app \
        --token <gitea-personal-access-token> --owner TrueRoster --repo app

The token needs the same scopes the app itself requests: read:user
read:organization read:repository write:issue.
"""

from __future__ import annotations

import argparse
import sys
import time

import requests

POLL_INTERVAL_SECONDS = 3
RUN_TIMEOUT_SECONDS = 8 * 60
POST_TIMEOUT_SECONDS = 60


class SmokeTestFailure(Exception):
    pass


def call(session: requests.Session, method: str, url: str, **kwargs) -> dict:
    res = session.request(method, url, timeout=30, **kwargs)
    if not res.ok:
        raise SmokeTestFailure(f"{method} {url} -> {res.status_code}: {res.text[:500]}")
    return res.json() if res.content else {}


def wait_for(label: str, poll, is_done, is_failed, timeout_seconds: int):
    deadline = time.monotonic() + timeout_seconds
    while True:
        state = poll()
        if is_failed(state):
            raise SmokeTestFailure(f"{label} failed: {state}")
        if is_done(state):
            return state
        if time.monotonic() > deadline:
            raise SmokeTestFailure(f"{label} did not finish within {timeout_seconds}s: {state}")
        time.sleep(POLL_INTERVAL_SECONDS)


def run(base_url: str, token: str, owner: str, repo: str) -> None:
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token}"
    session.headers["Accept"] = "application/json"

    print(f"1. GET /api/health")
    call(session, "GET", f"{base_url}/api/health")

    print(f"2. GET /api/me")
    me = call(session, "GET", f"{base_url}/api/me")
    print(f"   signed in as {me.get('username')}")

    print(f"3. POST /api/repos ({owner}/{repo})")
    tracked = call(session, "POST", f"{base_url}/api/repos", json={"owner": owner, "name": repo})
    repo_id = tracked["id"]
    print(f"   repo id {repo_id}")

    print("4. POST /api/raw-issues")
    body = f"[smoke test {int(time.time())}] Add a health check endpoint under /internal/ping."
    created = call(session, "POST", f"{base_url}/api/raw-issues", json={"repo_id": repo_id, "body": body})
    run_id = created["run_id"]
    print(f"   run id {run_id}")

    print("5. waiting for drafting to finish")
    run_state = wait_for(
        "drafting run",
        poll=lambda: call(session, "GET", f"{base_url}/api/runs/{run_id}"),
        is_done=lambda s: s["status"] == "done",
        is_failed=lambda s: s["status"] == "failed",
        timeout_seconds=RUN_TIMEOUT_SECONDS,
    )
    print(f"   done: {len(run_state['draft_ids'])} draft(s), model {run_state.get('model_draft')}")

    print("6. GET /api/drafts?run_id=")
    listed = call(session, "GET", f"{base_url}/api/drafts", params={"run_id": run_id})
    drafts = listed["drafts"]
    if not drafts:
        raise SmokeTestFailure("the run produced no drafts")
    draft = drafts[0]
    print(f"   using draft {draft['id']!r} ({draft['title']!r})")

    print("7. POST /api/drafts/:id/approve")
    approved = call(
        session, "POST", f"{base_url}/api/drafts/{draft['id']}/approve", json={"version": draft["version"]}
    )
    assert approved["status"] == "approved", approved

    print("8. POST /api/drafts/:id/post")
    call(session, "POST", f"{base_url}/api/drafts/{draft['id']}/post", json={})

    print("9. waiting for the post to land")
    posted = wait_for(
        "post",
        poll=lambda: call(session, "GET", f"{base_url}/api/drafts/{draft['id']}"),
        is_done=lambda s: s["status"] == "posted",
        is_failed=lambda s: s["status"] == "failed",
        timeout_seconds=POST_TIMEOUT_SECONDS,
    )
    print(f"   posted as {posted['gitea_url']}")

    print("\nSMOKE TEST PASSED")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", required=True, help="e.g. https://issue-pipeline.netlify.app")
    parser.add_argument("--token", required=True, help="Gitea personal access token")
    parser.add_argument("--owner", required=True, help="Repo owner/org to track and post into")
    parser.add_argument("--repo", required=True, help="Repo name")
    args = parser.parse_args()

    try:
        run(args.base_url.rstrip("/"), args.token, args.owner, args.repo)
    except SmokeTestFailure as err:
        print(f"\nSMOKE TEST FAILED: {err}", file=sys.stderr)
        return 1
    except requests.RequestException as err:
        print(f"\nSMOKE TEST FAILED (network): {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
