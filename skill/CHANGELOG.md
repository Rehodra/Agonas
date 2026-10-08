# Changelog

## 1.0.1
- Applicant detection no longer depends on keyword matching: every human, non-maintainer commenter is evaluated, with an `explicit_claim` hint. Comments without a claim phrase are flagged for the maintainer. Fixes missed applicants whose wording or typos defeated the keyword list.

## 1.0.0
- Initial release: issue ingestion, candidate telemetry, Gemma-assisted scoring, scorecard (Markdown, Rich, HTML), confirmed assignment with advisory fallback.
- Gemma calls retry with backoff and fall back from `gemma-4-31b-it` to `gemma-4-26b-a4b-it`.
- Plugin manifest (`.claude-plugin/plugin.json`) and marketplace catalog; keys can live in `~/.agonas/.env`.
