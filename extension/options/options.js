/**
 * options/options.js
 * Settings controller — loads/saves strictly to chrome.storage.local
 * so API keys never leave the user's machine.
 */

const $ = id => document.getElementById(id);

const githubTokenInput   = $("githubToken");
const geminiApiKeyInput  = $("geminiApiKey");
const autoTriageToggle   = $("autoTriage");
const injectButtonToggle = $("injectButton");
const heuristicToggle    = $("heuristicFallback");
const saveBtn            = $("saveBtn");
const testBtn            = $("testBtn");
const statusBanner       = $("statusBanner");

// Show / hide toggle for password fields
document.querySelectorAll(".toggle-vis").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁" : "🙈";
  });
});

// ── Load saved settings from chrome.storage.local (with sync migration) ──
chrome.storage.local.get(
  ["githubToken", "geminiApiKey", "autoTriage", "injectButton", "heuristicFallback"],
  data => {
    if (data.githubToken)   githubTokenInput.value  = data.githubToken;
    if (data.geminiApiKey)  geminiApiKeyInput.value = data.geminiApiKey;
    if (data.autoTriage       !== undefined) autoTriageToggle.checked   = data.autoTriage;
    if (data.injectButton     !== undefined) injectButtonToggle.checked = data.injectButton;
    if (data.heuristicFallback !== undefined) heuristicToggle.checked  = data.heuristicFallback;

    // Migrate old settings from sync if local was empty
    if (!data.githubToken && !data.geminiApiKey && chrome.storage.sync) {
      chrome.storage.sync.get(
        ["githubToken", "geminiApiKey", "autoTriage", "injectButton", "heuristicFallback"],
        syncData => {
          if (syncData.githubToken || syncData.geminiApiKey) {
            if (syncData.githubToken)   githubTokenInput.value  = syncData.githubToken;
            if (syncData.geminiApiKey)  geminiApiKeyInput.value = syncData.geminiApiKey;
            if (syncData.autoTriage       !== undefined) autoTriageToggle.checked   = syncData.autoTriage;
            if (syncData.injectButton     !== undefined) injectButtonToggle.checked = syncData.injectButton;
            if (syncData.heuristicFallback !== undefined) heuristicToggle.checked  = syncData.heuristicFallback;

            // Save to local and clear from sync
            chrome.storage.local.set(syncData);
            chrome.storage.sync.clear();
          }
        }
      );
    }
  }
);

// ── Save strictly to chrome.storage.local ──
saveBtn.addEventListener("click", () => {
  const settings = {
    githubToken:       githubTokenInput.value.trim(),
    geminiApiKey:      geminiApiKeyInput.value.trim(),
    autoTriage:        autoTriageToggle.checked,
    injectButton:      injectButtonToggle.checked,
    heuristicFallback: heuristicToggle.checked,
  };

  chrome.storage.local.set(settings, () => {
    // Clear sync storage to guarantee keys don't leave the machine
    chrome.storage.sync?.clear?.();
    showBanner("✓ Settings saved locally (keys never sync).", "ok");
  });
});

// ── Test GitHub connection ──
testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  testBtn.textContent = "Testing…";

  const token = githubTokenInput.value.trim();
  if (!token) {
    showBanner("✗ Enter a GitHub token first.", "err");
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
    return;
  }

  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (res.ok) {
      const user = await res.json();
      showBanner(`✓ Authenticated as @${user.login}`, "ok");
    } else {
      const err = await res.json().catch(() => ({}));
      showBanner(`✗ GitHub: ${err.message ?? res.statusText}`, "err");
    }
  } catch (e) {
    showBanner(`✗ Network error: ${e.message}`, "err");
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
  }
});

function showBanner(msg, type) {
  statusBanner.textContent = msg;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.style.display = "block";
  setTimeout(() => { statusBanner.style.display = "none"; }, 4000);
}
