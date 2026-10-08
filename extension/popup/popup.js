/**
 * popup/popup.js
 * Main popup controller — fast, progressive triage:
 *   1. Auth check (GitHub token + Gemini key via chrome.storage.local)
 *   2. Instant preliminary render with deterministic scoring + heuristic judge
 *   3. Background Gemma evaluation with 45s budget, 24h SHA-256 caching & fallback
 *   4. Candidate metrics with concurrency limit of 4, lifetime in-memory cache, and rate-limit resilience
 *   5. Real-time progress UI ("Reading comments", "Checking 3 applicants (2/3)", "Asking Gemma")
 *   6. User-cancellable in-flight requests (both GitHub and Gemma)
 *   7. Non-blocking assign flow with preliminary confirmation disclaimer
 *   8. Unclamped rawScore ranking & verifiable-history tie-breaking
 *   9. XSS-safe DOM rendering (strictly textContent)
 */

import { GitHubClient, loadGitHubToken, runConcurrent } from "../lib/github_api.js";
import { scoreCandidate, sortCandidates, heuristicJudge } from "../lib/scorer.js";
import { callGemma, loadGeminiKey } from "../lib/gemma_client.js";
import {
  CLAIM_RE, MAINTAINER_ASSOC, isBot, mediaUrls,
  tierFromLabels, parseGitHubIssueUrl, initials, scoreColor,
} from "../lib/utils.js";

/* ═══════════════════ DOM refs ═══════════════════ */
const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const $ = id => (isBrowser ? document.getElementById(id) : null);

const authDot            = $("authDot");
const userAvatar         = $("userAvatar");
const popoutBtn          = $("popoutBtn");
const tabSwitcherBanner  = $("tabSwitcherBanner");
const tabSwitcherText    = $("tabSwitcherText");
const triageTabBtn       = $("triageTabBtn");
const issueBanner        = $("issueBanner");
const issueBadge         = $("issueBadge");
const issueLink          = $("issueLink");
const setupPrompt        = $("setupPrompt");
const openSettingsBtn    = $("openSettingsBtn");
const settingsBtn        = $("settingsBtn");
const notIssuePrompt     = $("notIssuePrompt");
const loadingState       = $("loadingState");
const loadingLabel       = $("loadingLabel");
const cancelLoadingBtn   = $("cancelLoadingBtn");
const errorState         = $("errorState");
const errorMsg           = $("errorMsg");
const retryBtn           = $("retryBtn");
const noCandidatesState  = $("noCandidatesState");
const noCandidatesDesc   = $("noCandidatesDesc");
const gemmaProgressBar   = $("gemmaProgressBar");
const gemmaProgressLabel = $("gemmaProgressLabel");
const cancelGemmaBtn     = $("cancelGemmaBtn");
const candidatesContainer= $("candidatesContainer");
const candidatesList     = $("candidatesList");
const footer             = $("footer");
const footerEngine       = $("footerEngine");
const rerunGemmaBtn      = $("rerunGemmaBtn");
const refreshBtn         = $("refreshBtn");
const toast              = $("toast");

/* ═══════════════════ In-Memory Cache (Lifetime of Popup) ═══════════════════ */
// Prevents redundant Search API calls (30 req/min limit) when re-rendering
const inMemoryCandidateMetrics = new Map();

/* ═══════════════════ State ═══════════════════ */
let currentIssue           = null; // { owner, repo, number, full }
let githubClient           = null;
let geminiKey              = null;
let evaluation             = null;
let currentAbortController = null;
let gemmaAbortController   = null;

/* ═══════════════════ Storage Caching Helpers ═══════════════════ */

export async function getCachedEvaluation(fullRepo, number) {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve(null);
    const key = `agonas_eval_${fullRepo}_${Number(number)}`;
    chrome.storage.local.get([key], res => {
      resolve(res?.[key] ?? null);
    });
  });
}

export async function saveCachedEvaluation(fullRepo, number, evalData) {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve();
    const num = Number(number);
    const key = `agonas_eval_${fullRepo}_${num}`;
    const toStore = {
      ...evalData,
      repo: fullRepo,
      issueNumber: num,
      timestamp: Date.now(),
    };
    chrome.storage.local.set({
      [key]: toStore,
      agonas_last_key: key,
      agonas_last_evaluation: toStore,
      agonas_last_issue: {
        full: fullRepo,
        owner: fullRepo.split("/")[0],
        repo: fullRepo.split("/")[1],
        number: num,
      },
    }, () => {
      updateRecentIssues(fullRepo, num, toStore.issue?.title).then(resolve);
    });
  });
}

