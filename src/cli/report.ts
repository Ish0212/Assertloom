import type { CoverageMetrics, RunResult } from "../runner/index.js";

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 10) / 10}%`;
}

export function formatCoverage(coverage: CoverageMetrics): string {
  return `${pct(coverage.lines)} lines, ${pct(coverage.branches)} branches, ${pct(coverage.functions)} functions`;
}

function firstLines(text: string, count: number): string {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, count)
    .map((line) => `      ${line.trim()}`)
    .join("\n");
}

export function printRunResult(result: RunResult): void {
  const seconds = (result.durationMs / 1000).toFixed(1);

  if (result.infra) {
    console.log(`✗ Jest could not run the tests (${result.infra.kind}, ${result.setup}, ${seconds}s)`);
    console.log(firstLines(result.infra.message, 8));
    return;
  }

  const skipped = result.skipped ? `, ${result.skipped} skipped` : "";
  const mark = result.failed ? "!" : "✓";
  console.log(`${mark} Ran Jest: ${result.passed} passed, ${result.failed} failed${skipped} (${result.setup}, ${seconds}s)`);

  for (const test of result.tests) {
    if (test.status !== "failed" || !test.failure) continue;
    console.log(`  ✗ ${test.suite ? `${test.suite} › ` : ""}${test.name}  [${test.failure.kind}]`);
    console.log(firstLines(test.failure.message, 4));
  }

  if (result.coverage) console.log(`✓ Coverage: ${formatCoverage(result.coverage)}`);
}
