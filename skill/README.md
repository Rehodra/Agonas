# GitAssign

An open-standard [Agent Skill](https://agentskills.io) that triages GitHub issue applicants and recommends
(then, with maintainer approval, assigns) the best contributor. Anti-hoarding and anti-monopoly rules are
deterministic code; **Google Gemma** judges the two subjective pillars (comment quality, domain fit).

**Gemma track disclosure:** the reasoning step uses Gemma open-weight models through the Google GenAI SDK
(default `gemma-4-31b-it`, falling back to `gemma-4-26b-a4b-it`; override with `GEMMA_MODEL`).

## How it works
1. `fetch_issue_context.py`: reads the issue and finds applicants in the comments (maintainers and bots are filtered out).
2. `fetch_candidate_metrics.py`: languages, merged PRs, open assignments (global and in this repo).
3. `evaluate_gemma.py`: Gemma scores comment quality and domain fit; code applies the burden, monopoly and first-timer rules ([rubric](references/scoring_rules.md)).
4. `render_report.py`: Markdown scorecard for chat, Rich table, and `triage-report.html`.
5. `assign_winner.py`: assigns only with `--confirm`; without write access it prints an advisory snippet.

## Requirements
- Python 3.10+
- `GITHUB_TOKEN`: classic PAT with `repo` scope (or fine-grained with Issues read/write). Assigning needs triage/write access to the target repo.
- `GEMINI_API_KEY`: Google AI Studio key.

## Installation

### Claude Code (plugin marketplace, recommended)
```bash
claude plugin marketplace add Rehodra/Agonas
claude plugin install agonas@agonas
```
Update later with `claude plugin update agonas@agonas`. Put your keys in `~/.agonas/.env`
(they are loaded from there, and survive plugin updates):
```bash
mkdir -p ~/.agonas && printf 'GITHUB_TOKEN=...
GEMINI_API_KEY=...
' > ~/.agonas/.env
pip install -r <plugin directory>/requirements.txt    # one time; `claude plugin details agonas` shows the location
```

### Claude Code (manual copy)
Copy the `skill/` folder from this repo (renaming it to `agonas`), or unzip the release zip, into one of:
- `~/.claude/skills/agonas/` (all projects), or
- `<your-project>/.claude/skills/agonas/` (one project)

Then:
```bash
cd ~/.claude/skills/agonas
pip install -r requirements.txt
cp .env.example .env     # add your GITHUB_TOKEN and GEMINI_API_KEY (or use ~/.agonas/.env)
```
Start a new session and ask: *"Assign issue #4 to the relevant person"* or run `/agonas`.

### Claude.ai / Claude desktop
Download `agonas-<version>.zip` from the releases page and upload it under
**Settings -> Capabilities -> Skills** (requires a plan with skills and code execution enabled).
Hosted sandboxes may restrict outbound network access, and this skill calls `api.github.com` and the
Gemini API, so Claude Code is the most reliable environment.

### Claude API
Upload the folder through the Skills API and reference its `skill_id` in a code-execution container.

## Manual usage
```bash
python scripts/fetch_issue_context.py --repo owner/repo --issue 4 --out context.json
python scripts/fetch_candidate_metrics.py --context context.json --out context.json
python scripts/evaluate_gemma.py --data context.json --out evaluation.json
python scripts/render_report.py --data evaluation.json --markdown   # prints the absolute path of triage-report.html
python scripts/assign_winner.py --data evaluation.json --user alex --confirm
```

## Notes
- Scoring is reproducible: the same Gemma judgements always yield the same scores.
- The report is written to the current directory by default; use `--html <path>` to change it.
- Never commit `.env`. Each user supplies their own keys.

## Development
```bash
python -m pytest                 # unit tests (GitHub and Gemma are mocked)
python ../tools/build_release.py   # run from the repo root as `python tools/build_release.py`; builds dist/agonas-<version>.zip
```

## License
MIT