export async function getLastCachedEvaluation() {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve(null);
    chrome.storage.local.get(["agonas_last_evaluation", "agonas_last_key"], res => {
      if (res?.agonas_last_evaluation) {
        return resolve(res.agonas_last_evaluation);
      }
      const lastKey = res?.agonas_last_key;
      if (!lastKey) return resolve(null);
      chrome.storage.local.get([lastKey], evalRes => {
        resolve(evalRes?.[lastKey] ?? null);
      });
    });
  });
}

export async function updateCachedActions(fullRepo, number, updates) {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve();
    const num = Number(number);
    const key = `agonas_eval_${fullRepo}_${num}`;
    chrome.storage.local.get([key, "agonas_last_evaluation"], res => {
      const data = res?.[key] || res?.agonas_last_evaluation;
      if (!data) return resolve();
      const updated = { ...data, ...updates, timestamp: Date.now() };
      const toSet = { [key]: updated };
      if (
        res?.agonas_last_evaluation?.repo === fullRepo &&
        (Number(res?.agonas_last_evaluation?.issueNumber) === num ||
         Number(res?.agonas_last_evaluation?.issue?.number) === num)
      ) {
        toSet.agonas_last_evaluation = updated;
      }
      chrome.storage.local.set(toSet, resolve);
    });
  });
}

export async function updateRecentIssues(fullRepo, number, title = "") {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve();
    chrome.storage.local.get(["agonas_recent_issues"], res => {
      const recent = Array.isArray(res?.agonas_recent_issues) ? res.agonas_recent_issues : [];
      const num = Number(number);
      const filtered = recent.filter(r => !(r.repo === fullRepo && Number(r.number) === num));
      filtered.unshift({
        repo: fullRepo,
        number: num,
        title: title || `#${num}`,
        timestamp: Date.now(),
      });
      chrome.storage.local.set({ agonas_recent_issues: filtered.slice(0, 10) }, resolve);
    });
  });
}

export async function getActiveIssueIntent() {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve(null);
    chrome.storage.local.get(["agonas_active_issue"], res => {
      resolve(res?.agonas_active_issue ?? null);
    });
  });
}

export async function clearActiveIssueIntent() {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome?.storage?.local) return resolve();
    chrome.storage.local.remove(["agonas_active_issue"], resolve);
  });
}

export function hasPreliminaryCandidates(ev) {
  return Array.isArray(ev?.candidates) && ev.candidates.some(c => c.isPreliminary);
}

/* ═══════════════════ Entry point ═══════════════════ */
if (isBrowser) {
  document.addEventListener("DOMContentLoaded", init);
}

