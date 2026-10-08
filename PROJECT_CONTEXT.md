# PROJECT_CONTEXT.md: GitAssign — Autonomous GitHub Issue Triage Agent Skill

```markdown
# PROJECT_CONTEXT: GitAssign

## 1. Project Identity & Objective
- **Name:** agonas (`git-assign`)
- **Repository Track:** 
  1. Main Challenge: Open-Source AI Prize Challenge (Public GitHub repo, OSI MIT/Apache 2.0 license, compliant with Agent Skill Open Standard).
  2. Partner Challenge: Google Gemma (Powered by Gemma 4 / Gemma open-weight models via Google GenAI SDK / Gemini API).
- **Core Purpose:** An open-standard Agent Skill that automates GitHub issue triage and contributor candidate matching. It parses "assign me" comments, extracts candidate technical telemetry and workload metrics via GitHub REST API, applies context-aware and anti-monopoly scoring via Google Gemma, renders an interactive HTML artifact / rich terminal scorecard, and enables 1-click maintainer issue assignment.

---

## 2. Directory Architecture (Agent Skill Open Standard Compliance)

Following the standard from `agentskills.io`:

```text
gitassign/
├── SKILL.md                          # Standard Agent Skill specification & orchestrator
├── README.md                         # Public documentation, demo link, Gemma track disclosure
├── LICENSE                           # MIT License
├── pyproject.toml / requirements.txt # Dependencies: google-genai, requests, python-dotenv, rich, jinja2
├── .env.example                      # Template for GEMINI_API_KEY and GITHUB_TOKEN
├── references/
│   ├── scoring_rules.md              # Explicit 5-pillar rubric, issue tiers, fairness rules
│   └── github_api_schema.md          # REST API endpoints, queries, and rate-limit guardrails
├── scripts/
│   ├── fetch_issue_context.py        # Ingests issue details, labels, description, and comment threads
│   ├── fetch_candidate_metrics.py    # Fetches GitHub activity (repos, PR counts, open loads, bio)
│   ├── evaluate_gemma.py             # Calls Google Gemma with structured prompt & strict JSON output
│   ├── render_report.py              # Generates interactive triage-report.html & Rich CLI tables
│   └── assign_winner.py              # Executes GitHub assignment API call or advisory comment
└── templates/
    ├── gemma_prompt.jinja2           # Prompt template enforcing deterministic JSON output
    └── report_template.html          # Clean dark-mode dashboard for candidate comparison

