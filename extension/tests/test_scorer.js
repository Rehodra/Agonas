/**
 * extension/tests/test_scorer.js
 * Test suite verifying extension scoring engine matches Python test vectors.
 * Can be run via Node (esm) or loaded in test_runner.html.
 */

import { scoreCandidate } from "../lib/scorer.js";

export function runTests(testVectors) {
  let passed = 0;
  let failed = 0;
  const results = [];

  for (const tc of testVectors) {
    const inputMetrics = {
      globalOpenAssigned: tc.metrics.global_open_assigned,
      repoOpenAssigned:   tc.metrics.repo_open_assigned,
      lifetimeMergedPrs:  tc.metrics.lifetime_merged_prs,
    };

    const actual = scoreCandidate({
      tier:            tc.tier,
      metrics:         inputMetrics,
      commentQuality:  tc.comment_quality,
      domainAlignment: tc.domain_alignment,
    });

    const exp = tc.expected;
    const errors = [];

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

  return { passed, failed, total: testVectors.length, results };
}

// If running directly in Node environment (with fs support)
if (typeof process !== "undefined" && process?.versions?.node) {
  const fs = await import("fs");
  const path = await import("path");
  const url = await import("url");
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(__dirname, "test-vectors.json"), "utf8");
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
