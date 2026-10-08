/**
 * lib/github_api.js
 * GitHub REST API client — mirrors scripts/common.py GitHub class.
 * All keys stored in chrome.storage.local (never sync).
 * Implements:
 *   - Limited concurrency for search calls
 *   - Rate limit backoff (403 secondary rate limit & 429)
 *   - TTL caching for applicant metrics
 *   - Pre-assignment permission check & assignee confirmation
 */

const API = "https://api.github.com";

// In-memory cache for API results (5 min TTL)
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Execute an array of promise-returning tasks with limited concurrency.
 * @param {Array<() => Promise<any>>} tasks
 * @param {number} concurrency
 * @returns {Promise<any[]>}
 */
export async function runConcurrent(tasks, concurrency = 2) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        results[idx] = { error: err.message };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export class GitHubClient {
  /**
   * @param {string} token - GitHub Personal Access Token
   */
  constructor(token) {
    this.token = token;
  }

  /** @returns {HeadersInit} */
  get _headers() {
    const h = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {object} [options]
   * @param {number} [attempt]
   */
  async request(method, path, options = {}, attempt = 0) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const res = await fetch(url, {
      method,
      headers: { ...this._headers, ...(options.headers ?? {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const isRateLimited =
      res.status === 429 ||
      (res.status === 403 && res.headers.get("X-RateLimit-Remaining") === "0");

    if (isRateLimited || res.status === 403) {
      // Check for secondary rate limit message
      let bodyText = "";
      try {
        const cloned = res.clone();
        bodyText = await cloned.text();
      } catch (_) {}

      const isSecondary = bodyText.toLowerCase().includes("secondary rate limit");

      if ((isRateLimited || isSecondary) && attempt < 3) {
        const waitHeader = res.headers.get("Retry-After") ?? res.headers.get("X-RateLimit-Reset");
        let delaySec = 2 ** (attempt + 1); // Exponential backoff: 2s, 4s, 8s
        if (waitHeader) {
          const parsed = parseInt(waitHeader, 10);
          if (!isNaN(parsed)) {
            delaySec = parsed > 1000000 ? Math.max(parsed - Math.floor(Date.now() / 1000), 1) : parsed;
          }
        }
        const delayMs = Math.min(Math.max(delaySec, 2), 60) * 1000;
        console.warn(`[Agonas] Rate limited on ${path} (${res.status}). Backing off for ${delayMs / 1000}s (attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, delayMs));
        return this.request(method, path, options, attempt + 1);
      }
    }

    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message ?? msg; } catch (_) { /* ignore */ }
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${msg}`);
    }

    return res;
  }

  /**
   * Cached GET request.
   * @param {string} path
   * @param {Record<string,string>} [params]
   * @param {boolean} [bypassCache]
   */
  async get(path, params = {}, bypassCache = false) {
    const qs = new URLSearchParams(params).toString();
    const fullPath = qs ? `${path}?${qs}` : path;

    if (!bypassCache) {
      const cached = getCached(fullPath);
      if (cached !== null) return cached;
    }

    const res = await this.request("GET", fullPath);
    const data = await res.json();
    if (!bypassCache) setCached(fullPath, data);
    return data;
  }

  /**
   * Paginate a list endpoint (up to maxPages pages).
   * @param {string} path
   * @param {number} [maxPages]
   */
  async paginate(path, maxPages = 5) {
    let url = `${API}${path}?per_page=100`;
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request("GET", url);
      const data = await res.json();
      out.push(...data);
      const next = res.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      if (!next) break;
      url = next;
    }
    return out;
  }

  /**
   * Get total count from a search query (cached).
   * @param {string} q
   */
  async searchCount(q) {
    const cacheKey = `search:${q}`;
    const cached = getCached(cacheKey);
    if (cached !== null) return cached;

    const data = await this.get("/search/issues", { q, per_page: "1" });
    const count = parseInt(data.total_count ?? 0, 10);
    setCached(cacheKey, count);
    return count;
  }

  /**
   * Safely assign a user to an issue:
   * 1. Checks write permissions on repo first
   * 2. Executes assignment POST
   * 3. Confirms user is present in response assignees
   *
   * @param {string} fullRepo - "owner/repo"
   * @param {number} issueNumber
   * @param {string} username
   * @returns {Promise<object>}
   */
  async assignUser(fullRepo, issueNumber, username) {
    // 1. Check permissions first
    const canWrite = await this.canWrite(fullRepo);
    if (!canWrite) {
      throw new Error(`Your token lacks write permission to assign users on ${fullRepo}.`);
    }

    // 2. Perform POST
    const res = await this.request("POST", `/repos/${fullRepo}/issues/${issueNumber}/assignees`, {
      body: { assignees: [username] },
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();

    // 3. Confirm assignee in response
    const assignedLogins = (data.assignees || []).map(a => (a.login || "").toLowerCase());
    if (!assignedLogins.includes(username.toLowerCase())) {
      throw new Error(`GitHub did not add @${username} as an assignee. Ensure the user is assignable to ${fullRepo}.`);
    }

    return data;
  }

  /**
   * Check if the authenticated token has write access to a repo.
   * @param {string} fullRepo
   */
  async canWrite(fullRepo) {
    try {
      const repo = await this.get(`/repos/${fullRepo}`);
      const perms = repo.permissions ?? {};
      return !!(perms.push || perms.triage || perms.maintain || perms.admin);
    } catch (_) {
      return false;
    }
  }

  /**
   * Get current authenticated user.
   */
  async getCurrentUser() {
    return this.get("/user", {}, true);
  }
}

/**
 * Load the GitHub token strictly from chrome.storage.local (with sync migration).
 * @returns {Promise<string|null>}
 */
export async function loadGitHubToken() {
  return new Promise(resolve => {
    chrome.storage.local.get(["githubToken"], localRes => {
      if (localRes?.githubToken) {
        return resolve(localRes.githubToken);
      }
      // Migration fallback from sync
      chrome.storage.sync?.get?.(["githubToken"], syncRes => {
        if (syncRes?.githubToken) {
          chrome.storage.local.set({ githubToken: syncRes.githubToken });
          chrome.storage.sync.remove(["githubToken"]);
          return resolve(syncRes.githubToken);
        }
        resolve(null);
      });
    });
  });
}
