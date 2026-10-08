#!/usr/bin/env python3
"""Stage 2b: score applicants. Gemma judges comment quality + domain fit; code applies the rest of the rubric."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

from common import load_json, save_json

DEFAULT_MODEL = "gemma-4-31b-it"
FALLBACK_MODEL = "gemma-4-26b-a4b-it"
TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
W_COMMENT, W_GLOBAL, W_REPO, W_DOMAIN = 0.30, 0.20, 0.20, 0.15


def global_burden_points(n: int) -> int:
    return 10 if n == 0 else 7 if n <= 2 else 3 if n <= 4 else 0


def repo_monopoly_points(n: int) -> int:
    return 10 if n == 0 else 6 if n == 1 else 2 if n == 2 else 0


def first_timer_adjustment(tier: str, merged_prs: int) -> float:
    if tier == "starter":
        if merged_prs <= 2:
            return 2.0
        if merged_prs > 10:
            return -2.0
    return 0.0


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def score_candidate(tier: str, metrics: dict, comment_quality: float, domain_alignment: float) -> dict:
    g = int(metrics.get("global_open_assigned", 0) or 0)
    r = int(metrics.get("repo_open_assigned", 0) or 0)
    merged = int(metrics.get("lifetime_merged_prs", 0) or 0)
    cq = clamp(float(comment_quality), 0, 10)
    da = clamp(float(domain_alignment), 0, 10)
    gp, rp = global_burden_points(g), repo_monopoly_points(r)
    base = (cq * W_COMMENT + gp * W_GLOBAL + rp * W_REPO + da * W_DOMAIN) / (W_COMMENT + W_GLOBAL + W_REPO + W_DOMAIN)
    adj = first_timer_adjustment(tier, merged)
    total = clamp(base + adj, 0, 10)
    capped = r >= 3 and total > 4.0
    if r >= 3:
        total = min(total, 4.0)
    risk = "High" if g >= 5 or r >= 3 else "Medium" if g >= 3 or r == 2 else "Low"
    flags = []
    if g >= 5:
        flags.append("High ghosting risk")
    if capped:
        flags.append("Same-repo monopoly cap (max 4.0)")
    if adj > 0:
        flags.append("First-timer boost +2.0")
    elif adj < 0:
        flags.append("Experienced contributor on starter issue -2.0")
    return {
        "score": round(total, 1),
        "risk": risk,
        "flags": flags,
        "breakdown": {
            "comment_quality": cq, "global_burden_pts": gp, "repo_monopoly_pts": rp, "domain_alignment": da,
            "first_timer_adjustment": adj, "hard_cap_applied": capped,
        },
        "stats": {"global_open_assigned": g, "repo_open_assigned": r, "lifetime_merged_prs": merged},
    }


def build_prompt(ctx: dict) -> str:
    env = Environment(loader=FileSystemLoader(str(TEMPLATES)), autoescape=False)
    return env.get_template("gemma_prompt.jinja2").render(repo=ctx["repo"], issue=ctx["issue"], applicants=ctx["applicants"])


def parse_json_response(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise
        return json.loads(m.group(0))


def normalize_judgement(data) -> dict:
    """Models sometimes return a bare list or a differently-keyed object; coerce to {"candidates": [...]}."""
    if isinstance(data, list):
        return {"candidates": data}
    if isinstance(data, dict) and "candidates" not in data:
        for v in data.values():
            if isinstance(v, list):
                return {"candidates": v}
    if not isinstance(data, dict) or not isinstance(data.get("candidates"), list):
        raise ValueError("Model output has no candidate list")
    return data


def _generate(client, types, model, prompt, json_mode):
    cfg = types.GenerateContentConfig(temperature=0.2, **({"response_mime_type": "application/json"} if json_mode else {}))
    return client.models.generate_content(model=model, contents=prompt, config=cfg)


def call_gemma(prompt: str, model: str, client=None, fallback: str | None = FALLBACK_MODEL, retries: int = 3) -> dict:
    from google import genai
    from google.genai import types

    client = client or genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    models = [model] + ([fallback] if fallback and fallback != model else [])
    last: Exception | None = None
    for m in models:
        json_mode = True
        for attempt in range(retries):
            try:
                resp = _generate(client, types, m, prompt, json_mode)
                return normalize_judgement(parse_json_response(resp.text or ""))
            except (ValueError, json.JSONDecodeError) as e:  # unparseable output: retry once more, same settings
                last = e
            except Exception as e:  # API error (503 overload, JSON mode unsupported, ...)
                last = e
                if json_mode and "json" in str(e).lower():
                    json_mode = False
                    continue
                time.sleep(min(2 ** attempt * 2, 10))
            print(f"{m}: attempt {attempt + 1} failed ({type(last).__name__}); retrying", file=sys.stderr)
        print(f"{m} unavailable, trying next model" if m != models[-1] else "", file=sys.stderr)
    raise SystemExit(f"Gemma evaluation failed: {last}. Retry later or use --heuristic.")


def heuristic_judgement(ctx: dict) -> dict:
    """Offline fallback: crude keyword judgement. Clearly lower quality than Gemma."""
    issue_text = (ctx["issue"]["title"] + " " + ctx["issue"]["body"] + " " + " ".join(ctx["issue"]["labels"])).lower()
    out = []
    for a in ctx["applicants"]:
        text = " ".join(a["comments"])
        words = len(text.split())
        specific = bool(re.search(r"`|\.py|\.js|\.ts|function|PR|approach|reproduc|stack ?trace|fix", text, re.I))
        cq = 1 if words < 6 else 4 if words < 20 else 6
        cq += 3 if specific and words >= 20 else 0
        langs = [l.lower() for l in (a.get("metrics") or {}).get("languages", [])]
        hits = sum(1 for l in langs if l in issue_text)
        da = min(10, 3 + 3 * hits) if langs else 3
        out.append({"username": a["username"], "comment_quality": min(cq, 10), "domain_alignment": da,
                    "justification": "Heuristic (no LLM): based on comment length/specificity and language keyword overlap."})
    return {"candidates": out}


def evaluate(ctx: dict, judgement: dict, engine: str) -> dict:
    by_user = {c["username"].lower(): c for c in judgement.get("candidates", [])}
    tier = ctx["issue"].get("tier", "intermediate")
    results = []
    for a in ctx["applicants"]:
        j = by_user.get(a["username"].lower(), {"comment_quality": 0, "domain_alignment": 0,
                                                "justification": "Not evaluated by model; scored 0 on subjective pillars."})
        s = score_candidate(tier, a.get("metrics") or {}, j.get("comment_quality", 0), j.get("domain_alignment", 0))
        s.update(username=a["username"], justification=j.get("justification", ""))
        results.append(s)
    results.sort(key=lambda r: (-r["score"], r["stats"]["global_open_assigned"], r["username"]))
    for i, r in enumerate(results, 1):
        r["rank"] = i
    return {"repo": ctx["repo"], "issue": ctx["issue"], "engine": engine, "candidates": results}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", required=True, help="context.json with applicant metrics")
    p.add_argument("--out", help="Write evaluation JSON here (default stdout)")
    p.add_argument("--model", default=os.environ.get("GEMMA_MODEL", DEFAULT_MODEL))
    p.add_argument("--heuristic", action="store_true", help="Skip the LLM; use offline keyword heuristics")
    p.add_argument("--print-prompt", action="store_true")
    a = p.parse_args()
    ctx = load_json(a.data)
    if not ctx.get("applicants"):
        raise SystemExit("No applicants found in context; nothing to evaluate.")
    if a.print_prompt:
        print(build_prompt(ctx))
        return
    if a.heuristic:
        judgement, engine = heuristic_judgement(ctx), "heuristic"
    else:
        if not os.environ.get("GEMINI_API_KEY"):
            raise SystemExit("GEMINI_API_KEY not set. Set it, or pass --heuristic for a lower-quality offline run.")
        judgement, engine = call_gemma(build_prompt(ctx), a.model), a.model
    save_json(evaluate(ctx, judgement, engine), a.out)


if __name__ == "__main__":
    main()
