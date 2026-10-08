"""Shared helpers: GitHub HTTP client, repo/issue parsing, JSON IO."""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv

    # Skill-local .env first, then a stable per-user file that survives plugin updates.
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
    load_dotenv(Path.home() / ".agonas" / ".env")
except ImportError:  # dotenv is optional at runtime
    pass

API = "https://api.github.com"


class GitHubError(RuntimeError):
    pass


def parse_target(repo: str | None, issue: str) -> tuple[str, int]:
    """Accept (--repo owner/repo, --issue 4) or --issue owner/repo#4."""
    m = re.fullmatch(r"([\w.-]+/[\w.-]+)#(\d+)", issue.strip())
    if m:
        return m.group(1), int(m.group(2))
    if not re.fullmatch(r"#?\d+", issue.strip()):
        raise SystemExit(f"Invalid --issue '{issue}'. Use 4 or owner/repo#4.")
    repo = repo or os.environ.get("GITHUB_REPOSITORY")
    if not repo or not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise SystemExit("Repository required: pass --repo owner/repo (or set GITHUB_REPOSITORY).")
    return repo, int(issue.strip().lstrip("#"))


class GitHub:
    def __init__(self, token: str | None = None, session: requests.Session | None = None):
        self.token = token or os.environ.get("GITHUB_TOKEN")
        self.s = session or requests.Session()
        self.s.headers.update({"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
        if self.token:
            self.s.headers["Authorization"] = f"Bearer {self.token}"

    def request(self, method: str, path: str, **kw):
        url = path if path.startswith("http") else API + path
        for attempt in (0, 1):
            r = self.s.request(method, url, timeout=30, **kw)
            limited = r.status_code == 429 or (
                r.status_code == 403 and (r.headers.get("X-RateLimit-Remaining") == "0" or "retry-after" in r.headers)
            )
            if limited and attempt == 0:
                wait = r.headers.get("Retry-After")
                if wait is None and r.headers.get("X-RateLimit-Reset"):
                    wait = max(0, int(r.headers["X-RateLimit-Reset"]) - int(time.time())) + 1
                wait = min(int(wait or 5), 60)
                print(f"Rate limited; sleeping {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            if not r.ok:
                try:
                    msg = r.json().get("message", r.text)
                except ValueError:
                    msg = r.text
                raise GitHubError(f"{method} {url} -> {r.status_code}: {msg}")
            return r
        raise GitHubError("unreachable")

    def get(self, path: str, **params):
        return self.request("GET", path, params=params or None).json()

    def paginate(self, path: str, max_pages: int = 5, **params):
        params.setdefault("per_page", 100)
        out, url = [], API + path
        for _ in range(max_pages):
            r = self.request("GET", url, params=params)
            out.extend(r.json())
            url = r.links.get("next", {}).get("url")
            params = None
            if not url:
                break
        return out

    def search_count(self, q: str) -> int:
        return int(self.get("/search/issues", q=q, per_page=1).get("total_count", 0))


def load_json(path: str | Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_json(obj, path: str | Path | None):
    text = json.dumps(obj, indent=2, ensure_ascii=False)
    if path:
        Path(path).write_text(text, encoding="utf-8")
    else:
        print(text)
