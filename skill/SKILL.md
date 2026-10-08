---
name: agonas
description: Autonomous GitHub issue triage and contributor assignment assistant powered by Google Gemma. Evaluates candidate comments, profiles, workload burdens, and local repository monopolies to recommend and assign the best contributor. Use when the user asks to triage an issue, assign contributors, evaluate applicants on GitHub, or manage issue assignments.
compatibility: Requires Python 3.10+, network access, GITHUB_TOKEN, and GEMINI_API_KEY.
license: MIT
metadata:
  version: "1.0.1"
  model: "google/gemma-4"
  standard: "agentskills.io/v1"
---

# GitAssign

Triage applicants for a GitHub issue and (after maintainer approval) assign the best one.
Run all commands from this skill's directory (the folder containing this SKILL.md; when installed as a plugin, resolve it from the skill's base directory). Scores are computed deterministically from
`references/scoring_rules.md`; Gemma only judges the two subjective pillars.

## Setup (first run only)
From the skill directory: `pip install -r requirements.txt`, then make sure `GITHUB_TOKEN` and
`GEMINI_API_KEY` are set (environment variables, a `.env` file in the skill directory, or `~/.agonas/.env`, which survives plugin updates; see `.env.example`).
Never ask the user to paste keys into chat.

## Workflow

Trigger examples: "Assign issue #4 to the relevant person", "Triage applicants for owner/repo#4".

1. **Fetch issue + applicants**
   `python scripts/fetch_issue_context.py --repo owner/repo --issue 4 --out context.json`
   (`--issue owner/repo#4` also works.) Extracts description, labels, tier, and applicants
   from the comment thread (maintainers and bots filtered out).
2. **Fetch candidate telemetry**
   `python scripts/fetch_candidate_metrics.py --context context.json --out context.json`
   (or `--users alex,sam --repo owner/repo` standalone). Adds languages, top repos, lifetime
   merged PRs, global and same-repo open assignments.
3. **Score**
   `python scripts/evaluate_gemma.py --data context.json --out evaluation.json`
   Use `--heuristic` only if no `GEMINI_API_KEY` is available (clearly labelled, lower quality).
4. **Present** the scorecard in chat
   `python scripts/render_report.py --data evaluation.json --markdown`
   Paste the Markdown table to the user. Also writes `triage-report.html`
   (`--html-only`/`--open` available).
5. **Wait for the maintainer to approve.** Never assign without an explicit yes.
6. **Assign**
   `python scripts/assign_winner.py --data evaluation.json --user <login> --confirm`
   Without write access it prints an advisory Markdown snippet instead of mutating anything.

## Rules
- Never skip step 5. `assign_winner.py` refuses to run without `--confirm`.
- Report API errors/rate limits faithfully; see `references/github_api_schema.md`.
- Never print `GITHUB_TOKEN` or `GEMINI_API_KEY`.
