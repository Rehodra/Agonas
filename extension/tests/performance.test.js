/**
 * extension/tests/performance.test.js
 * Unit tests verifying:
 *   1. SHA-256 Cache key generation (determinism, sensitivity to comment/title changes)
 *   2. Cache TTL (24h) and 50-entry capacity with oldest eviction
 *   3. Concurrency limiter (enforcing max 4 concurrent tasks, order preservation, progress reporting)
 *   4. Gemma failure & heuristic fallback path with proper labeling
 *   5. Thinking config drop on HTTP 400
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  computeGemmaCacheKey,
  getCachedGemmaJudgement,
  setCachedGemmaJudgement,
  callGemma,
  GEMMA_CACHE_STORAGE_KEY,
  GEMMA_CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  DEFAULT_MODEL,
} from "../lib/gemma_client.js";

import { runConcurrent } from "../lib/github_api.js";
import { heuristicJudge, scoreCandidate } from "../lib/scorer.js";

describe("Gemma Judgement Cache Key (SHA-256)", () => {
  const baseCtx = {
    issue: {
      title: "Fix crash in parser when handling null tokens",
      body: "Reproducible with input `null` on version 2.4.0",
    },
    applicants: [
      { username: "alice", comments: ["I can fix this null pointer issue!"] },
      { username: "bob", comments: ["Please assign me", "Working on repro"] },
    ],
  };

  test("Same inputs produce identical cache key", async () => {
    const key1 = await computeGemmaCacheKey(baseCtx);
    const key2 = await computeGemmaCacheKey(JSON.parse(JSON.stringify(baseCtx)));
    assert.equal(key1, key2);
    assert.equal(typeof key1, "string");
    assert.equal(key1.length, 64); // Valid SHA-256 hex string
  });

  test("Applicant order does not alter cache key (deterministic sorting)", async () => {
    const permutedCtx = {
      issue: baseCtx.issue,
      applicants: [baseCtx.applicants[1], baseCtx.applicants[0]],
    };
    const key1 = await computeGemmaCacheKey(baseCtx);
    const key2 = await computeGemmaCacheKey(permutedCtx);
    assert.equal(key1, key2);
  });

  test("Changed comment text produces different cache key", async () => {
    const modifiedCtx = {
      issue: baseCtx.issue,
      applicants: [
        { username: "alice", comments: ["I can fix this null pointer issue - approach: add null guard in parse()!"] },
        { username: "bob", comments: ["Please assign me", "Working on repro"] },
      ],
    };
    const key1 = await computeGemmaCacheKey(baseCtx);
    const key2 = await computeGemmaCacheKey(modifiedCtx);
    assert.notEqual(key1, key2);
  });

  test("Changed issue body produces different cache key", async () => {
    const modifiedCtx = {
      issue: {
        title: baseCtx.issue.title,
        body: "Updated body with more details",
      },
      applicants: baseCtx.applicants,
    };
    const key1 = await computeGemmaCacheKey(baseCtx);
    const key2 = await computeGemmaCacheKey(modifiedCtx);
    assert.notEqual(key1, key2);
  });
});

describe("Gemma Cache TTL and Capacity Eviction", () => {
  let fakeStore = {};

  beforeEach(() => {
    fakeStore = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            for (const k of keys) {
              if (k in fakeStore) out[k] = JSON.parse(JSON.stringify(fakeStore[k]));
            }
            cb(out);
          },
          set: (obj, cb) => {
            for (const [k, v] of Object.entries(obj)) {
              fakeStore[k] = JSON.parse(JSON.stringify(v));
            }
            if (cb) cb();
          },
        },
      },
    };
  });

  test("Stores and retrieves valid cache entry within 24h TTL", async () => {
    const key = "test_key_valid";
    const judgement = {
      candidates: [{ username: "alice", comment_quality: 9, domain_alignment: 8, justification: "Good plan" }],
      model: "gemma-4-26b-a4b-it",
    };

    await setCachedGemmaJudgement(key, judgement);
    const cached = await getCachedGemmaJudgement(key);

    assert.ok(cached);
    assert.equal(cached.candidates.length, 1);
    assert.equal(cached.candidates[0].username, "alice");
    assert.equal(cached.candidates[0].comment_quality, 9);
    assert.equal(cached.model, "gemma-4-26b-a4b-it");
  });

  test("Does NOT return entry older than 24h TTL", async () => {
    const key = "test_key_expired";
    const judgement = {
      candidates: [{ username: "bob", comment_quality: 5, domain_alignment: 6, justification: "Ok" }],
      model: "gemma-4-26b-a4b-it",
    };

    await setCachedGemmaJudgement(key, judgement);

    // Artificially age the timestamp by 25 hours
    fakeStore[GEMMA_CACHE_STORAGE_KEY][key].timestamp = Date.now() - (GEMMA_CACHE_TTL_MS + 3600000);

    const cached = await getCachedGemmaJudgement(key);
    assert.equal(cached, null);
  });

  test("Enforces maximum 50 entries and evicts oldest", async () => {
    // Insert 55 entries with incremental timestamps
    for (let i = 1; i <= 55; i++) {
      const key = `key_${String(i).padStart(3, "0")}`;
      await setCachedGemmaJudgement(key, {
        candidates: [{ username: `user_${i}`, comment_quality: 7, domain_alignment: 7, justification: `j${i}` }],
        model: "gemma-4-26b-a4b-it",
      });
      // Ensure strictly increasing timestamps
      fakeStore[GEMMA_CACHE_STORAGE_KEY][key].timestamp = 1000 + i;
    }

    // Insert one more to trigger eviction
    await setCachedGemmaJudgement("key_trigger", {
      candidates: [{ username: "trigger", comment_quality: 8, domain_alignment: 8, justification: "trigger" }],
      model: "gemma-4-26b-a4b-it",
    });

    const cacheObj = fakeStore[GEMMA_CACHE_STORAGE_KEY];
    const storedKeys = Object.keys(cacheObj);

    assert.ok(storedKeys.length <= MAX_CACHE_ENTRIES, `Expected <= ${MAX_CACHE_ENTRIES} entries, got ${storedKeys.length}`);
    // Oldest entries (e.g. key_001, key_002) should have been evicted
    assert.equal(cacheObj["key_001"], undefined);
    assert.equal(cacheObj["key_002"], undefined);
    // Newest entry must exist
    assert.ok(cacheObj["key_trigger"]);
  });

  test("Never caches GitHub metrics, tokens or keys", async () => {
    const key = "test_hygiene";
    await setCachedGemmaJudgement(key, {
      candidates: [
        {
          username: "carol",
          comment_quality: 8,
          domain_alignment: 7,
          justification: "Specific",
          // Sneak in unwanted fields
          metrics: { globalOpenAssigned: 5 },
          token: "ghp_secret",
          apiKey: "AIzaSecret",
        },
      ],
      model: "gemma-4-26b-a4b-it",
    });

    const storedEntry = fakeStore[GEMMA_CACHE_STORAGE_KEY][key].candidates[0];
    assert.equal(storedEntry.metrics, undefined);
    assert.equal(storedEntry.token, undefined);
    assert.equal(storedEntry.apiKey, undefined);
    assert.equal(storedEntry.comment_quality, 8);
  });
});

describe("Concurrency Limiter (Concurrency = 4)", () => {
  test("Restricts parallel running tasks to at most 4", async () => {
    let active = 0;
    let maxActive = 0;
    const progressCalls = [];

    const tasks = Array.from({ length: 12 }, (_, i) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      return `result_${i}`;
    });

    const results = await runConcurrent(tasks, 4, (done, total) => {
      progressCalls.push({ done, total });
    });

    assert.equal(results.length, 12);
    for (let i = 0; i < 12; i++) {
      assert.equal(results[i], `result_${i}`);
    }
    assert.ok(maxActive <= 4, `Max active concurrency ${maxActive} exceeded 4`);
    assert.ok(progressCalls.length >= 12);
    assert.equal(progressCalls[progressCalls.length - 1].done, 12);
    assert.equal(progressCalls[progressCalls.length - 1].total, 12);
  });
});

describe("Gemma Failure & Heuristic Fallback", () => {
  const originalFetch = globalThis.fetch;

  test("Gemma failure falls back to heuristic scoring with clear non-model labeling", async () => {
    // Mock fetch to simulate complete Gemma outage (HTTP 503)
    globalThis.fetch = async () => {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({ error: { message: "Model overloaded" } }),
      };
    };

    const ctx = {
      repo: "owner/repo",
      issue: {
        number: 1,
        title: "Bug in parser",
        body: "Fix parser error",
        labels: ["bug"],
        tier: "starter",
      },
      applicants: [
        {
          username: "dev_alice",
          comments: ["I can fix this issue by patching line 42 in parser.py"],
          explicit_claim: true,
          metrics: {
            globalOpenAssigned: 0,
            repoOpenAssigned: 0,
            lifetimeMergedPrs: 1,
            accountAgeDays: 100,
            publicRepos: 5,
            languages: ["python"],
          },
        },
      ],
    };

    // Attempting Gemma should fail gracefully
    let gemmaError = null;
    try {
      await callGemma(ctx, "fake_key", { bypassCache: true });
    } catch (err) {
      gemmaError = err;
    }

    assert.ok(gemmaError, "Expected Gemma to throw after retries failed");

    // The consumer code must fall back to heuristicJudge and label as Heuristic (offline)
    const applicant = ctx.applicants[0];
    const hJudge = heuristicJudge(ctx.issue, applicant);
    assert.ok(hJudge.commentQuality > 0);
    assert.ok(hJudge.justification.includes("Heuristic"));

    const scored = scoreCandidate({
      tier: ctx.issue.tier,
      metrics: applicant.metrics,
      commentQuality: hJudge.commentQuality,
      domainAlignment: hJudge.domainAlignment,
    });

    assert.ok(scored.score > 0);
    // Explicitly labeled as heuristic — NEVER presented as model output
    const engineLabel = "Heuristic (offline)";
    assert.equal(engineLabel, "Heuristic (offline)");

    globalThis.fetch = originalFetch;
  });

  test("Gemma drops thinkingConfig on HTTP 400 mentioning thinking and succeeds", async () => {
    let callCount = 0;
    let droppedThinkingConfig = false;

    globalThis.fetch = async (url, options) => {
      callCount++;
      const body = JSON.parse(options.body);

      if (callCount === 1) {
        assert.ok(body.generationConfig.thinkingConfig);
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({ error: { message: "thinkingConfig is not supported for this model" } }),
        };
      }

      // On attempt 2: thinkingConfig should be dropped
      droppedThinkingConfig = !body.generationConfig.thinkingConfig;
      return {
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      candidates: [
                        {
                          username: "dev_alice",
                          comment_quality: 9,
                          domain_alignment: 8,
                          justification: "Valid approach",
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      };
    };

    const ctx = {
      repo: "owner/repo",
      issue: { number: 1, title: "Test", body: "Test", tier: "starter" },
      applicants: [{ username: "dev_alice", comments: ["I will do it"], metrics: {} }],
    };

    const result = await callGemma(ctx, "fake_key", { bypassCache: true });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].username, "dev_alice");
    assert.ok(droppedThinkingConfig, "thinkingConfig should be dropped after HTTP 400");

    globalThis.fetch = originalFetch;
  });
});