```

---

## 3. Core Engine Workflow

1. **Trigger:** User in IDE or CLI issues: `"Triage applicants for issue <owner>/<repo>#<number>"`.
2. **Context Ingestion (`fetch_issue_context.py`):**
* Calls `GET /repos/{owner}/{repo}/issues/{issue_number}`.
* Extracts title, body, labels, and parses embedded screenshot/media URLs (`re.findall`).
* Calls `GET /repos/{owner}/{repo}/issues/{issue_number}/comments`.
* Filters candidate usernames asserting intent (e.g., "assign me", "working on this", "claim").


3. **Telemetry Aggregation (`fetch_candidate_metrics.py`):**
* Pulls candidate repos via `GET /users/{username}/repos?sort=updated&per_page=10`.
* Checks Local Monopoly Burden via `GET /search/issues?q=repo:{owner}/{repo}+is:issue+is:open+assignee:{username}`.
* Checks Global Hoarding Burden via `GET /search/issues?q=is:issue+is:open+assignee:{username}`.
* Checks Lifetime Merged PRs via `GET /search/issues?q=is:pr+is:merged+author:{username}`.
* Extracts attached comment screenshots/media buffers if present.


4. **Reasoning & Scoring (`evaluate_gemma.py`):**
* Ingests issue context + applicant telemetry into Google Gemma (`gemma-4-26b-a4b-it` or `gemma-4-31b-it`) via `google.genai`.
* Temperature set to `0.2` with enforced `response_mime_type="application/json"`.
* Evaluates based on the 5-Pillar Scoring Rubric.


5. **Visual Artifact & Human-in-the-Loop (`render_report.py`):**
* Prints a formatted, color-coded `rich` table in the terminal.
* Renders a self-contained `triage-report.html` and launches browser preview.
* Awaits maintainer confirmation.


6. **Mutation / Advisory Fallback (`assign_winner.py`):**
* If caller has triage/write access: fires `POST /repos/{owner}/{repo}/issues/{issue_number}/assignees`.
* If caller lacks write permissions: outputs an Advisory Maintainer Markdown snippet for copy-pasting.



---

## 4. The 5-Pillar Scoring Rubric (`references/scoring_rules.md`)

Total Score: 0.0 to 10.0. Issue difficulty tiered into: `starter` (good-first-issue, docs), `intermediate` (enhancement, bugfix), and `advanced` (core, architecture).

1. **Comment Quality & Intent (30% weight):**
* Specific proposal, code reference, or local reproduction: 8–10 pts.
* Polite claim with relevant background: 5–7 pts.
* Generic "assign me" / "please assign" spam: 0–2 pts.


2. **Active Issue Burden / Global Anti-Hoarding (20% weight):**
* 0 global open assigned issues: 10 pts.
* 1–2 open issues: 7 pts.
* 3–4 open issues: 3 pts.
* $\ge 5$ open issues: 0 pts + `High ghosting risk` warning.


3. **Same-Repo Monopoly Penalty / Anti-Monopoly (20% weight):**
* 0 active assigned issues in this repo: 10 pts.
* 1 active issue in this repo: 6 pts.
* 2 active issues in this repo: 2 pts.
* $\ge 3$ active issues: 0 pts + **Hard Cap:** Total score capped at 4.0 max to ensure maintainer bias does not monopolize tickets.


4. **Technical & Domain Alignment (15% weight):**
* Language & framework overlap.
* **Ecosystem Adjacency Rule:** Acknowledge related technologies (e.g., Candidate knows React/JS, issue requires TypeScript $\rightarrow$ award high adjacent credit if comment explains type application).


5. **First-Timer Priority Boost (15% weight):**
* If tier is `starter` and candidate lifetime merged PRs $\le 2$: **+2.0 point bonus**.
* If tier is `starter` and candidate lifetime merged PRs $> 10$: **-2.0 point penalty** (protect starter issues for learners).



---

## 5. Required Frontmatter Specification (`SKILL.md`)

```yaml
---
name: git-assign
description: Autonomous GitHub issue triage and contributor assignment assistant powered by Google Gemma. Evaluates candidate comments, profiles, workload burdens, and local repository monopolies to recommend and assign the best contributor. Use when the user asks to triage an issue, assign contributors, evaluate applicants on GitHub, or manage issue assignments.
compatibility: Requires Python 3.10+, network access, GITHUB_TOKEN, and GEMINI_API_KEY.
license: MIT
metadata:
  version: "1.0.0"
  model: "google/gemma-4"
  standard: "agentskills.io/v1"
---

```

---

## 6. Technical Stack & Environment Variables

* **Language:** Python 3.10+
* **Primary Libraries:**
* `google-genai` (Official SDK for Gemma endpoints via Google AI Studio)
* `requests` (GitHub REST API communication)
* `python-dotenv` (Local secret management)
* `rich` (Terminal dashboards and colored tables)
* `jinja2` (HTML artifact and prompt formatting)


* **Environment Variables:**
* `GEMINI_API_KEY`: Google AI Studio API key for Gemma access.
* `GITHUB_TOKEN`: GitHub Personal Access Token (classic with `repo` scope, or fine-grained Issues R/W).



---

## 7. Immediate Coding Implementation Checklist for Claude

When starting this codebase:

1. Initialize `pyproject.toml` / `requirements.txt` and `.env.example`.
2. Create `SKILL.md` strictly following the frontmatter spec above.
3. Build `scripts/fetch_issue_context.py` to parse issue body and applicants via GitHub REST API.
4. Build `scripts/fetch_candidate_metrics.py` to query GitHub `/search/issues` endpoints for local and global counts.
5. Build `scripts/evaluate_gemma.py` with the structured JSON output schema and scoring rubric using `google.genai`.
6. Implement `scripts/render_report.py` to produce a sleek dark-mode `triage-report.html` and CLI summary.
7. Implement `scripts/assign_winner.py` with graceful fallback from direct assignment to advisory output.

```

```