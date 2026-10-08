/**
 * lib/scorer.js
 * 5-pillar scoring engine — mirrors evaluate_gemma.py scoring logic
 * with verifiable-history trust policy and unclamped ranking.
 *
 * Pillars:
 *   1. Comment Quality & Intent        (30%)
 *   2. Global Anti-Hoarding Burden     (20%)
 *   3. Same-Repo Monopoly Penalty      (20%)
 *   4. Technical & Domain Alignment    (15%)
 *   5. First-Timer Priority Boost      (15%)
 */

import { clamp } from "./utils.js";

export const POLICY = {
  NEW_ACCOUNT_DAYS: 30,             // younger than this => "new account"
  NO_HISTORY_DOMAIN_CAP: 5,         // max domain_alignment when there is no technical evidence
  FIRST_TIMER_MIN_ACCOUNT_DAYS: 30, // first-timer boost requires at least this account age
};

const W_COMMENT = 0.30;
const W_GLOBAL  = 0.20;
const W_REPO    = 0.20;
const W_DOMAIN  = 0.15;

/** @param {number} n global open assigned issues */
export function globalBurdenPoints(n) {
  if (n === 0) return 10;
  if (n <= 2)  return 7;
  if (n <= 4)  return 3;
  return 0;
}

/** @param {number} n same-repo open assigned issues */
export function repoMonopolyPoints(n) {
  if (n === 0) return 10;
  if (n === 1) return 6;
  if (n === 2) return 2;
  return 0;
}

/**
 * Compute verifiable history points for tie-breaking:
 * +1 if account age >= NEW_ACCOUNT_DAYS
 * +1 if any public repo
 * +1 if lifetime merged PRs > 0
 * +1 if bio present
 *
 * @param {object} metrics
 * @returns {number} 0-4
 */
export function computeHistoryPoints(metrics) {
  const rawAge = metrics?.accountAgeDays ?? metrics?.account_age_days;
  const age = (rawAge !== undefined && rawAge !== null && !isNaN(Number(rawAge))) ? Number(rawAge) : null;
  const publicRepos = parseInt(metrics?.publicRepos ?? metrics?.public_repos ?? (metrics?.topRepos?.length ?? 0), 10);
  const merged = parseInt(metrics?.lifetimeMergedPrs ?? metrics?.lifetime_merged_prs ?? 0, 10);
  const bio = metrics?.bio;

  let points = 0;
  if (age !== null && age >= POLICY.NEW_ACCOUNT_DAYS) points += 1;
  if (publicRepos > 0) points += 1;
  if (merged > 0) points += 1;
  if (typeof bio === "string" && bio.trim().length > 0) points += 1;
  return points;
}

/**
 * Score a single candidate according to the 5-pillar rubric.
 *
 * @param {object} params
 * @param {"starter"|"intermediate"|"advanced"} params.tier
 * @param {object} params.metrics - fetched GitHub metrics for this candidate
 * @param {number} params.commentQuality - 0–10, from Gemma (or heuristic)
 * @param {number} params.domainAlignment - 0–10, from Gemma (or heuristic)
 * @returns {object} Full scoring result including rawScore and score
 */
