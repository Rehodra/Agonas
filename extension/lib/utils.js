/**
 * lib/utils.js
 * Shared utilities mirroring scripts/common.py and fetch_issue_context.py logic.
 */

export const CLAIM_RE = /\b(assign (this )?(to )?me|please assign|can i (work|take|pick)|i('d| would) (like|love) to (work|take|try)|i('ll| will) (work|take|do|fix|handle)|working on (this|it)|i want to (work|take)|claim(ing)?|let me (work|take|try|fix)|i can (work|take|fix|do|handle)|mind if i)\b/i;

export const MEDIA_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4))/gi;

export const MAINTAINER_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const STARTER_LABELS = new Set(["good first issue", "good-first-issue", "documentation", "docs", "beginner", "starter", "easy"]);
const ADVANCED_LABELS = new Set(["core", "architecture", "performance", "security", "refactor", "breaking-change", "advanced", "hard"]);

/**
 * @param {string[]} labels
 * @returns {"starter"|"intermediate"|"advanced"}
 */
export function tierFromLabels(labels) {
  const ls = new Set(labels.map(l => l.toLowerCase()));
  if ([...ls].some(l => STARTER_LABELS.has(l))) return "starter";
  if ([...ls].some(l => ADVANCED_LABELS.has(l))) return "advanced";
  return "intermediate";
}

/**
 * @param {{ login?: string, type?: string }} user
 * @returns {boolean}
 */
export function isBot(user) {
  return user?.type === "Bot" || (user?.login ?? "").endsWith("[bot]");
}

/**
 * Extract media URLs from markdown text.
 * @param {string} text
 * @returns {string[]}
 */
export function mediaUrls(text) {
  const urls = [];
  let m;
  const re = new RegExp(MEDIA_RE.source, MEDIA_RE.flags);
  while ((m = re.exec(text)) !== null) {
    urls.push(m[1] || m[2]);
  }
  return urls;
}

/**
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Parse owner/repo and issue number from a GitHub issue URL.
 * @param {string} url
 * @returns {{ owner: string, repo: string, number: number } | null}
 */
export function parseGitHubIssueUrl(url) {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10), full: `${m[1]}/${m[2]}` };
}

/**
 * Get initials for avatar fallback.
 * @param {string} username
 * @returns {string}
 */
export function initials(username) {
  return username.slice(0, 2).toUpperCase();
}

/**
 * Color for a score value.
 * @param {number} score
 * @returns {string} CSS var name
 */
export function scoreColor(score) {
  if (score >= 7) return "var(--acc)";
  if (score >= 5) return "var(--warn)";
  return "var(--bad)";
}
