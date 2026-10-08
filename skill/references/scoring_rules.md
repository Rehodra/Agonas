# Scoring rules

Total 0.0–10.0. Issue tiers (from labels): `starter` (good first issue, docs, beginner),
`advanced` (core, architecture, performance, security), else `intermediate`.

| # | Pillar | Weight | Scored by |
|---|--------|--------|-----------|
| 1 | Comment quality & intent | 30% | Gemma (0–10) |
| 2 | Global open-issue burden (anti-hoarding) | 20% | code |
| 3 | Same-repo monopoly (anti-monopoly) | 20% | code |
| 4 | Technical & domain alignment | 15% | Gemma (0–10) |
| 5 | First-timer boost | 15% | code (adjustment) |

## 1. Comment quality
Specific proposal / code reference / reproduction: 8–10. Polite claim with relevant background: 5–7.
Generic "assign me": 0–2.

## 2. Global burden (open issues assigned across GitHub)
0 → 10, 1–2 → 7, 3–4 → 3, ≥5 → 0 plus `High ghosting risk`.

## 3. Same-repo monopoly (open issues assigned in this repo)
0 → 10, 1 → 6, 2 → 2, ≥3 → 0 and **hard cap: total ≤ 4.0**.

## 4. Technical alignment
Language/framework overlap. Ecosystem adjacency counts (e.g. React/JS applicant, TypeScript issue,
comment explains how it applies → high credit).

## 5. First-timer boost
Applied as an adjustment to the total (pillars 1–4 are weighted 30/20/20/15 and normalised to 0–10 first):
`starter` and lifetime merged PRs ≤ 2 → +2.0; `starter` and merged PRs > 10 → −2.0.

## Final
`total = clamp(weighted(1–4) + first_timer_adjustment, 0, 10)`, then the same-repo hard cap.
Risk: `High` if global burden ≥ 5 or same-repo ≥ 3, `Medium` if global ≥ 3 or same-repo = 2, else `Low`.