async function init() {
  settingsBtn?.addEventListener("click",      () => chrome.runtime?.openOptionsPage?.());
  openSettingsBtn?.addEventListener("click",  () => chrome.runtime?.openOptionsPage?.());
  retryBtn?.addEventListener("click",         () => runTriage(true));
  refreshBtn?.addEventListener("click",       () => runTriage(true, false));
  rerunGemmaBtn?.addEventListener("click",    () => runTriage(true, true)); // bypass Gemma cache
  cancelLoadingBtn?.addEventListener("click", () => cancelTriage());
  cancelGemmaBtn?.addEventListener("click",   () => cancelGemmaOnly());

  if (popoutBtn) {
    popoutBtn.addEventListener("click", () => openDetachedWindow());
  }

  // Handle detached window styling
  if (typeof window !== "undefined" && window.location?.search?.includes("detached=1")) {
    document.body?.classList.add("detached");
    if (popoutBtn) popoutBtn.style.display = "none";
  }

  // Live-sync state updates across tabs or windows
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener(handleStorageChange);
  }

  // Enhance issueLink: if clicked while viewing another tab, focus or open that tab
  issueLink?.addEventListener("click", handleIssueLinkClick);

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
    authDot?.classList.add("ok");
    if (authDot) authDot.title = `Authenticated as @${user.login}`;
    if (user.avatar_url && userAvatar) {
      userAvatar.src = user.avatar_url;
      userAvatar.style.display = "block";
      userAvatar.alt = `@${user.login}`;
    }
  } catch (_) {
    authDot?.classList.add("fail");
    if (authDot) authDot.title = "Token invalid or expired";
    showSetup();
    return;
  }

  // Check active issue intent from in-page ⚡ Triage button click
  const activeIntent = await getActiveIssueIntent();

  // Get current tab URL and previous saved evaluation
  const url = await getCurrentTabUrl();
  const parsed = url ? parseGitHubIssueUrl(url) : null;
  const lastCached = await getLastCachedEvaluation();

  if (parsed) {
    // Current tab is a GitHub issue page:
    // 1. If user explicitly clicked the ⚡ Triage button on this issue:
    if (activeIntent && activeIntent.full === parsed.full && Number(activeIntent.number) === Number(parsed.number)) {
      currentIssue = parsed;
      await clearActiveIssueIntent();
      hide(tabSwitcherBanner);
      await runTriage(true);
      return;
    }

    // 2. Check if we already have a saved result for this issue
    const cached = await getCachedEvaluation(parsed.full, parsed.number);
    if (cached) {
      currentIssue = parsed;
      hide(tabSwitcherBanner);
      displayEvaluation(cached, false);

      // If cached evaluation is still preliminary, resume Gemma in the background
      if (hasPreliminaryCandidates(cached) && geminiKey) {
        resumeGemmaEvaluation(cached, parsed);
      }
      return;
    }

    // 3. Current tab is an issue, but NOT yet triaged:
    // If user has a previously triaged issue, do NOT blow it away unprompted!
    if (lastCached && lastCached.repo && (lastCached.issueNumber || lastCached.issue?.number)) {
      currentIssue = {
        full:   lastCached.repo,
        owner:  lastCached.repo.split("/")[0],
        repo:   lastCached.repo.split("/")[1],
        number: Number(lastCached.issueNumber || lastCached.issue?.number),
      };
      displayEvaluation(lastCached, true);
      showTabSwitcherBanner(parsed);

      if (hasPreliminaryCandidates(lastCached) && geminiKey) {
        resumeGemmaEvaluation(lastCached, currentIssue);
      }
      return;
    }

    // 4. No previous triage: automatically triage the current tab
    currentIssue = parsed;
    hide(tabSwitcherBanner);
    await runTriage(false);

  } else {
    // Current tab is NOT an issue (e.g. PR, user profile, repo page, external site):
    hide(tabSwitcherBanner);
    if (lastCached) {
      currentIssue = {
        full:   lastCached.repo,
        owner:  lastCached.repo.split("/")[0],
        repo:   lastCached.repo.split("/")[1],
        number: Number(lastCached.issueNumber || lastCached.issue?.number),
      };
      displayEvaluation(lastCached, true);

      if (hasPreliminaryCandidates(lastCached) && geminiKey) {
        resumeGemmaEvaluation(lastCached, currentIssue);
      }
    } else {
      show(notIssuePrompt);
    }
  }
}

/* ═══════════════════ Cross-Tab & Detached Window Helpers ═══════════════════ */
function showTabSwitcherBanner(tabIssue) {
  if (!tabSwitcherBanner || !tabSwitcherText || !triageTabBtn) return;
  tabSwitcherText.textContent = `Current tab: ${tabIssue.full}#${tabIssue.number}`;
  triageTabBtn.onclick = async () => {
    currentIssue = tabIssue;
    hide(tabSwitcherBanner);
    await runTriage(false);
  };
  show(tabSwitcherBanner);
}

function handleIssueLinkClick(e) {
  e.preventDefault();
  const targetUrl = issueLink?.href;
  if (!targetUrl) return;

  if (typeof chrome !== "undefined" && chrome.tabs?.query && chrome.tabs?.update) {
    chrome.tabs.query({}, tabs => {
      const cleanTarget = targetUrl.split("#")[0].split("?")[0];
      const match = tabs.find(t => t.url && t.url.split("#")[0].split("?")[0] === cleanTarget);
      if (match && match.id) {
        chrome.tabs.update(match.id, { active: true });
        if (match.windowId && chrome.windows?.update) {
          chrome.windows.update(match.windowId, { focused: true });
        }
      } else {
        chrome.tabs.create({ url: targetUrl });
      }
    });
  } else {
    window.open(targetUrl, "_blank");
  }
}

function openDetachedWindow() {
  const url = chrome.runtime?.getURL ? chrome.runtime.getURL("popup/popup.html?detached=1") : "popup.html?detached=1";
  if (chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "OPEN_DETACHED_WINDOW" }, res => {
      if (chrome.runtime.lastError || !res?.ok) {
        if (chrome.windows?.create) {
          chrome.windows.create({ url, type: "popup", width: 440, height: 640 });
        } else {
          window.open(url, "agonas_detached", "width=440,height=640");
        }
      }
    });
  } else if (chrome.windows?.create) {
    chrome.windows.create({ url, type: "popup", width: 440, height: 640 });
  } else {
    window.open(url, "agonas_detached", "width=440,height=640");
  }
}

