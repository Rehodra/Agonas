/**
 * lib/scorer.js
 * 5-pillar scoring engine — exact port of evaluate_gemma.py scoring logic.
 *
 * Pillars:
 *   1. Comment Quality & Intent        (30%)
 *   2. Global Anti-Hoarding Burden     (20%)
 *   3. Same-Repo Monopoly Penalty      (20%)
 *   4. Technical & Domain Alignment    (15%)
 *   5. First-Timer Priority Boost      (15%)
 */

import { clamp } from "./utils.js";

const W_COMMENT = 0.30;
const W_GLOBAL  = 0.20;
const W_REPO    = 0.20;
const W_DOMAIN  = 0.15;

/** @param {number} n global open assigned issues */
function globalBurdenPoints(n) {
  if (n === 0) return 10;
  if (n <= 2)  return 7;
  if (n <= 4)  return 3;
  return 0;
}

/** @param {number} n same-repo open assigned issues */
function repoMonopolyPoints(n) {
  if (n === 0) return 10;
  if (n === 1) return 6;
  if (n === 2) return 2;
  return 0;
}

/**
 * @param {"starter"|"intermediate"|"advanced"} tier
 * @param {number} mergedPrs
 * @returns {number}
 */
function firstTimerAdjustment(tier, mergedPrs) {
  if (tier !== "starter") return 0;
  if (mergedPrs <= 2)  return  2.0;   // boost: first-timer on starter
  if (mergedPrs > 10)  return -2.0;   // penalty: experienced dev taking easy issue
  return 0;
}

/**
 * Score a single candidate according to the 5-pillar rubric.
 *
 * @param {object} params
 * @param {"starter"|"intermediate"|"advanced"} params.tier
 * @param {object} params.metrics - fetched GitHub metrics for this candidate
 * @param {number} params.commentQuality - 0–10, from Gemma (or heuristic)
 * @param {number} params.domainAlignment - 0–10, from Gemma (or heuristic)
 * @returns {object} Full scoring result
 */
export function scoreCandidate({ tier, metrics, commentQuality, domainAlignment }) {
  const g      = parseInt(metrics?.globalOpenAssigned ?? 0, 10);
  const r      = parseInt(metrics?.repoOpenAssigned   ?? 0, 10);
  const merged = parseInt(metrics?.lifetimeMergedPrs  ?? 0, 10);

  const cq = clamp(commentQuality,  0, 10);
  const da = clamp(domainAlignment, 0, 10);
  const gp = globalBurdenPoints(g);
  const rp = repoMonopolyPoints(r);

  const weightedSum  = cq * W_COMMENT + gp * W_GLOBAL + rp * W_REPO + da * W_DOMAIN;
  const totalWeight  = W_COMMENT + W_GLOBAL + W_REPO + W_DOMAIN;
  const base         = weightedSum / totalWeight;
  const adj          = firstTimerAdjustment(tier, merged);
  let total          = clamp(base + adj, 0, 10);

  const capApplied   = r >= 3 && total > 4.0;
  if (r >= 3) total  = Math.min(total, 4.0);

  const risk = g >= 5 || r >= 3 ? "High"
             : g >= 3 || r === 2 ? "Medium"
             : "Low";

  const flags = [];
  if (g >= 5)   flags.push("High ghosting risk");
  if (r >= 3 && capApplied) flags.push("Same-repo monopoly cap (max 4.0)");
  if (adj > 0)  flags.push("First-timer boost +2.0");
  if (adj < 0)  flags.push("Experienced contributor on starter issue -2.0");

  return {
    score: Math.round(total * 10) / 10,
    risk,
    flags,
    breakdown: {
      commentQuality:         cq,
      globalBurdenPts:        gp,
      repoMonopolyPts:        rp,
      domainAlignment:        da,
      firstTimerAdjustment:   adj,
      hardCapApplied:         capApplied,
    },
    stats: {
      globalOpenAssigned: g,
      repoOpenAssigned:   r,
      lifetimeMergedPrs:  merged,
    },
  };
}

/**
 * Offline heuristic fallback (mirrors evaluate_gemma.py heuristic_judgement).
 * Used when no Gemini API key is available.
 *
 * @param {object} issueCtx - { title, body, labels }
 * @param {object} applicant - { username, comments[], metrics, explicit_claim }
 * @returns {{ commentQuality: number, domainAlignment: number, justification: string }}
 */
export function heuristicJudge(issueCtx, applicant) {
  const issueText = `${issueCtx.title} ${issueCtx.body} ${(issueCtx.labels ?? []).join(" ")}`.toLowerCase();
  const comments = Array.isArray(applicant.comments) ? applicant.comments : [applicant.comments ?? ""];
  const commentText = comments.join(" ");
  const words = commentText.split(/\s+/).filter(Boolean).length;
  const specific = /`|\.py|\.js|\.ts|function|PR\b|approach|reproduc|stack\s?trace|fix\b/i.test(commentText);

  let cq;
  if (applicant.explicit_claim === false && !specific) {
    // 1.0.1 behavior: evaluate every commenter, but zero out comments showing no intent
    cq = 0;
  } else {
    cq = words < 6 ? 1 : words < 20 ? 4 : 6;
    if (specific && words >= 20) cq += 3;
    cq = Math.min(cq, 10);
  }

  const langs = (applicant.metrics?.languages ?? []).map(l => l.toLowerCase());
  const hits  = langs.filter(l => issueText.includes(l)).length;
  const da    = langs.length ? Math.min(10, 3 + 3 * hits) : 3;

  return {
    commentQuality: cq,
    domainAlignment: da,
    justification: cq === 0
      ? "Heuristic (no LLM): comment shows no claim intent or technical proposal."
      : "Heuristic (no LLM): based on comment length/specificity and language keyword overlap.",
  };
}
