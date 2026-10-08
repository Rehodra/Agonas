#!/usr/bin/env python3
"""Stage 1: ingest issue details and identify applicants from the comment thread."""
from __future__ import annotations

import argparse
import re
import sys

from common import GitHub, parse_target, save_json

CLAIM_RE = re.compile(
    r"\b(assign (this )?(to )?me|please assign|can i (work|take|pick)|i('d| would) (like|love) to (work|take|try)|"
    r"i('ll| will) (work|take|do|fix|handle)|working on (this|it)|i want to (work|take)|claim(ing)?|"
    r"let me (work|take|try|fix)|i can (work|take|fix|do|handle)|mind if i)\b",
    re.I,
)
MEDIA_RE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)|(https?://\S+\.(?:png|jpe?g|gif|webp|mp4))", re.I)
MAINTAINER_ASSOC = {"OWNER", "MEMBER", "COLLABORATOR"}
STARTER = {"good first issue", "good-first-issue", "documentation", "docs", "beginner", "starter", "easy"}
ADVANCED = {"core", "architecture", "performance", "security", "refactor", "breaking-change", "advanced", "hard"}


def tier_from_labels(labels: list[str]) -> str:
    ls = {l.lower() for l in labels}
    if ls & STARTER:
        return "starter"
    if ls & ADVANCED:
        return "advanced"
    return "intermediate"


def is_bot(user: dict) -> bool:
    return user.get("type") == "Bot" or user.get("login", "").endswith("[bot]")


def media_urls(text: str) -> list[str]:
    return [a or b for a, b in MEDIA_RE.findall(text)]


def build_context(repo: str, number: int, issue: dict, comments: list[dict]) -> dict:
    labels = [l["name"] if isinstance(l, dict) else l for l in issue.get("labels", [])]
    applicants: dict[str, dict] = {}
    skipped = []
    for c in comments:
        user = c.get("user") or {}
        login = user.get("login")
        text = c.get("body") or ""
        if not login or not CLAIM_RE.search(text):
            continue
        if is_bot(user) or c.get("author_association") in MAINTAINER_ASSOC:
            skipped.append(login)
            continue
        entry = applicants.setdefault(login, {"username": login, "comments": [], "media": []})
        entry["comments"].append(text.strip())
        entry["media"] += media_urls(text)
    return {
        "repo": repo,
        "issue": {
            "number": number,
            "title": issue.get("title", ""),
            "body": issue.get("body") or "",
            "labels": labels,
            "tier": tier_from_labels(labels),
            "state": issue.get("state"),
            "author": (issue.get("user") or {}).get("login"),
            "already_assigned": [a["login"] for a in issue.get("assignees", [])],
            "media": media_urls(issue.get("body") or ""),
            "url": issue.get("html_url"),
        },
        "applicants": list(applicants.values()),
        "filtered_out": sorted(set(skipped)),
    }


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--issue", required=True, help="Issue number or owner/repo#number")
    p.add_argument("--repo", help="owner/repo")
    p.add_argument("--out", help="Write JSON here (default stdout)")
    a = p.parse_args()
    repo, n = parse_target(a.repo, a.issue)
    gh = GitHub()
    issue = gh.get(f"/repos/{repo}/issues/{n}")
    if "pull_request" in issue:
        raise SystemExit(f"{repo}#{n} is a pull request, not an issue.")
    comments = gh.paginate(f"/repos/{repo}/issues/{n}/comments")
    ctx = build_context(repo, n, issue, comments)
    save_json(ctx, a.out)
    print(f"Found {len(ctx['applicants'])} applicant(s) for {repo}#{n} (tier: {ctx['issue']['tier']})", file=sys.stderr)


if __name__ == "__main__":
    main()
