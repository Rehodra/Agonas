/**
 * extension/tests/test_scorer.js
 * Standalone test runner verifying extension scoring engine against scoring-vectors.json.
 * Executable directly via: node extension/tests/test_scorer.js
 */

import { scoreCandidate, sortCandidates, computeHistoryPoints, POLICY } from "../lib/scorer.js";

export function runTests(testVectors) {
  let passed = 0;
  let failed = 0;
  const results = [];

  for (const tc of testVectors) {
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
    const errors = [];

    if (Math.abs(actual.rawScore - exp.rawScore) > 0.05) {
      errors.push(`rawScore: actual ${actual.rawScore} != expected ${exp.rawScore}`);
    }
    if (Math.abs(actual.score - exp.score) > 0.05) {
      errors.push(`score: actual ${actual.score} != expected ${exp.score}`);
    }
    if (actual.risk !== exp.risk) {
      errors.push(`risk: actual ${actual.risk} != expected ${exp.risk}`);
    }

    const actualFlags = (actual.flags || []).slice().sort();
    const expFlags = (exp.flags || []).slice().sort();
    if (JSON.stringify(actualFlags) !== JSON.stringify(expFlags)) {
      errors.push(`flags: actual ${JSON.stringify(actualFlags)} != expected ${JSON.stringify(expFlags)}`);
    }

    if (errors.length === 0) {
      passed++;
      results.push({ name: tc.name, status: "PASS" });
    } else {
      failed++;
      results.push({ name: tc.name, status: "FAIL", errors });
    }
  }

  // Also test ranking & tie breaking
  const rankingTests = [
    {
      name: "ordering_higher_raw_first",
      test: () => {
        const sorted = sortCandidates([
          { username: "bob", rawScore: 10.35, historyPoints: 2, stats: { globalOpenAssigned: 0 } },
          { username: "alice", rawScore: 11.12, historyPoints: 3, stats: { globalOpenAssigned: 2 } },
        ]);
        return sorted[0].username === "alice";
      },
    },
    {
      name: "tie_break_history_points",
      test: () => {
        const sorted = sortCandidates([
          { username: "b", rawScore: 8.0, historyPoints: 1, stats: { globalOpenAssigned: 1 } },
          { username: "a", rawScore: 8.0, historyPoints: 3, stats: { globalOpenAssigned: 2 } },
        ]);
        return sorted[0].username === "a";
      },
    },
    {
      name: "tie_break_fewer_global_open",
      test: () => {
        const sorted = sortCandidates([
          { username: "b", rawScore: 8.0, historyPoints: 2, stats: { globalOpenAssigned: 3 } },
          { username: "a", rawScore: 8.0, historyPoints: 2, stats: { globalOpenAssigned: 1 } },
        ]);
        return sorted[0].username === "a";
      },
    },
    {
      name: "tie_break_username_case_insensitive",
      test: () => {
        const sorted = sortCandidates([
          { username: "charlie", rawScore: 8.0, historyPoints: 2, stats: { globalOpenAssigned: 1 } },
          { username: "Bob", rawScore: 8.0, historyPoints: 2, stats: { globalOpenAssigned: 1 } },
        ]);
        return sorted[0].username === "Bob";
      },
    },
  ];

  for (const rt of rankingTests) {
    if (rt.test()) {
      passed++;
      results.push({ name: rt.name, status: "PASS" });
    } else {
      failed++;
      results.push({ name: rt.name, status: "FAIL", errors: ["Sorting assertion failed"] });
    }
  }

  return { passed, failed, total: testVectors.length + rankingTests.length, results };
}

// If running directly in Node environment
if (typeof process !== "undefined" && process?.versions?.node) {
  const fs = await import("fs");
  const path = await import("path");
  const url = await import("url");
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(__dirname, "scoring-vectors.json"), "utf8");
  const vectors = JSON.parse(raw);
  const summary = runTests(vectors);

  console.log(`\n=== Agonas JS Scoring Test Suite ===`);
  for (const r of summary.results) {
    if (r.status === "PASS") {
      console.log(`✓ ${r.name}`);
    } else {
      console.error(`✗ ${r.name}: ${r.errors.join(", ")}`);
    }
  }
  console.log(`\nSummary: ${summary.passed}/${summary.total} passed (${summary.failed} failed).\n`);
  if (summary.failed > 0) {
    process.exit(1);
  }
}
