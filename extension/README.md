# Agonas GitAssign — Browser Extension

A browser extension that brings the **Agonas GitAssign** skill directly into GitHub, letting maintainers triage `assign me` candidates and assign issues in one click — without leaving the page.

## Features

- 🔍 **Auto-detects** GitHub issue pages and extracts candidates from comments
- 🤖 **AI Scoring** via Google Gemma 4 (or offline heuristic fallback)
- 📊 **5-pillar rubric**: Comment quality · Global burden · Repo monopoly · Domain alignment · First-timer boost
- ✅ **1-click Assign** or **Decline** directly from the popup
- ⚡ **Injects a Triage button** into the GitHub issue header
- 💾 **Persistent triage state** across tab switches, with instant reload and background Gemma resumption
- ↗️ **Detached floating window** mode — keep triage results open side-by-side while browsing across tabs
- 🌙 **GitHub dark mode** design system — feels native

---

## Installation (Developer Mode)

### Chrome / Edge / Brave

1. Clone or download this repo
2. Open `chrome://extensions/` (or `edge://extensions/`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `extension/` folder
5. The ⚡ icon appears in your toolbar — pin it for easy access

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `extension/manifest.json`

> **Note:** Firefox temporary add-ons are removed on browser restart. For persistent install, submit to AMO or use [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).

---

## Setup

On first install, the **Settings** page opens automatically.

| Field | Required | Description |
|---|---|---|
| GitHub PAT | ✅ Yes | Classic token with `repo` scope, or fine-grained with Issues R/W. [Generate →](https://github.com/settings/tokens/new?scopes=repo&description=Agonas+GitAssign) |
| Gemini API Key | ⬜ Optional | Enables Gemma 4 AI scoring. Without it, heuristic scoring is used. [Get key →](https://aistudio.google.com/app/apikey) |

Click **Test Connection** to verify your GitHub token, then **Save Settings**.

---

## Usage

1. Navigate to any GitHub issue with "assign me" comments
2. Click the **⚡ Agonas** icon in your browser toolbar (or the injected ⚡ button on the page)
3. The popup fetches candidates, scores them, and shows ranked cards
4. Click **Assign** to assign the top candidate, or **Decline** to remove them from consideration

---

## Scoring Rubric

Identical to the Python skill (`references/scoring_rules.md`):

| Pillar | Weight | Description |
|---|---|---|
| Comment Quality | 30% | Specific proposals vs. generic spam |
| Global Anti-Hoarding | 20% | Number of open issues assigned globally |
| Repo Monopoly | 20% | Open issues in this specific repo |
| Domain Alignment | 15% | Language / framework overlap |
| First-Timer Boost | 15% | +2.0 for new contributors on starter issues |

**Hard cap:** Score capped at 4.0 if candidate has ≥3 open issues in the same repo.

---

## File Structure

```
extension/
├── manifest.json              # MV3 manifest
├── README.md                  # This file
├── icons/                     # Extension icons (16/32/48/128px)
├── popup/
│   ├── popup.html             # Main popup UI
│   ├── popup.css              # GitHub dark-mode design system
│   └── popup.js               # Popup orchestration
├── background/
│   └── service_worker.js      # MV3 service worker
├── content/
│   └── content_script.js      # GitHub page injection
├── lib/
│   ├── github_api.js          # GitHub REST client
│   ├── scorer.js              # 5-pillar scoring engine
│   ├── gemma_client.js        # Gemini/Gemma API client
│   └── utils.js               # Shared utilities
└── options/
    ├── options.html            # Settings page
    └── options.js             # Settings controller
```

---

---

## Testing & Cross-Platform Verification

The extension includes automated test suites to ensure parity between JavaScript and the reference Python implementation:

```bash
# Run using Node's built-in test runner (no dependencies required)
node --test extension/tests/

# Or run the standalone test script
node extension/tests/test_scorer.js
```

### Shared Test Vectors
All scoring test cases and edge cases are maintained in:
[`extension/tests/scoring-vectors.json`](tests/scoring-vectors.json)

> **Note for Maintainers:** To prevent logic drift between the extension and the Python skill, the pytest suite (`skill/tests/`) should load and assert against this exact shared `scoring-vectors.json` file.

---

## Permissions Used

| Permission | Reason |
|---|---|
| `activeTab` | Read the current GitHub issue URL |
| `tabs` | Get the active tab URL on popup open |
| `storage` | Store credentials in `chrome.storage.local` (strictly local to device) |
| `api.github.com` | Fetch issue/comment/user data |
| `generativelanguage.googleapis.com` | Gemma scoring API |

---

## Privacy

- Your GitHub PAT and Gemini API key are stored **strictly in `chrome.storage.local`** on your device (never sent to external sync or remote servers).
- No data is sent to any server other than `api.github.com` and `generativelanguage.googleapis.com`.
- The extension makes no outbound connections except when you explicitly trigger a triage.

