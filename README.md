# Agonas

Tools for automating open-source maintainer workflows.

## Parts
| Part | Folder | Status |
|---|---|---|
| **Agonas skill**: an [Agent Skill](https://agentskills.io) that triages GitHub issue applicants and assigns the best contributor (powered by Google Gemma) | [`skill/`](skill/) | Available |

## Quick install (Claude Code)
```bash
claude plugin marketplace add Rehodra/Agonas
claude plugin install agonas@agonas
```

See [`skill/README.md`](skill/README.md) for installation and usage.

## Releases
```bash
python tools/build_release.py   # builds dist/agonas-<version>.zip (unpacks to a single agonas/ folder)
```

## License
MIT, see [LICENSE](LICENSE).
