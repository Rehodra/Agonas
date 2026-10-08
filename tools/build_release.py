#!/usr/bin/env python3
"""Build dist/agonas-<version>.zip with `agonas/` as the single top-level folder.

Only runtime files ship. Secrets (.env), tests, VCS data, caches and dev notes are excluded.
Usage: python tools/build_release.py
"""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "skill"   # the skill folder; everything below is relative to it
INCLUDE = ["SKILL.md", "README.md", "requirements.txt", ".env.example", "scripts", "references", "templates"]
SKIP_PARTS = {"__pycache__", ".pytest_cache", ".git"}
SKIP_SUFFIXES = {".pyc"}


def skill_meta() -> tuple[str, str]:
    text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    fm = re.match(r"---\n(.*?)\n---", text, re.S)
    if not fm:
        raise SystemExit("SKILL.md has no frontmatter")
    name = re.search(r"^name:\s*(\S+)", fm.group(1), re.M)
    version = re.search(r'^\s+version:\s*"?([\w.\-]+)"?', fm.group(1), re.M)
    if not name or not version:
        raise SystemExit("SKILL.md frontmatter needs name and metadata.version")
    plugin = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    if plugin.get("name") != name.group(1) or plugin.get("version") != version.group(1):
        raise SystemExit(f"plugin.json ({plugin.get('name')} {plugin.get('version')}) does not match "
                         f"SKILL.md ({name.group(1)} {version.group(1)}); bump both together.")
    return name.group(1), version.group(1)


def main():
    name, version = skill_meta()
    out = REPO / "dist" / f"{name}-{version}.zip"
    out.parent.mkdir(exist_ok=True)
    files = []
    for item in INCLUDE:
        p = ROOT / item
        if not p.exists():
            raise SystemExit(f"Missing release file: {item}")
        files += [f for f in ([p] if p.is_file() else sorted(p.rglob("*")))
                  if f.is_file() and not (SKIP_PARTS & set(f.parts)) and f.suffix not in SKIP_SUFFIXES]
    license_file = REPO / "LICENSE"
    if not license_file.exists():
        raise SystemExit("Missing release file: LICENSE (repo root)")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(license_file, f"{name}/LICENSE")
        for f in files:
            z.write(f, f"{name}/{f.relative_to(ROOT).as_posix()}")
    print(f"Built {out} ({len(files) + 1} files)")


if __name__ == "__main__":
    main()
