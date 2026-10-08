/**
 * content/content_script.js
 * Injected on GitHub pages. Handles GitHub Turbo / PJAX page swaps
 * and dynamically injects the ⚡ Triage button whenever on an issue page.
 */

(function () {
  "use strict";

  /** @returns {{ owner: string, repo: string, number: number, full: string } | null} */
  function parseIssueUrl() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: parseInt(m[3], 10), full: `${m[1]}/${m[2]}` };
  }

  function tryInject() {
    const issue = parseIssueUrl();
    const existing = document.getElementById("agonas-triage-btn");

    // If not currently on an issue page, remove any stale button
    if (!issue) {
      if (existing) existing.remove();
      return;
    }

    // Already injected for this issue
    if (existing) {
      if (existing.dataset.issueNumber === String(issue.number)) return;
      existing.remove();
    }

    // Target toolbar in GitHub issue header
    const target =
      document.querySelector(".gh-header-actions") ??
      document.querySelector(".js-issue-header-actions") ??
      document.querySelector("[data-testid='issue-header-actions']") ??
      document.querySelector("[data-component='PH_HeaderAction']");

    if (!target) return;

    const btn = document.createElement("button");
    btn.id = "agonas-triage-btn";
    btn.className = "btn btn-sm";
    btn.dataset.issueNumber = String(issue.number);
    btn.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: #161b22;
      color: #58a6ff;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      margin-left: 8px;
      transition: background 0.15s;
    `;
    btn.innerHTML = `<span style="font-size:14px">⚡</span> Triage`;
    btn.title = "Agonas GitAssign — score applicants for this issue";

    btn.addEventListener("mouseenter", () => { btn.style.background = "#1f2937"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#161b22"; });

    btn.addEventListener("click", () => {
      chrome.storage.local?.set?.({
        agonas_active_issue: {
          ...issue,
          timestamp: Date.now(),
        },
      });
      chrome.storage.session?.set?.({ agLastIssue: issue });
      btn.style.color = "#3fb950";
      btn.textContent = "⚡ Click extension icon in toolbar";
      setTimeout(() => {
        btn.style.color = "#58a6ff";
        btn.innerHTML = `<span style="font-size:14px">⚡</span> Triage`;
      }, 2500);
    });

    target.prepend(btn);
  }

  // Initial run
  tryInject();

  // Handle GitHub Turbo / PJAX page swaps
  document.addEventListener("turbo:load", tryInject);
  document.addEventListener("turbo:render", tryInject);
  document.addEventListener("turbo:visit", tryInject);
  document.addEventListener("pjax:end", tryInject);
  window.addEventListener("popstate", tryInject);

  // Fallback observer for SPA transitions
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      tryInject();
    } else {
      if (!document.getElementById("agonas-triage-btn") && parseIssueUrl()) {
        tryInject();
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
