#!/usr/bin/env python3
"""Stage 3b: assign the approved candidate, or emit an advisory snippet if the caller lacks write access."""
from __future__ import annotations

import argparse
import sys

from common import GitHub, GitHubError, load_json


def advisory(repo: str, number: int, user: str, c: dict | None) -> str:
    why = f"\n> {c['justification']}" if c and c.get("justification") else ""
    score = f" (score {c['score']}/10, risk {c['risk']})" if c else ""
    return (f"**GitAssign recommendation for {repo}#{number}**\n\nRecommended assignee: @{user}{score}.{why}\n\n"
            f"Assign with: `gh issue edit {number} --repo {repo} --add-assignee {user}`")


def can_write(gh: GitHub, repo: str) -> bool:
    perms = gh.get(f"/repos/{repo}").get("permissions") or {}
    return bool(perms.get("push") or perms.get("triage") or perms.get("maintain") or perms.get("admin"))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", required=True, help="evaluation.json")
    p.add_argument("--user", help="Login to assign (default: top-ranked candidate)")
    p.add_argument("--confirm", action="store_true", help="Required: maintainer has approved this assignment")
    a = p.parse_args()
    ev = load_json(a.data)
    repo, number = ev["repo"], ev["issue"]["number"]
    cands = {c["username"].lower(): c for c in ev["candidates"]}
    user = a.user or (ev["candidates"][0]["username"] if ev["candidates"] else None)
    if not user or user.lower() not in cands:
        raise SystemExit(f"'{user}' is not an evaluated candidate for {repo}#{number}.")
    c = cands[user.lower()]
    if not a.confirm:
        raise SystemExit(f"Refusing to assign @{user} without --confirm (maintainer approval required).")
    gh = GitHub()
    if not gh.token:
        print("No GITHUB_TOKEN; cannot assign. Advisory output:\n")
        print(advisory(repo, number, user, c))
        return
    try:
        if not can_write(gh, repo):
            print(f"Token lacks triage/write access to {repo}. Advisory output:\n")
            print(advisory(repo, number, user, c))
            return
        resp = gh.request("POST", f"/repos/{repo}/issues/{number}/assignees", json={"assignees": [user]}).json()
    except GitHubError as e:
        print(f"Assignment failed: {e}\n\nAdvisory output:\n", file=sys.stderr)
        print(advisory(repo, number, user, c))
        raise SystemExit(1)
    assigned = [x["login"] for x in resp.get("assignees", [])]
    if user.lower() not in [x.lower() for x in assigned]:
        raise SystemExit(f"GitHub accepted the request but @{user} is not assignee (not a collaborator?). Assignees: {assigned}")
    print(f"Assigned @{user} to {repo}#{number}.")


if __name__ == "__main__":
    main()
