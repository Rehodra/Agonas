#!/usr/bin/env python3
"""Stage 3a: render the scorecard (Markdown for chat, Rich table for terminal, HTML file)."""
from __future__ import annotations

import argparse
import webbrowser
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from rich.console import Console
from rich.table import Table

from common import load_json

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def _cell(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


def rationale(c: dict) -> str:
    bits = [c["justification"]] if c.get("justification") else []
    bits += c.get("flags", [])
    return "; ".join(bits)


def markdown_table(ev: dict) -> str:
    rows = ["| Candidate | Score | Rationale | Risk |", "|---|---|---|---|"]
    for c in ev["candidates"]:
        rows.append(f"| {_cell(c['username'])} | {c['score']}/10 | {_cell(rationale(c))} | {c['risk']} |")
    return "\n".join(rows)


def render_html(ev: dict) -> str:
    env = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=select_autoescape(["html"]))
    return env.get_template("report_template.html").render(**ev)


def print_rich(ev: dict, console: Console | None = None):
    console = console or Console()
    t = Table(title=f"{ev['repo']}#{ev['issue']['number']} ({ev['issue']['tier']}) via {ev['engine']}")
    for col in ("#", "Candidate", "Score", "Risk", "Open (global/repo)", "Merged PRs", "Rationale"):
        t.add_column(col)
    color = {"Low": "green", "Medium": "yellow", "High": "red"}
    for c in ev["candidates"]:
        s = c["stats"]
        t.add_row(str(c["rank"]), c["username"], f"{c['score']}", f"[{color[c['risk']]}]{c['risk']}[/]",
                  f"{s['global_open_assigned']}/{s['repo_open_assigned']}", str(s["lifetime_merged_prs"]), rationale(c))
    console.print(t)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", required=True, help="evaluation.json")
    p.add_argument("--html", default="triage-report.html", help="HTML output path")
    p.add_argument("--markdown", action="store_true", help="Print the Markdown scorecard (for chat) instead of the Rich table")
    p.add_argument("--open", action="store_true", help="Open the HTML report in a browser")
    a = p.parse_args()
    ev = load_json(a.data)
    Path(a.html).write_text(render_html(ev), encoding="utf-8")
    if a.markdown:
        print(markdown_table(ev))
    else:
        print_rich(ev)
    print(f"\nHTML report: {Path(a.html).resolve()}")
    if ev["candidates"]:
        print(f"Top match: @{ev['candidates'][0]['username']} - awaiting maintainer approval.")
    if a.open:
        webbrowser.open(Path(a.html).resolve().as_uri())


if __name__ == "__main__":
    main()
