# GitAssign

An open-standard [Agent Skill](https://agentskills.io) that triages GitHub issue applicants and recommends
(then, with maintainer approval, assigns) the best contributor. Anti-hoarding and anti-monopoly rules are
deterministic code; **Google Gemma** judges the two subjective pillars (comment quality, domain fit).

**Gemma track disclosure:** the reasoning step uses Gemma open-weight models through the Google GenAI SDK
(default `gemma-4-31b-it`, override with `GEMMA_MODEL`).

## Setup
```bash
pip install -r requirements.txt
cp .env.example .env   # add GITHUB_TOKEN and GEMINI_API_KEY
```

## Usage (what the agent runs; see SKILL.md)
```bash
python scripts/fetch_issue_context.py --repo owner/repo --issue 4 --out context.json
python scripts/fetch_candidate_metrics.py --context context.json --out context.json
python scripts/evaluate_gemma.py --data context.json --out evaluation.json
python scripts/render_report.py --data evaluation.json --markdown
python scripts/assign_winner.py --data evaluation.json --user alex --confirm
```
`assign_winner.py` refuses to run without `--confirm`, and prints an advisory snippet if the token lacks write access.
See `references/scoring_rules.md` for the rubric.

## Tests
```bash
python -m pytest
```

MIT licensed.