function handleStorageChange(changes, area) {
  if (area !== "local") return;
  if (changes.agonas_last_evaluation?.newValue) {
    const updated = changes.agonas_last_evaluation.newValue;
    const curNum = Number(currentIssue?.number);
    const curRepo = currentIssue?.full;
    if (
      curRepo &&
      updated.repo === curRepo &&
      (Number(updated.issueNumber) === curNum || Number(updated.issue?.number) === curNum)
    ) {
      if (hasPreliminaryCandidates(evaluation) && !hasPreliminaryCandidates(updated)) {
        displayEvaluation(updated, false);
      }
    }
  }
}

/* ═══════════════════ Background Gemma Resumption ═══════════════════ */
async function resumeGemmaEvaluation(cachedEv, issueInfo) {
  if (!geminiKey) return;
  if (!cachedEv || !cachedEv.applicants || !cachedEv.applicants.length) return;

  if (gemmaAbortController) gemmaAbortController.abort();
  gemmaAbortController = new AbortController();
  const { signal } = gemmaAbortController;

  show(gemmaProgressBar);
  if (gemmaProgressLabel) gemmaProgressLabel.textContent = "Asking Gemma…";

  const tier = cachedEv.issue?.tier || "intermediate";
  const issueCtx = {
    repo: cachedEv.repo,
    issue: cachedEv.issue,
    applicants: cachedEv.applicants,
  };

  try {
    const gemmaResult = await callGemma(issueCtx, geminiKey, {
      signal,
      bypassCache: false,
    });

    if (signal.aborted) return;

    const judgements = {};
    for (const c of (gemmaResult.candidates ?? [])) {
      if (c?.username) judgements[c.username.toLowerCase()] = c;
    }

    const upgradedCandidates = cachedEv.applicants.map(a => {
      const j = judgements[a.username.toLowerCase()] ?? heuristicJudge(issueCtx.issue, a);
      const scored = scoreCandidate({
        tier,
        metrics:         a.metrics ?? {},
        commentQuality:  j.comment_quality  ?? j.commentQuality  ?? 0,
        domainAlignment: j.domain_alignment ?? j.domainAlignment ?? 0,
      });

      const flags = [...(scored.flags ?? [])];
      if (a.explicit_claim === false) {
        flags.push("No explicit claim phrase (check intent)");
      }
      if (a.metrics?.rateLimited) {
        flags.push("Incomplete metrics (rate limited)");
      }

      return {
        ...scored,
        flags,
        username:      a.username,
        justification: j.justification ?? "",
        isPreliminary: false,
      };
    });

    sortCandidates(upgradedCandidates);
    upgradedCandidates.forEach((c, i) => { c.rank = i + 1; });

    evaluation = {
      ...cachedEv,
      candidates: upgradedCandidates,
      engine: gemmaResult.model,
    };

    hide(gemmaProgressBar);
    const isFromOther = currentIssue?.full !== cachedEv.repo || Number(currentIssue?.number) !== Number(cachedEv.issueNumber || cachedEv.issue?.number);
    displayEvaluation(evaluation, isFromOther);
    await saveCachedEvaluation(cachedEv.repo, cachedEv.issueNumber || cachedEv.issue?.number, evaluation);
    showToast(`✓ Scores updated via ${gemmaResult.model}`, "success");

  } catch (err) {
    if (signal.aborted) return;
    hide(gemmaProgressBar);
    console.warn("[Agonas] Background Gemma completion failed, preserving heuristic:", err.message);

    evaluation = {
      ...cachedEv,
      engine: "Heuristic (offline)",
      candidates: (cachedEv.candidates || []).map(c => ({
        ...c,
        isPreliminary: false,
        isHeuristicOnly: true,
      })),
    };

    const isFromOther = currentIssue?.full !== cachedEv.repo || Number(currentIssue?.number) !== Number(cachedEv.issueNumber || cachedEv.issue?.number);
    displayEvaluation(evaluation, isFromOther);
    await saveCachedEvaluation(cachedEv.repo, cachedEv.issueNumber || cachedEv.issue?.number, evaluation);
  } finally {
    gemmaAbortController = null;
  }
}

