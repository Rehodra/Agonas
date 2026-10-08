/**
 * Agonas Landing Page Scripts
 * Vanilla JS: Accessible tab switchers, copy to clipboard with fallback.
 */

document.addEventListener("DOMContentLoaded", function () {
  initCopyButtons();
  initTabSwitchers();
});

/**
 * Initializes copy-to-clipboard functionality with graceful fallback
 */
function initCopyButtons() {
  var copyButtons = document.querySelectorAll(".btn-copy");

  copyButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var textToCopy = button.getAttribute("data-copy");

      if (!textToCopy) {
        // Fallback: copy from adjacent pre code block
        var wrapper = button.closest(".code-block-wrapper");
        if (wrapper) {
          var codeEl = wrapper.querySelector("pre code");
          if (codeEl) {
            textToCopy = codeEl.innerText;
          }
        }
      }

      if (!textToCopy) return;

      copyText(textToCopy, function (success) {
        if (success) {
          var originalText = button.textContent;
          button.textContent = "Copied";
          button.classList.add("copied");

          setTimeout(function () {
            button.textContent = originalText;
            button.classList.remove("copied");
          }, 2000);
        }
      });
    });
  });
}

/**
 * Copies text using navigator.clipboard or fallback textarea execCommand
 */
function copyText(text, callback) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(
      function () {
        callback(true);
      },
      function () {
        fallbackCopyText(text, callback);
      }
    );
  } else {
    fallbackCopyText(text, callback);
  }
}

function fallbackCopyText(text, callback) {
  var textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.select();

  try {
    var successful = document.execCommand("copy");
    document.body.removeChild(textarea);
    callback(successful);
  } catch (err) {
    document.body.removeChild(textarea);
    callback(false);
  }
}

/**
 * Initializes accessible tab switchers with ARIA and keyboard navigation
 */
function initTabSwitchers() {
  var tabGroups = document.querySelectorAll(".tab-wrapper");

  tabGroups.forEach(function (group) {
    var tabs = group.querySelectorAll('[role="tab"]');
    var panels = group.querySelectorAll('[role="tabpanel"]');

    tabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        activateTab(tab, tabs, panels);
      });

      // Keyboard navigation for tabs
      tab.addEventListener("keydown", function (e) {
        var tabList = Array.from(tabs);
        var index = tabList.indexOf(tab);

        if (e.key === "ArrowRight") {
          e.preventDefault();
          var nextTab = tabList[(index + 1) % tabList.length];
          nextTab.focus();
          activateTab(nextTab, tabs, panels);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          var prevTab = tabList[(index - 1 + tabList.length) % tabList.length];
          prevTab.focus();
          activateTab(prevTab, tabs, panels);
        } else if (e.key === "Home") {
          e.preventDefault();
          tabList[0].focus();
          activateTab(tabList[0], tabs, panels);
        } else if (e.key === "End") {
          e.preventDefault();
          tabList[tabList.length - 1].focus();
          activateTab(tabList[tabList.length - 1], tabs, panels);
        }
      });
    });
  });
}

function activateTab(selectedTab, allTabs, allPanels) {
  var targetPanelId = selectedTab.getAttribute("aria-controls");

  allTabs.forEach(function (tab) {
    tab.classList.remove("active");
    tab.setAttribute("aria-selected", "false");
  });

  allPanels.forEach(function (panel) {
    panel.classList.remove("active");
  });

  selectedTab.classList.add("active");
  selectedTab.setAttribute("aria-selected", "true");

  var activePanel = document.getElementById(targetPanelId);
  if (activePanel) {
    activePanel.classList.add("active");
  }
}
