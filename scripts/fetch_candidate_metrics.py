#!/usr/bin/env python3
"""Stage 2a: gather GitHub telemetry for each applicant."""
from __future__ import annotations

import argparse
import sys
from collections import Counter

from common import GitHub, GitHubError, load_json, save_json


def fetch_metrics(gh: GitHub, repo: str, username: str) -> dict:
    m: dict = {"username": username}
    try:
        repos = gh.get(f"/users/{username}/repos", sort="updated", per_page=10)
        langs = Counter(r["language"] for r in repos if r.get("language"))
        m["languages"] = [l for l, _ in langs.most_common()]
        m["top_repos"] = [
            {"name": r["full_name"], "language": r.get("language"), "stars": r.get("stargazers_count", 0)}
            for r in sorted(repos, key=lambda r: -r.get("stargazers_count", 0))[:5]
        ]
        user = gh.get(f"/users/{username}")
        m["bio"] = user.get("bio")
        m["account_created"] = user.get("created_at")
        m["global_open_assigned"] = gh.search_count(f"is:issue is:open assignee:{username}")
        m["repo_open_assigned"] = gh.search_count(f"repo:{repo} is:issue is:open assignee:{username}")
        m["lifetime_merged_prs"] = gh.search_count(f"is:pr is:merged author:{username}")
        m["repo_merged_prs"] = gh.search_count(f"repo:{repo} is:pr is:merged author:{username}")
    except GitHubError as e:
        m["error"] = str(e)
        print(f"warning: {username}: {e}", file=sys.stderr)
    return m


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--context", help="context.json from fetch_issue_context.py")
    p.add_argument("--users", help="comma-separated usernames (standalone mode)")
    p.add_argument("--repo", help="owner/repo (required with --users)")
    p.add_argument("--out", help="Write JSON here (default stdout); may equal --context")
    a = p.parse_args()
    if a.context:
        ctx = load_json(a.context)
    elif a.users and a.repo:
        ctx = {
            "repo": a.repo,
            "issue": {"number": 0, "title": "", "body": "", "labels": [], "tier": "intermediate"},
            "applicants": [{"username": u.strip(), "comments": []} for u in a.users.split(",") if u.strip()],
        }
    else:
        raise SystemExit("Provide --context, or --users with --repo.")
    gh = GitHub()
    for app in ctx["applicants"]:
        app["metrics"] = fetch_metrics(gh, ctx["repo"], app["username"])
    save_json(ctx, a.out)


if __name__ == "__main__":
    main()