/* ═══════════════════ Display Evaluation ═══════════════════ */
function displayEvaluation(ev, isFromOtherTab = false) {
  evaluation = ev;

  const count = (ev.candidates || []).length;
  const tierLabel = ev.issue?.tier || "intermediate";
  const num = ev.issueNumber || ev.issue?.number || currentIssue?.number;
  const tabNotice = isFromOtherTab ? " (from previous tab)" : "";

  issueBadge.textContent = `${ev.repo}#${num} · ${tierLabel} · ${count} candidate${count !== 1 ? "s" : ""}${tabNotice}`;
  issueLink.href = ev.issue?.url ?? `https://github.com/${ev.repo}/issues/${num}`;
  issueLink.title = isFromOtherTab ? "Switch to this issue on GitHub" : "Open issue on GitHub";

  hideAll();
  show(issueBanner);

  if (!count) {
    noCandidatesDesc.textContent = `No comments found on ${ev.repo}#${num}.`;
    show(noCandidatesState);
    show(footer);
    return;
  }

  renderCandidates(ev);
  show(candidatesContainer);

  updateFooter(ev.engine);
  show(footer);
}

/* ═══════════════════ Progressive Triage Orchestration ═══════════════════ */
async function runTriage(forceRefresh = false, bypassGemmaCache = false) {
  if (!currentIssue) return;

  // Check stored evaluation unless forced
  if (!forceRefresh) {
    const cached = await getCachedEvaluation(currentIssue.full, currentIssue.number);
    if (cached) {
      displayEvaluation(cached, false);
      return;
    }
  }

  // Cancel any existing in-flight task
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  hideAll();
  show(loadingState);
  refreshBtn.classList.add("spinning");

  try {
    /* ── Step 1: Reading comments (Fast) ── */
    setLoadingLabel("Reading comments…");
    const issueCtx = await fetchIssueContext(currentIssue.full, currentIssue.number, signal);
    if (signal.aborted) return;

    const count = issueCtx.applicants.length;
    const tierLabel = issueCtx.issue.tier;
    issueBadge.textContent = `Issue #${currentIssue.number} · ${tierLabel} · ${count} candidate${count !== 1 ? "s" : ""}`;
    issueLink.href = issueCtx.issue.url ?? `https://github.com/${currentIssue.full}/issues/${currentIssue.number}`;
    show(issueBanner);

    if (!count) {
      hideAll();
      show(issueBanner);
      noCandidatesDesc.textContent = `No comments found on ${currentIssue.full}#${currentIssue.number}.`;
      show(noCandidatesState);
      show(footer);
      await saveCachedEvaluation(currentIssue.full, currentIssue.number, {
        repo: currentIssue.full,
        issueNumber: currentIssue.number,
        issue: issueCtx.issue,
        candidates: [],
        engine: "n/a",
      });
      return;
    }

    /* ── Step 2: Candidate profiling (Concurrency: 4) ── */
    setLoadingLabel(`Checking ${count} applicant${count !== 1 ? "s" : ""} (0/${count})…`);
    const applicantsWithMetrics = await fetchCandidateMetrics(issueCtx, currentIssue.full, signal, (done, total) => {
      setLoadingLabel(`Checking ${total} applicant${total !== 1 ? "s" : ""} (${done}/${total})…`);
    });
    if (signal.aborted) return;

    issueCtx.applicants = applicantsWithMetrics;

    /* ── Step 3: IMMEDIATE RENDER: Deterministic scoring + heuristic judge ── */
    const tier = issueCtx.issue.tier;
    const preliminaryCandidates = issueCtx.applicants.map(a => {
      const hJudge = heuristicJudge(issueCtx.issue, a);
      const scored = scoreCandidate({
        tier,
        metrics:         a.metrics ?? {},
        commentQuality:  hJudge.commentQuality,
        domainAlignment: hJudge.domainAlignment,
      });

      const flags = [...(scored.flags ?? [])];
      if (a.explicit_claim === false) {
        flags.push("No explicit claim phrase (check intent)");
      }
      if (a.metrics?.rateLimited) {
        flags.push("Incomplete metrics (rate limited)");
      }

      return {
        ...scored,
        flags,
        username:      a.username,
        justification: hJudge.justification,
        isPreliminary: true, // Marked as preliminary while Gemma reviews
      };
    });

    sortCandidates(preliminaryCandidates);
    preliminaryCandidates.forEach((c, i) => { c.rank = i + 1; });

    evaluation = {
      repo: issueCtx.repo,
      issueNumber: currentIssue.number,
      issue: issueCtx.issue,
      applicants: issueCtx.applicants,
      candidates: preliminaryCandidates,
      engine: "Preliminary (heuristic)",
    };

    // Render immediately! Cards appear under ~1-2s
    hide(loadingState);
    displayEvaluation(evaluation, false);

    // Save preliminary state immediately so tab switches or closes never lose results!
    await saveCachedEvaluation(currentIssue.full, currentIssue.number, evaluation);

    /* ── Step 4: Background Gemma Evaluation ── */
    if (!geminiKey) {
      // Offline mode: finalize heuristic
      evaluation.engine = "Heuristic (no API key)";
      evaluation.candidates.forEach(c => { c.isPreliminary = false; c.isHeuristicOnly = true; });
      updateFooter(evaluation.engine);
      await saveCachedEvaluation(currentIssue.full, currentIssue.number, evaluation);
      return;
    }

    // Show non-intrusive in-flight indicator
    show(gemmaProgressBar);
    if (gemmaProgressLabel) gemmaProgressLabel.textContent = "Asking Gemma…";

    try {
      const gemmaResult = await callGemma(issueCtx, geminiKey, {
        signal,
        bypassCache: bypassGemmaCache,
      });

      if (signal.aborted) return;

      const judgements = {};
      for (const c of (gemmaResult.candidates ?? [])) {
        if (c?.username) judgements[c.username.toLowerCase()] = c;
      }

      // Upgrade preliminary candidates with authoritative Gemma judgements
      const upgradedCandidates = issueCtx.applicants.map(a => {
        const j = judgements[a.username.toLowerCase()] ?? heuristicJudge(issueCtx.issue, a);
        const scored = scoreCandidate({
          tier,
          metrics:         a.metrics ?? {},
          commentQuality:  j.comment_quality  ?? j.commentQuality  ?? 0,
          domainAlignment: j.domain_alignment ?? j.domainAlignment ?? 0,
        });

        const flags = [...(scored.flags ?? [])];
        if (a.explicit_claim === false) {
          flags.push("No explicit claim phrase (check intent)");
        }
        if (a.metrics?.rateLimited) {
          flags.push("Incomplete metrics (rate limited)");
        }

        return {
          ...scored,
          flags,
          username:      a.username,
          justification: j.justification ?? "",
          isPreliminary: false,
        };
      });

      sortCandidates(upgradedCandidates);
      upgradedCandidates.forEach((c, i) => { c.rank = i + 1; });

      evaluation.candidates = upgradedCandidates;
      evaluation.engine = gemmaResult.model;
      evaluation.applicants = issueCtx.applicants;

      hide(gemmaProgressBar);
      displayEvaluation(evaluation, false);
      await saveCachedEvaluation(currentIssue.full, currentIssue.number, evaluation);

    } catch (err) {
      if (signal.aborted) return;
      hide(gemmaProgressBar);
      console.warn("[Agonas] Gemma unavailable, preserving heuristic scores:", err.message);

      // Keep preliminary ranking and explicitly flag as heuristic
      evaluation.engine = "Heuristic (offline)";
      evaluation.candidates.forEach(c => {
        c.isPreliminary = false;
        c.isHeuristicOnly = true;
      });
      evaluation.applicants = issueCtx.applicants;

      displayEvaluation(evaluation, false);
      showToast("Gemma unavailable, showing heuristic scores", "info");
      await saveCachedEvaluation(currentIssue.full, currentIssue.number, evaluation);
    }

  } catch (err) {
    if (signal.aborted) return;
    hideAll();
    show(issueBanner);
    errorMsg.textContent = err.message ?? String(err);
    show(errorState);
    show(footer);
  } finally {
    refreshBtn.classList.remove("spinning");
  }
}