export function scoreCandidate({ tier, metrics, commentQuality, domainAlignment }) {
  const g      = parseInt(metrics?.globalOpenAssigned ?? metrics?.global_open_assigned ?? 0, 10);
  const r      = parseInt(metrics?.repoOpenAssigned   ?? metrics?.repo_open_assigned   ?? 0, 10);
  const merged = parseInt(metrics?.lifetimeMergedPrs  ?? metrics?.lifetime_merged_prs  ?? 0, 10);

  const rawAge = metrics?.accountAgeDays ?? metrics?.account_age_days;
  const accountAgeDays = (rawAge !== undefined && rawAge !== null && !isNaN(Number(rawAge)))
    ? Number(rawAge)
    : null;
  const isAgeUnknown = accountAgeDays === null;

  const publicRepos = parseInt(metrics?.publicRepos ?? metrics?.public_repos ?? (metrics?.topRepos?.length ?? 0), 10);
  const languages   = Array.isArray(metrics?.languages) ? metrics.languages : [];
  const hasPublicHistory = (publicRepos > 0) || (languages.length > 0) || (merged > 0);

  const flags = [];

  const cq = clamp(commentQuality, 0, 10);
  let da = clamp(domainAlignment, 0, 10);

  // Rule C.1: Domain alignment cap
  if (!hasPublicHistory) {
    da = Math.min(da, POLICY.NO_HISTORY_DOMAIN_CAP);
    flags.push("No public history to verify skills");
  }

  // Account age flags
  if (isAgeUnknown) {
    flags.push("Account age unknown");
  } else if (accountAgeDays < POLICY.NEW_ACCOUNT_DAYS) {
    flags.push("New account (under 30 days)");
  }

  // Rule C.2: First-timer boost
  let adj = 0.0;
  if (tier === "starter") {
    if (merged <= 2) {
      if (accountAgeDays !== null && accountAgeDays >= POLICY.FIRST_TIMER_MIN_ACCOUNT_DAYS) {
        adj = 2.0;
        flags.push("First-timer boost +2.0");
      } else if (accountAgeDays !== null && accountAgeDays < POLICY.FIRST_TIMER_MIN_ACCOUNT_DAYS) {
        flags.push("First-timer boost withheld (new account)");
      }
    } else if (merged > 10) {
      adj = -2.0;
      flags.push("Experienced contributor on starter issue -2.0");
    }
  }

  const gp = globalBurdenPoints(g);
  const rp = repoMonopolyPoints(r);

  const weightedSum = cq * W_COMMENT + gp * W_GLOBAL + rp * W_REPO + da * W_DOMAIN;
  const totalWeight = W_COMMENT + W_GLOBAL + W_REPO + W_DOMAIN; // 0.85
  const base        = weightedSum / totalWeight;

  let raw = base + adj;
  const capApplied = (r >= 3 && raw > 4.0);
  if (r >= 3) {
    raw = Math.min(raw, 4.0);
  }

  if (g >= 5) {
    flags.push("High ghosting risk");
  }
  if (r >= 3 && capApplied) {
    flags.push("Same-repo monopoly cap (max 4.0)");
  }

  // Rule C.4: Risk calculation
  let risk = g >= 5 || r >= 3 ? "High"
           : g >= 3 || r === 2 ? "Medium"
           : "Low";

  if (risk === "Low") {
    const isNewAccount = accountAgeDays !== null && accountAgeDays < POLICY.NEW_ACCOUNT_DAYS;
    if (isNewAccount || !hasPublicHistory) {
      risk = "Medium";
    }
  }

  const historyPoints = computeHistoryPoints(metrics);

  const rawScore = Math.round(raw * 100) / 100;
  const clamped  = clamp(raw, 0, 10);
  const score    = Math.round(clamped * 10) / 10;

  return {
    score,
    rawScore,
    risk,
    flags,
    historyPoints,
    breakdown: {
      commentQuality:       cq,
      globalBurdenPts:      gp,
      repoMonopolyPts:      rp,
      domainAlignment:      da,
      firstTimerAdjustment: adj,
      hardCapApplied:       capApplied,
    },
    stats: {
      globalOpenAssigned: g,
      repoOpenAssigned:   r,
      lifetimeMergedPrs:  merged,
      accountAgeDays,
      publicRepos,
    },
  };
}

/**
 * Sort candidates by rawScore descending with deterministic tie-breakers:
 * 1. historyPoints (higher is better)
 * 2. globalOpenAssigned (fewer is better)
 * 3. username (case-insensitive alphabetical)
 *
 * @param {Array<object>} candidates
 * @returns {Array<object>} the sorted candidates array
 */
export function sortCandidates(candidates) {
  return candidates.sort((a, b) => {
    // 1. rawScore descending
    if (Math.abs(b.rawScore - a.rawScore) > 0.0001) {
      return b.rawScore - a.rawScore;
    }
    // Tie-breaker 1: more verifiable history first (higher is better)
    const aHist = a.historyPoints ?? computeHistoryPoints(a.stats || a.metrics);
    const bHist = b.historyPoints ?? computeHistoryPoints(b.stats || b.metrics);
    if (bHist !== aHist) {
      return bHist - aHist;
    }
    // Tie-breaker 2: fewer global open assigned issues
    const aGlobal = a.stats?.globalOpenAssigned ?? a.metrics?.global_open_assigned ?? 0;
    const bGlobal = b.stats?.globalOpenAssigned ?? b.metrics?.global_open_assigned ?? 0;
    if (aGlobal !== bGlobal) {
      return aGlobal - bGlobal;
    }
    // Tie-breaker 3: username case-insensitive
    const aName = (a.username || "").toLowerCase();
    const bName = (b.username || "").toLowerCase();
    return aName.localeCompare(bName);
  });
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
