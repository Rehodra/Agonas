/**
 * popup/popup.js
 * Main popup controller — orchestrates:
 *   1. Auth check (GitHub token + Gemini key via chrome.storage.local)
 *   2. Issue context detection from current tab
 *   3. 1.0.1 Candidate ingestion (all non-maintainer commenters, explicit_claim flag)
 *   4. Metric aggregation with limited concurrency & rate-limit resilience
 *   5. Gemma scoring (with model fallback & heuristic fallback)
 *   6. XSS-safe DOM card rendering (textContent strictly for all untrusted text)
 *   7. Assign safety (permission check, confirm step, response verification) & Decline dismiss
 */

import { GitHubClient, loadGitHubToken, runConcurrent } from "../lib/github_api.js";
import { scoreCandidate, heuristicJudge } from "../lib/scorer.js";
import { callGemma, loadGeminiKey } from "../lib/gemma_client.js";
import {
  CLAIM_RE, MAINTAINER_ASSOC, isBot, mediaUrls,
  tierFromLabels, parseGitHubIssueUrl, initials, scoreColor,
} from "../lib/utils.js";

/* ═══════════════════ DOM refs ═══════════════════ */
const $ = id => document.getElementById(id);

const authDot           = $("authDot");
const userAvatar        = $("userAvatar");
const issueBanner       = $("issueBanner");
const issueBadge        = $("issueBadge");
const issueLink         = $("issueLink");
const setupPrompt       = $("setupPrompt");
const openSettingsBtn   = $("openSettingsBtn");
const settingsBtn       = $("settingsBtn");
const notIssuePrompt    = $("notIssuePrompt");
const loadingState      = $("loadingState");
const loadingLabel      = $("loadingLabel");
const errorState        = $("errorState");
const errorMsg          = $("errorMsg");
const retryBtn          = $("retryBtn");
const noCandidatesState = $("noCandidatesState");
const noCandidatesDesc  = $("noCandidatesDesc");
const candidatesContainer = $("candidatesContainer");
const candidatesList    = $("candidatesList");
const footer            = $("footer");
const refreshBtn        = $("refreshBtn");
const toast             = $("toast");

/* ═══════════════════ State ═══════════════════ */
let currentIssue = null; // { owner, repo, number, full }
let githubClient = null;
let geminiKey    = null;
let evaluation   = null;

/* ═══════════════════ Entry point ═══════════════════ */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  settingsBtn.addEventListener("click",     () => chrome.runtime.openOptionsPage());
  openSettingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  retryBtn.addEventListener("click",        () => runTriage());
  refreshBtn.addEventListener("click",      () => runTriage());

  const [token, gKey] = await Promise.all([loadGitHubToken(), loadGeminiKey()]);

  if (!token) {
    showSetup();
    return;
  }

  geminiKey    = gKey;
  githubClient = new GitHubClient(token);

  // Validate token + show user avatar
  try {
    const user = await githubClient.getCurrentUser();
    authDot.classList.add("ok");
    authDot.title = `Authenticated as @${user.login}`;
    if (user.avatar_url) {
      userAvatar.src = user.avatar_url;
      userAvatar.style.display = "block";
      userAvatar.alt = `@${user.login}`;
    }
  } catch (_) {
    authDot.classList.add("fail");
    authDot.title = "Token invalid or expired";
    showSetup();
    return;
  }

  // Get current tab URL
  const url = await getCurrentTabUrl();
  const parsed = url ? parseGitHubIssueUrl(url) : null;

  if (!parsed) {
    show(notIssuePrompt);
    return;
  }

  currentIssue = parsed;
  await runTriage();
}

