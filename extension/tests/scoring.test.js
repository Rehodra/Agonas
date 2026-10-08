/**
 * extension/tests/scoring.test.js
 * Test suite for Agonas scoring engine and ranking logic.
 * Executable via Node's native test runner: node --test extension/tests/
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scoreCandidate, sortCandidates, computeHistoryPoints, POLICY } from "../lib/scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vectorsPath = path.join(__dirname, "scoring-vectors.json");
const vectors = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));

describe("Agonas Scoring Engine Test Vectors", () => {
  for (const tc of vectors) {
    test(`Vector case: ${tc.name}`, () => {
      const inputMetrics = {
        globalOpenAssigned: tc.metrics.global_open_assigned,
        repoOpenAssigned:   tc.metrics.repo_open_assigned,
        lifetimeMergedPrs:  tc.metrics.lifetime_merged_prs,
        languages:          tc.metrics.languages,
        publicRepos:        tc.metrics.public_repos,
        accountAgeDays:     tc.metrics.account_age_days,
        bio:                tc.metrics.bio,
      };

      const actual = scoreCandidate({
        tier:            tc.tier,
        metrics:         inputMetrics,
        commentQuality:  tc.comment_quality,
        domainAlignment: tc.domain_alignment,
      });

      const exp = tc.expected;

      // Assert unclamped rawScore
      assert.ok(
        Math.abs(actual.rawScore - exp.rawScore) < 0.05,
        `rawScore mismatch for ${tc.name}: actual ${actual.rawScore} vs expected ${exp.rawScore}`
      );

      // Assert clamped score (0-10)
      assert.ok(
        Math.abs(actual.score - exp.score) < 0.05,
        `score mismatch for ${tc.name}: actual ${actual.score} vs expected ${exp.score}`
      );

      // Assert risk category
      assert.equal(
        actual.risk,
        exp.risk,
        `risk mismatch for ${tc.name}: actual ${actual.risk} vs expected ${exp.risk}`
      );

      // Assert flags
      const actualFlags = (actual.flags || []).slice().sort();
      const expFlags = (exp.flags || []).slice().sort();
      assert.deepEqual(
        actualFlags,
        expFlags,
        `flags mismatch for ${tc.name}:\nActual:   ${JSON.stringify(actualFlags)}\nExpected: ${JSON.stringify(expFlags)}`
      );
    });
  }
});

describe("Agonas Candidate Ranking & Tie-Breaking", () => {
  test("Case 5: Ranks higher rawScore first even when clamped scores are both 10", () => {
    const higher = {
      username: "alice_high_raw",
      rawScore: 11.12,
      score: 10.0,
      historyPoints: 3,
      stats: { globalOpenAssigned: 2 },
    };
    const lower = {
      username: "bob_lower_raw",
      rawScore: 10.35,
      score: 10.0,
      historyPoints: 2,
      stats: { globalOpenAssigned: 0 },
    };

    const sorted = sortCandidates([lower, higher]);
    assert.equal(sorted[0].username, "alice_high_raw");
    assert.equal(sorted[1].username, "bob_lower_raw");
  });

  test("Case 6a: Tie on rawScore breaks by historyPoints (higher first)", () => {
    const candidateA = {
      username: "user_a",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 4,
      stats: { globalOpenAssigned: 2 },
    };
    const candidateB = {
      username: "user_b",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 1,
      stats: { globalOpenAssigned: 1 }, // even though user_b has fewer open issues, historyPoints takes priority
    };

    const sorted = sortCandidates([candidateB, candidateA]);
    assert.equal(sorted[0].username, "user_a");
    assert.equal(sorted[1].username, "user_b");
  });

  test("Case 6b: Tie on rawScore and historyPoints breaks by fewer global open issues", () => {
    const candidateA = {
      username: "user_heavy",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 3,
      stats: { globalOpenAssigned: 3 },
    };
    const candidateB = {
      username: "user_light",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 3,
      stats: { globalOpenAssigned: 1 },
    };

    const sorted = sortCandidates([candidateA, candidateB]);
    assert.equal(sorted[0].username, "user_light");
    assert.equal(sorted[1].username, "user_heavy");
  });

  test("Case 6c: Tie on rawScore, historyPoints, and global open breaks deterministically by username (case-insensitive)", () => {
    const candidateA = {
      username: "charlie",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 3,
      stats: { globalOpenAssigned: 1 },
    };
    const candidateB = {
      username: "Bob",
      rawScore: 8.06,
      score: 8.1,
      historyPoints: 3,
      stats: { globalOpenAssigned: 1 },
    };

    const sorted = sortCandidates([candidateA, candidateB]);
    assert.equal(sorted[0].username, "Bob");
    assert.equal(sorted[1].username, "charlie");
  });

  test("Case 7: Domain alignment cap caps Gemma score 10 to 5 for no-history account", () => {
    const res = scoreCandidate({
      tier: "starter",
      metrics: {
        global_open_assigned: 0,
        repo_open_assigned: 0,
        lifetime_merged_prs: 0,
        languages: [],
        public_repos: 0,
        account_age_days: 0,
        bio: "",
      },
      commentQuality: 10,
      domainAlignment: 10,
    });

    assert.equal(res.breakdown.domainAlignment, POLICY.NO_HISTORY_DOMAIN_CAP);
    assert.ok(res.flags.includes("No public history to verify skills"));
  });
});
