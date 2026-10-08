/**
 * extension/tests/persistence.test.js
 * Unit tests verifying:
 *   1. Immediate preliminary state saving to chrome.storage.local
 *   2. Dual-key storage (agonas_eval_${repo}_${num} and agonas_last_evaluation)
 *   3. Cross-tab continuity: results remain available when switching to non-issue tabs,
 *      other issue tabs, or returning to the original tab
 *   4. updateCachedActions synchronizes assigned/declined status across keys
 *   5. Recent issues tracking with LRU limit
 *   6. hasPreliminaryCandidates detection for seamless Gemma background completion
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  getCachedEvaluation,
  saveCachedEvaluation,
  getLastCachedEvaluation,
  updateCachedActions,
  updateRecentIssues,
  hasPreliminaryCandidates,
} from "../popup/popup.js";

describe("Triage State Persistence & Cross-Tab Continuity", () => {
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
          remove: (keys, cb) => {
            for (const k of keys) {
              delete fakeStore[k];
            }
            if (cb) cb();
          },
        },
      },
    };
  });

  test("saveCachedEvaluation stores under issue key, agonas_last_evaluation, and agonas_last_issue", async () => {
    const mockEval = {
      repo: "facebook/react",
      issueNumber: 123,
      issue: { title: "Fix memory leak in hook", tier: "intermediate" },
      candidates: [
        { username: "alice", score: 9.2, rawScore: 9.2, rank: 1, isPreliminary: true },
        { username: "bob", score: 7.5, rawScore: 7.5, rank: 2, isPreliminary: true },
      ],
      engine: "Preliminary (heuristic)",
    };

    await saveCachedEvaluation("facebook/react", 123, mockEval);

    const key = "agonas_eval_facebook/react_123";
    assert.ok(fakeStore[key], "Key agonas_eval_facebook/react_123 must exist");
    assert.equal(fakeStore[key].repo, "facebook/react");
    assert.equal(fakeStore[key].issueNumber, 123);
    assert.equal(fakeStore[key].candidates.length, 2);

    // Verify agonas_last_evaluation
    assert.ok(fakeStore["agonas_last_evaluation"], "agonas_last_evaluation must exist");
    assert.equal(fakeStore["agonas_last_evaluation"].repo, "facebook/react");
    assert.equal(fakeStore["agonas_last_evaluation"].issueNumber, 123);

    // Verify agonas_last_issue
    assert.ok(fakeStore["agonas_last_issue"]);
    assert.equal(fakeStore["agonas_last_issue"].full, "facebook/react");
    assert.equal(fakeStore["agonas_last_issue"].number, 123);

    // Verify recent issues
    assert.ok(Array.isArray(fakeStore["agonas_recent_issues"]));
    assert.equal(fakeStore["agonas_recent_issues"][0].repo, "facebook/react");
    assert.equal(fakeStore["agonas_recent_issues"][0].number, 123);
  });

  test("getCachedEvaluation retrieves stored evaluation by repo and issue number", async () => {
    const mockEval = {
      repo: "owner/repo",
      issueNumber: 456,
      issue: { title: "Test Issue", tier: "starter" },
      candidates: [{ username: "charlie", score: 8.0, rawScore: 8.0, rank: 1 }],
      engine: "gemma-4-26b-a4b-it",
    };

    await saveCachedEvaluation("owner/repo", 456, mockEval);
    const retrieved = await getCachedEvaluation("owner/repo", 456);

    assert.ok(retrieved);
    assert.equal(retrieved.repo, "owner/repo");
    assert.equal(retrieved.issueNumber, 456);
    assert.equal(retrieved.candidates[0].username, "charlie");
    assert.equal(retrieved.engine, "gemma-4-26b-a4b-it");
  });

  test("getLastCachedEvaluation retrieves the last evaluation directly", async () => {
    const mockEval = {
      repo: "acme/widget",
      issueNumber: 789,
      issue: { title: "Widget rendering bug", tier: "advanced" },
      candidates: [{ username: "dave", score: 8.5, rawScore: 8.5, rank: 1 }],
      engine: "Preliminary (heuristic)",
    };

    await saveCachedEvaluation("acme/widget", 789, mockEval);
    const last = await getLastCachedEvaluation();

    assert.ok(last);
    assert.equal(last.repo, "acme/widget");
    assert.equal(last.issueNumber, 789);
    assert.equal(last.candidates[0].username, "dave");
  });

  test("getLastCachedEvaluation falls back to agonas_last_key if agonas_last_evaluation is missing", async () => {
    const key = "agonas_eval_legacy/project_42";
    fakeStore[key] = {
      repo: "legacy/project",
      issueNumber: 42,
      candidates: [{ username: "legacy_user", score: 9.0 }],
    };
    fakeStore["agonas_last_key"] = key;

    const last = await getLastCachedEvaluation();
    assert.ok(last);
    assert.equal(last.repo, "legacy/project");
    assert.equal(last.issueNumber, 42);
  });

  test("updateCachedActions updates assigned user in both specific key and agonas_last_evaluation", async () => {
    const mockEval = {
      repo: "org/project",
      issueNumber: 10,
      candidates: [
        { username: "alice", score: 9.0, rank: 1 },
        { username: "bob", score: 7.0, rank: 2 },
      ],
      engine: "gemma-4-26b-a4b-it",
    };

    await saveCachedEvaluation("org/project", 10, mockEval);

    // User assigns alice
    await updateCachedActions("org/project", 10, { assigned: "alice" });

    const updatedKey = await getCachedEvaluation("org/project", 10);
    assert.equal(updatedKey.assigned, "alice");

    const updatedLast = await getLastCachedEvaluation();
    assert.equal(updatedLast.assigned, "alice");
  });

  test("updateCachedActions updates declined candidates list in both keys", async () => {
    const mockEval = {
      repo: "org/project",
      issueNumber: 10,
      candidates: [
        { username: "alice", score: 9.0, rank: 1 },
        { username: "bob", score: 7.0, rank: 2 },
      ],
      engine: "gemma-4-26b-a4b-it",
    };

    await saveCachedEvaluation("org/project", 10, mockEval);

    // User declines bob
    await updateCachedActions("org/project", 10, { declined: ["bob"] });

    const updatedKey = await getCachedEvaluation("org/project", 10);
    assert.deepEqual(updatedKey.declined, ["bob"]);

    const updatedLast = await getLastCachedEvaluation();
    assert.deepEqual(updatedLast.declined, ["bob"]);
  });

  test("hasPreliminaryCandidates correctly distinguishes preliminary vs finalized evaluations", () => {
    const preliminaryEval = {
      candidates: [
        { username: "u1", score: 8.0, isPreliminary: true },
        { username: "u2", score: 6.0, isPreliminary: true },
      ],
    };
    assert.equal(hasPreliminaryCandidates(preliminaryEval), true);

    const finalizedEval = {
      candidates: [
        { username: "u1", score: 8.0, isPreliminary: false },
        { username: "u2", score: 6.0, isPreliminary: false },
      ],
    };
    assert.equal(hasPreliminaryCandidates(finalizedEval), false);

    assert.equal(hasPreliminaryCandidates(null), false);
    assert.equal(hasPreliminaryCandidates({ candidates: [] }), false);
  });

  test("Tab-switching workflow: Preliminary evaluation on Tab A persists across tab changes", async () => {
    // 1. User triages Issue #1 on Tab A (takes ~1s for preliminary results)
    const issue1Eval = {
      repo: "facebook/react",
      issueNumber: 100,
      issue: { title: "Issue 100", tier: "intermediate" },
      applicants: [{ username: "dev1" }],
      candidates: [{ username: "dev1", score: 9.0, isPreliminary: true }],
      engine: "Preliminary (heuristic)",
    };

    await saveCachedEvaluation("facebook/react", 100, issue1Eval);

    // 2. User switches to Tab B (a PR, candidate profile, or non-issue tab)
    // The popup opens on Tab B: url is null/non-issue
    const lastResultOnNonIssueTab = await getLastCachedEvaluation();
    assert.ok(lastResultOnNonIssueTab, "Result must not disappear on non-issue tab");
    assert.equal(lastResultOnNonIssueTab.repo, "facebook/react");
    assert.equal(lastResultOnNonIssueTab.issueNumber, 100);

    // 3. User switches to Tab C (another issue: #200, which has not been triaged yet)
    // getLastCachedEvaluation() still reliably holds Tab A's evaluation
    const lastResultOnOtherIssueTab = await getLastCachedEvaluation();
    assert.ok(lastResultOnOtherIssueTab);
    assert.equal(lastResultOnOtherIssueTab.repo, "facebook/react");
    assert.equal(lastResultOnOtherIssueTab.issueNumber, 100);

    // 4. User switches back to Tab A (Issue #100)
    // getCachedEvaluation retrieves Tab A's result instantly with 0 latency
    const returnToTabA = await getCachedEvaluation("facebook/react", 100);
    assert.ok(returnToTabA, "Result must not disappear when returning to Tab A");
    assert.equal(returnToTabA.repo, "facebook/react");
    assert.equal(returnToTabA.issueNumber, 100);
    assert.equal(returnToTabA.candidates[0].username, "dev1");
  });

  test("updateRecentIssues maintains max 10 recent issues without duplicates", async () => {
    for (let i = 1; i <= 15; i++) {
      await updateRecentIssues("test/repo", i, `Issue ${i}`);
    }

    const recent = fakeStore["agonas_recent_issues"];
    assert.equal(recent.length, 10);
    // Most recent is #15
    assert.equal(recent[0].number, 15);
    // Oldest kept is #6
    assert.equal(recent[9].number, 6);
  });
});