/* ═══════════════════ Triage orchestration ═══════════════════ */
async function runTriage() {
  if (!currentIssue) return;

  hideAll();
  show(loadingState);
  refreshBtn.classList.add("spinning");

  try {
    // Stage 1: fetch issue + applicants (1.0.1 behavior: evaluate all human non-maintainers)
    setLoadingLabel("Fetching issue comments…");
    const issueCtx = await fetchIssueContext(currentIssue.full, currentIssue.number);

    // Show banner
    const tierLabel = issueCtx.issue.tier;
    const count     = issueCtx.applicants.length;
    issueBadge.textContent = `Issue #${currentIssue.number} · ${tierLabel} · ${count} candidate${count !== 1 ? "s" : ""}`;
    issueLink.href = issueCtx.issue.url ?? `https://github.com/${currentIssue.full}/issues/${currentIssue.number}`;
    show(issueBanner);

    if (!issueCtx.applicants.length) {
      hideAll();
      show(issueBanner);
      noCandidatesDesc.textContent = `No comments found on ${currentIssue.full}#${currentIssue.number}.`;
      show(noCandidatesState);
      show(footer);
      return;
    }

    // Stage 2: fetch candidate metrics with limited concurrency & rate-limit backoff
    setLoadingLabel("Profiling candidates…");
    const applicantsWithMetrics = await fetchCandidateMetrics(issueCtx, currentIssue.full);
    issueCtx.applicants = applicantsWithMetrics;

    // Stage 3: score (Gemma with fallback or heuristic)
    setLoadingLabel(geminiKey ? "Scoring with Gemma 4…" : "Scoring (offline heuristic)…");
    evaluation = await scoreCandidates(issueCtx);

    // Stage 4: render (XSS safe)
    hideAll();
    show(issueBanner);
    renderCandidates(evaluation);
    show(candidatesContainer);
    show(footer);

  } catch (err) {
    hideAll();
    show(issueBanner);
    errorMsg.textContent = err.message ?? String(err);
    show(errorState);
    show(footer);
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

/* ═══════════════════ Stage 1: Issue context (Port 1.0.1) ═══════════════════ */
async function fetchIssueContext(fullRepo, number) {
  const [issue, comments] = await Promise.all([
    githubClient.get(`/repos/${fullRepo}/issues/${number}`),
    githubClient.paginate(`/repos/${fullRepo}/issues/${number}/comments`),
  ]);

  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue.`);

  const labels = (issue.labels ?? []).map(l => typeof l === "string" ? l : l.name);
  const applicantsMap = {};

  // 1.0.1 behavior: Every human, non-maintainer commenter is evaluated.
  // Typos and alternative wording ("I can doo it") are preserved; Gemma judges intent.
  for (const c of comments) {
    const user = c.user ?? {};
    const login = user.login;
    const text = c.body ?? "";
    if (!login || !text.trim()) continue;
    if (isBot(user) || MAINTAINER_ASSOC.has(c.author_association)) continue;

    const entry = applicantsMap[login] ??= {
      username: login,
      comments: [],
      media: [],
      explicit_claim: false,
    };
    entry.comments.push(text.trim());
    entry.media.push(...mediaUrls(text));
    entry.explicit_claim = entry.explicit_claim || CLAIM_RE.test(text);
  }

  return {
    repo: fullRepo,
    issue: {
      number,
      title:          issue.title ?? "",
      body:           issue.body  ?? "",
      labels,
      tier:           tierFromLabels(labels),
      state:          issue.state,
      author:         issue.user?.login,
      alreadyAssigned: (issue.assignees ?? []).map(a => a.login),
      media:          mediaUrls(issue.body ?? ""),
      url:            issue.html_url,
    },
    applicants: Object.values(applicantsMap),
  };
}

/* ═══════════════════ Stage 2: Candidate metrics (Limited Concurrency) ═══════════════════ */
async function fetchCandidateMetrics(ctx, fullRepo) {
  // Use runConcurrent to limit search concurrency to 2 parallel tasks
  const tasks = ctx.applicants.map(a => async () => {
    const u = a.username;
    const [repos, globalCount, repoCount, mergedCount] = await Promise.allSettled([
      githubClient.get(`/users/${u}/repos`, { sort: "updated", per_page: "10" }),
      githubClient.searchCount(`is:issue is:open assignee:${u}`),
      githubClient.searchCount(`repo:${fullRepo} is:issue is:open assignee:${u}`),
      githubClient.searchCount(`is:pr is:merged author:${u}`),
    ]);

    const repoList = repos.status === "fulfilled" && Array.isArray(repos.value) ? repos.value : [];
    const languages = [...new Set(repoList.map(r => r.language).filter(Boolean))].slice(0, 6);
    const topRepos  = repoList.slice(0, 3).map(r => ({
      name: r.name,
      language: r.language,
      stargazers_count: r.stargazers_count,
    }));

    return {
      ...a,
      metrics: {
        globalOpenAssigned: globalCount.status === "fulfilled" ? globalCount.value : 0,
        repoOpenAssigned:   repoCount.status   === "fulfilled" ? repoCount.value   : 0,
        lifetimeMergedPrs:  mergedCount.status === "fulfilled" ? mergedCount.value : 0,
        languages,
        topRepos,
      },
    };
  });

  return runConcurrent(tasks, 2);
}

/* ═══════════════════ Stage 3: Scoring ═══════════════════ */
async function scoreCandidates(ctx) {
  let judgements = {};

  if (geminiKey) {
    try {
      const result = await callGemma(ctx, geminiKey);
      for (const c of (result.candidates ?? [])) {
        if (c?.username) judgements[c.username.toLowerCase()] = c;
      }
    } catch (err) {
      console.warn("[Agonas] Gemma scoring unavailable, using heuristic fallback:", err.message);
    }
  }

  const tier = ctx.issue.tier;
  const candidates = ctx.applicants.map(a => {
    const j = judgements[a.username.toLowerCase()] ?? heuristicJudge(ctx.issue, a);

    const scored = scoreCandidate({
      tier,
      metrics:         a.metrics ?? {},
      commentQuality:  j.comment_quality   ?? j.commentQuality  ?? 0,
      domainAlignment: j.domain_alignment  ?? j.domainAlignment ?? 0,
    });

    const flags = [...(scored.flags ?? [])];
    if (a.explicit_claim === false) {
      flags.push("No explicit claim phrase (check intent)");
    }

    return {
      ...scored,
      flags,
      username:      a.username,
      justification: j.justification ?? "",
    };
  });

  // Sort: score desc, then global open asc, then username
  candidates.sort((a, b) =>
    b.score - a.score ||
    a.stats.globalOpenAssigned - b.stats.globalOpenAssigned ||
    a.username.localeCompare(b.username)
  );
  candidates.forEach((c, i) => { c.rank = i + 1; });

  return { repo: ctx.repo, issue: ctx.issue, candidates };
}

/* ═══════════════════ Stage 4: Rendering (Strictly XSS-Safe) ═══════════════════ */
function renderCandidates(ev) {
  candidatesList.textContent = ""; // clear safely
  ev.candidates.forEach((c, i) => {
    candidatesList.appendChild(buildCard(c, i === 0, ev.repo, ev.issue.number));
  });
}

function buildCard(c, isTop, fullRepo, issueNumber) {
  const card = document.createElement("div");
  card.className = `candidate-card${isTop ? " top-candidate" : ""}`;
  card.id = `card-${c.username}`;

  const color = scoreColor(c.score);

  // 1. Header (Avatar, Username, Rank, Score)
  const cardHead = document.createElement("div");
  cardHead.className = "card-head";

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initials(c.username);

  // Async load GitHub avatar image safely
  const img = new Image();
  img.src = `https://github.com/${encodeURIComponent(c.username)}.png?size=64`;
  img.alt = `@${c.username}`;
  img.onload = () => {
    avatar.textContent = "";
    avatar.appendChild(img);
  };

  const cardIdentity = document.createElement("div");
  cardIdentity.className = "card-identity";

  const usernameWrapper = document.createElement("div");
  usernameWrapper.className = "card-username";

  const userLink = document.createElement("a");
  userLink.href = `https://github.com/${encodeURIComponent(c.username)}`;
  userLink.target = "_blank";
  userLink.rel = "noopener noreferrer";
  userLink.textContent = `@${c.username}`; // XSS-safe

  const rankBadge = document.createElement("span");
  rankBadge.className = "rank-badge";
  rankBadge.textContent = `#${c.rank}`;

  usernameWrapper.appendChild(userLink);
  usernameWrapper.appendChild(rankBadge);
  cardIdentity.appendChild(usernameWrapper);

  const cardScore = document.createElement("div");
  cardScore.className = "card-score";
  cardScore.style.color = color;
  cardScore.textContent = `${c.score}`;

  const denom = document.createElement("span");
  denom.className = "score-denom";
  denom.textContent = "/10";
  cardScore.appendChild(denom);

  cardHead.appendChild(avatar);
  cardHead.appendChild(cardIdentity);
  cardHead.appendChild(cardScore);
  card.appendChild(cardHead);

  // 2. Score bar
  const scoreBar = document.createElement("div");
  scoreBar.className = "score-bar";
  const scoreBarFill = document.createElement("div");
  scoreBarFill.className = "score-bar-fill";
  scoreBarFill.style.width = `${Math.min(c.score * 10, 100)}%`;
  scoreBarFill.style.background = color;
  scoreBar.appendChild(scoreBarFill);
  card.appendChild(scoreBar);

  // 3. Badges & Flags
  const cardBadges = document.createElement("div");
  cardBadges.className = "card-badges";

  const riskBadge = document.createElement("span");
  riskBadge.className = `risk-badge risk-${c.risk}`;
  riskBadge.textContent = `${c.risk} Risk`;
  cardBadges.appendChild(riskBadge);

  for (const flag of (c.flags || [])) {
    const flagChip = document.createElement("span");
    const isGood = flag.toLowerCase().includes("boost") || flag.toLowerCase().includes("first");
    flagChip.className = `flag-chip${isGood ? " good" : ""}`;
    flagChip.textContent = flag; // XSS-safe
    cardBadges.appendChild(flagChip);
  }
  card.appendChild(cardBadges);

  // 4. Justification (Gemma or heuristic rationale)
  if (c.justification) {
    const justEl = document.createElement("div");
    justEl.className = "card-justification";
    justEl.textContent = c.justification; // XSS-safe
    card.appendChild(justEl);
  }

  // 5. Candidate stats
  const statsEl = document.createElement("div");
  statsEl.className = "card-stats";
  statsEl.textContent = `Global open: ${c.stats.globalOpenAssigned} · Repo open: ${c.stats.repoOpenAssigned} · Merged PRs: ${c.stats.lifetimeMergedPrs}`;
  card.appendChild(statsEl);

  // 6. Recommendation banner for top candidate
  if (isTop) {
    const ctaBanner = document.createElement("div");
    ctaBanner.className = "cta-banner";

    const ctaIcon = document.createElement("span");
    ctaIcon.className = "cta-icon";
    ctaIcon.textContent = "✓";

    const ctaText = document.createElement("span");
    ctaText.textContent = `User having score ${c.score} is recommended for this issue`;

    ctaBanner.appendChild(ctaIcon);
    ctaBanner.appendChild(ctaText);
    card.appendChild(ctaBanner);
  }

  // 7. Actions Container (Assign with Confirm step, Decline purely dismisses)
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "card-actions";

  const btnAssign = document.createElement("button");
  btnAssign.className = "btn-assign";
  btnAssign.textContent = "✓ Assign";

  const btnDecline = document.createElement("button");
  btnDecline.className = "btn-decline";
  btnDecline.textContent = "Decline";

  actionsDiv.appendChild(btnAssign);
  actionsDiv.appendChild(btnDecline);
  card.appendChild(actionsDiv);

  // Confirmation state container (hidden initially)
  const confirmDiv = document.createElement("div");
  confirmDiv.className = "card-confirm-actions";
  confirmDiv.style.display = "none";
  confirmDiv.style.gap = "8px";
  confirmDiv.style.alignItems = "center";
  confirmDiv.style.marginTop = "8px";

  const confirmMsg = document.createElement("div");
  confirmMsg.style.fontSize = "12px";
  confirmMsg.style.color = "var(--mute)";
  confirmMsg.style.marginBottom = "6px";
  confirmMsg.textContent = `Assign @${c.username} to #${issueNumber}?`;

  const btnConfirmYes = document.createElement("button");
  btnConfirmYes.className = "btn-assign";
  btnConfirmYes.style.background = "var(--btn-green)";
  btnConfirmYes.textContent = "Confirm Assign";

  const btnConfirmCancel = document.createElement("button");
  btnConfirmCancel.className = "btn-decline";
  btnConfirmCancel.textContent = "Cancel";

  const confirmBtnGroup = document.createElement("div");
  confirmBtnGroup.style.display = "flex";
  confirmBtnGroup.style.gap = "8px";
  confirmBtnGroup.appendChild(btnConfirmYes);
  confirmBtnGroup.appendChild(btnConfirmCancel);

  confirmDiv.appendChild(confirmMsg);
  confirmDiv.appendChild(confirmBtnGroup);
  card.appendChild(confirmDiv);

  // ── Action Handlers ──

  // Assign button clicked -> check write perms and show confirmation step
  btnAssign.addEventListener("click", async () => {
    btnAssign.disabled = true;
    btnAssign.textContent = "Checking permissions…";

    const canWrite = await githubClient.canWrite(fullRepo);
    btnAssign.disabled = false;
    btnAssign.textContent = "✓ Assign";

    if (!canWrite) {
      showToast(`⚠ Your token lacks write access to assign users on ${fullRepo}`, "error");
      return;
    }

    // Switch to confirmation step
    actionsDiv.style.display = "none";
    confirmDiv.style.display = "block";
  });

  // Cancel confirmation
  btnConfirmCancel.addEventListener("click", () => {
    confirmDiv.style.display = "none";
    actionsDiv.style.display = "flex";
  });

  // Execute assignment after confirmation
  btnConfirmYes.addEventListener("click", async () => {
    btnConfirmYes.disabled = true;
    btnConfirmCancel.disabled = true;
    btnConfirmYes.textContent = "Assigning…";

    try {
      await githubClient.assignUser(fullRepo, issueNumber, c.username);
      confirmDiv.style.display = "none";
      actionsDiv.style.display = "flex";

      btnAssign.disabled = true;
      btnAssign.style.background = "var(--ok)";
      btnAssign.textContent = "✓ Assigned!";
      btnDecline.style.display = "none";

      showToast(`✓ @${c.username} successfully assigned to #${issueNumber}!`, "success");

      // Dim other cards
      document.querySelectorAll(".candidate-card").forEach(other => {
        if (other !== card) other.style.opacity = "0.4";
      });
    } catch (err) {
      btnConfirmYes.disabled = false;
      btnConfirmCancel.disabled = false;
      btnConfirmYes.textContent = "Confirm Assign";
      showToast(`✗ ${err.message}`, "error");
    }
  });

  // Decline: purely hides card, does NOT post anything to GitHub
  btnDecline.addEventListener("click", () => {
    card.style.transition = "opacity 0.25s, transform 0.25s";
    card.style.opacity = "0";
    card.style.transform = "translateX(20px)";
    setTimeout(() => {
      card.remove();
      showToast(`Dismissed @${c.username}`);
    }, 250);
  });

  return card;
}

/* ═══════════════════ Helpers ═══════════════════ */
function show(el)  { if (el) el.style.display = ""; }
function hide(el)  { if (el) el.style.display = "none"; }

function hideAll() {
  [setupPrompt, notIssuePrompt, loadingState, errorState,
   noCandidatesState, candidatesContainer, footer].forEach(hide);
}

function showSetup() {
  hideAll();
  show(setupPrompt);
}

function setLoadingLabel(text) {
  loadingLabel.textContent = text;
}

let toastTimer;
function showToast(msg, type = "info") {
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3500);
}

async function getCurrentTabUrl() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0]?.url ?? null);
    });
  });
}
