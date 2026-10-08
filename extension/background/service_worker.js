/**
 * background/service_worker.js
 * MV3 service worker — handles message passing, token validation,
 * and cross-origin fetch relay for any future messaging needs.
 */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    // Open options page on first install so user can enter credentials
    chrome.runtime.openOptionsPage();
  }
});

/**
 * Listen for messages from popup or content scripts.
 * Currently used for relaying GitHub auth-check.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_CURRENT_TAB_URL") {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      sendResponse({ url: tabs[0]?.url ?? null });
    });
    return true; // keep channel open for async response
  }

  if (msg.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "OPEN_DETACHED_WINDOW") {
    if (chrome.windows?.create) {
      chrome.windows.create({
        url: chrome.runtime.getURL("popup/popup.html?detached=1"),
        type: "popup",
        width: 440,
        height: 640,
      }, win => sendResponse({ ok: true, windowId: win?.id }));
      return true;
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/popup.html?detached=1") }, tab => {
        sendResponse({ ok: true, tabId: tab?.id });
      });
      return true;
    }
  }
});
