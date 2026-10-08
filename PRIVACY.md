# Agonas GitAssign — Privacy Policy

**Effective Date:** October 2026  
**Extension:** Agonas GitAssign (v1.0.1)

Agonas GitAssign is designed with privacy and security as primary architectural requirements. We do not collect, monetize, or track your personal data.

---

## 1. Storage of Credentials & API Keys
* **Local-Only Storage:** Your GitHub Personal Access Token (PAT) and Google Gemini API key are stored strictly on your local computer using Chrome's local storage (`chrome.storage.local`).
* **No Synchronization:** Keys are **never** synced to Google Chrome cloud sync accounts (`chrome.storage.sync` is not used for credentials) and never leave your machine.
* **No Middleman Servers:** Agonas has no backend server or proxy. All network communications are executed directly from your browser to GitHub and Google.

---

## 2. External Network Communications
Agonas GitAssign communicates exclusively with two official API endpoints:
1. **GitHub REST API (`https://api.github.com/`):**
   * Reads public issue context, comments, labels, and contributor activity metrics.
   * Performs assignment actions only when explicitly initiated and confirmed by you.
2. **Google Gemini API (`https://generativelanguage.googleapis.com/`):**
   * Sends candidate comments and public profile context for semantic scoring and evaluation via Gemma models.
   * No personally identifying information beyond public GitHub usernames and issue discussions is processed.

---

## 3. Telemetry and Analytics
* **Zero Analytics:** Agonas includes no third-party tracking scripts, cookies, Google Analytics, telemetry, or behavioral tracking.
* **Transient Processing:** Issue comments and candidate profiles are processed entirely in-memory during triage and are discarded when the popup is closed.

---

## 4. Deletion of Data
You have complete control over your stored data:
* Clearing API keys in the **Settings** page immediately deletes them from `chrome.storage.local`.
* Uninstalling the extension completely removes all extension data and cached metrics from your browser.

---

## 5. Contact & Open Source Auditing
Agonas is open source and available for public security audit:
* GitHub Repository: [https://github.com/Rehodra/Agonas](https://github.com/Rehodra/Agonas)
* Issue Tracker: [https://github.com/Rehodra/Agonas/issues](https://github.com/Rehodra/Agonas/issues)