/* ═══════════════════ Stage 1: Issue context ═══════════════════ */
async function fetchIssueContext(fullRepo, number, signal = null) {
  const [issue, comments] = await Promise.all([
    githubClient.get(`/repos/${fullRepo}/issues/${number}`),
    githubClient.paginate(`/repos/${fullRepo}/issues/${number}/comments`),
  ]);

  if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue.`);

  const labels = (issue.labels ?? []).map(l => typeof l === "string" ? l : l.name);
  const applicantsMap = {};

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

/* ═══════════════════ Stage 2: Candidate metrics (Concurrency: 4 + Memory Cache) ═══════════════════ */
async function fetchCandidateMetrics(ctx, fullRepo, signal = null, onProgress = null) {
  const tasks = ctx.applicants.map(a => async () => {
    const u = a.username;
    const memKey = `${u}@${fullRepo}`;

    // Return from in-memory cache if queried during this popup lifetime
    if (inMemoryCandidateMetrics.has(memKey)) {
      return { ...a, metrics: inMemoryCandidateMetrics.get(memKey) };
    }

    let rateLimited = false;

    const [userProfile, repos, globalCount, repoCount, mergedCount] = await Promise.allSettled([
      githubClient.get(`/users/${u}`).catch(err => { if (err.rateLimited) rateLimited = true; throw err; }),
      githubClient.get(`/users/${u}/repos`, { sort: "updated", per_page: "10" }).catch(err => { if (err.rateLimited) rateLimited = true; throw err; }),
      githubClient.searchCount(`is:issue is:open assignee:${u}`).catch(err => { if (err.rateLimited) rateLimited = true; throw err; }),
      githubClient.searchCount(`repo:${fullRepo} is:issue is:open assignee:${u}`).catch(err => { if (err.rateLimited) rateLimited = true; throw err; }),
      githubClient.searchCount(`is:pr is:merged author:${u}`).catch(err => { if (err.rateLimited) rateLimited = true; throw err; }),
    ]);

    const repoList = repos.status === "fulfilled" && Array.isArray(repos.value) ? repos.value : [];
    const languages = [...new Set(repoList.map(r => r.language).filter(Boolean))].slice(0, 6);
    const topRepos  = repoList.slice(0, 3).map(r => ({
      name: r.name,
      language: r.language,
      stargazers_count: r.stargazers_count,
    }));

    let accountAgeDays = null;
    let bio = "";
    let publicRepos = repoList.length;

    if (userProfile.status === "fulfilled" && userProfile.value) {
      const p = userProfile.value;
      if (p.created_at) {
        const createdMs = new Date(p.created_at).getTime();
        if (!isNaN(createdMs)) {
          accountAgeDays = Math.max(0, Math.floor((Date.now() - createdMs) / (1000 * 60 * 60 * 24)));
        }
      }
      if (typeof p.bio === "string") bio = p.bio;
      if (typeof p.public_repos === "number") publicRepos = p.public_repos;
    }

    const g = globalCount.status === "fulfilled" ? globalCount.value : 0;
    const r = repoCount.status   === "fulfilled" ? repoCount.value   : 0;
    const m = mergedCount.status === "fulfilled" ? mergedCount.value : 0;

    const metrics = {
      globalOpenAssigned:   g,
      global_open_assigned: g,
      repoOpenAssigned:     r,
      repo_open_assigned:   r,
      lifetimeMergedPrs:    m,
      lifetime_merged_prs:  m,
      accountAgeDays,
      account_age_days:     accountAgeDays,
      publicRepos,
      public_repos:         publicRepos,
      bio,
      languages,
      topRepos,
      rateLimited,
    };

    inMemoryCandidateMetrics.set(memKey, metrics);
    return { ...a, metrics };
  });

  return runConcurrent(tasks, 4, onProgress);
}

/* ═══════════════════ Stage 4: Rendering (Strictly XSS-Safe) ═══════════════════ */
export function renderCandidates(ev) {
  candidatesList.textContent = "";

  const declinedSet = new Set(ev.declined || []);
  const visible = (ev.candidates || []).filter(c => !declinedSet.has(c.username));

  const isNearTie = visible.length >= 2 &&
    Math.abs(visible[0].rawScore - visible[1].rawScore) < 0.5;

  visible.forEach((c, i) => {
    const isAssigned = ev.assigned === c.username;
    candidatesList.appendChild(buildCard(c, i === 0, isNearTie, ev.repo, ev.issue?.number ?? ev.issueNumber, isAssigned));
  });

  if (isNearTie) {
    const tieNote = document.createElement("div");
    tieNote.className = "near-tie-note";
    tieNote.id = "nearTieNote";
    tieNote.textContent = "Scores are very close; review the top candidates manually.";
    candidatesList.appendChild(tieNote);
  }
}

export function buildCard(c, isTop, isNearTie, fullRepo, issueNumber, isAssigned = false) {
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
  userLink.textContent = `@${c.username}`;

  const rankBadge = document.createElement("span");
  rankBadge.className = "rank-badge";
  rankBadge.textContent = `#${c.rank}`;

  usernameWrapper.appendChild(userLink);
  usernameWrapper.appendChild(rankBadge);

  // Status badges: Preliminary / Heuristic badge
  if (c.isPreliminary) {
    const prelimBadge = document.createElement("span");
    prelimBadge.className = "badge-preliminary";
    prelimBadge.textContent = "Preliminary (Gemma is reviewing…)";
    usernameWrapper.appendChild(prelimBadge);
  } else if (c.isHeuristicOnly) {
    const heurBadge = document.createElement("span");
    heurBadge.className = "badge-heuristic";
    heurBadge.textContent = "Heuristic (offline)";
    usernameWrapper.appendChild(heurBadge);
  }

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
    const flagLower = flag.toLowerCase();
    const isGood = flagLower.includes("boost +") || flagLower.includes("first-timer boost +");
    const isWarn = flagLower.includes("new account") ||
                   flagLower.includes("no public history") ||
                   flagLower.includes("withheld") ||
                   flagLower.includes("unknown") ||
                   flagLower.includes("intent") ||
                   flagLower.includes("claim") ||
                   flagLower.includes("rate limited") ||
                   flagLower.includes("incomplete");

    if (isGood) {
      flagChip.className = "flag-chip good";
    } else if (isWarn) {
      flagChip.className = "flag-chip warn";
    } else {
      flagChip.className = "flag-chip";
    }
    flagChip.textContent = flag;
    cardBadges.appendChild(flagChip);
  }
  card.appendChild(cardBadges);

  // 4. Justification
  if (c.justification) {
    const justEl = document.createElement("div");
    justEl.className = "card-justification";
    justEl.textContent = c.justification;
    card.appendChild(justEl);
  }

  // 5. Candidate stats
  const statsEl = document.createElement("div");
  statsEl.className = "card-stats";
  statsEl.textContent = `Global open: ${c.stats.globalOpenAssigned} · Repo open: ${c.stats.repoOpenAssigned} · Merged PRs: ${c.stats.lifetimeMergedPrs} · Raw: ${c.rawScore}`;
  card.appendChild(statsEl);

  // 6. Recommendation banner for top candidate (only when finalized, not near tie, not assigned)
  if (isTop && !isNearTie && !isAssigned && !c.isPreliminary) {
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

  // 7. Actions Container (Assign is never blocked on preliminary results)
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "card-actions";

  const btnAssign = document.createElement("button");
  btnAssign.className = "btn-assign";
  if (isAssigned) {
    btnAssign.disabled = true;
    btnAssign.style.background = "var(--ok)";
    btnAssign.textContent = "✓ Assigned!";
  } else {
    btnAssign.textContent = "✓ Assign";
  }

  const btnDecline = document.createElement("button");
  btnDecline.className = "btn-decline";
  btnDecline.textContent = "Decline";
  if (isAssigned) {
    btnDecline.style.display = "none";
  }

  actionsDiv.appendChild(btnAssign);
  actionsDiv.appendChild(btnDecline);
  card.appendChild(actionsDiv);

  // Confirmation state container
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

  // If preliminary, note in confirm message:
  confirmMsg.textContent = c.isPreliminary
    ? `Note: Scores are preliminary (heuristic). Assign @${c.username} to #${issueNumber}?`
    : `Assign @${c.username} to #${issueNumber}?`;

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

    // Update confirmation text in case state transitioned
    confirmMsg.textContent = c.isPreliminary
      ? `Note: Scores are preliminary (heuristic). Assign @${c.username} to #${issueNumber}?`
      : `Assign @${c.username} to #${issueNumber}?`;

    actionsDiv.style.display = "none";
    confirmDiv.style.display = "block";
  });

  btnConfirmCancel.addEventListener("click", () => {
    confirmDiv.style.display = "none";
    actionsDiv.style.display = "flex";
  });

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

      if (evaluation) {
        evaluation.assigned = c.username;
        await updateCachedActions(fullRepo, issueNumber, { assigned: c.username });
      }

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

  btnDecline.addEventListener("click", () => {
    card.style.transition = "opacity 0.25s, transform 0.25s";
    card.style.opacity = "0";
    card.style.transform = "translateX(20px)";
    setTimeout(async () => {
      card.remove();
      if (evaluation) {
        const declined = evaluation.declined || [];
        if (!declined.includes(c.username)) {
          declined.push(c.username);
          evaluation.declined = declined;
          await updateCachedActions(fullRepo, issueNumber, { declined });
        }
      }
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
   noCandidatesState, gemmaProgressBar, candidatesContainer, footer, tabSwitcherBanner].forEach(hide);
}

function showSetup() {
  hideAll();
  show(setupPrompt);
}

function setLoadingLabel(text) {
  if (loadingLabel) loadingLabel.textContent = text;
}

function updateFooter(engine) {
  if (footerEngine && engine) {
    footerEngine.textContent = engine;
  }
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
    if (typeof chrome === "undefined" || !chrome?.tabs?.query) {
      return resolve(null);
    }
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0]?.url ?? null);
    });
  });
}
