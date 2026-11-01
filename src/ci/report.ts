import { formatUsd } from "../ai/pricing.js";
import { redactSecrets } from "../ai/redact.js";
import type { FileReport } from "./run.js";

export const FAIL_ON = ["never", "errors", "tests"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface CiReport {
  schemaVersion: 1;
  assertloom: string;
  startedAt: string;
  finishedAt: string;
  mode: "pull-request" | "files";
  base?: string;
  head?: string;
  provider: string;
  model: string;
  limits: { maxFiles: number; maxCostUsd: number | null; maxTokens: number | null; maxAttempts: number; timeoutSeconds: number };
  budget: { exhausted: boolean; costKnown: boolean; spentUsd: number | null; tokens: { input: number; output: number } };
  totals: Totals;
  policy: { failOn: FailOn; failed: boolean; reasons: string[] };
  files: FileReport[];
  /** Set when the run stopped before every file was handled. */
  error?: string;
}

export interface Totals {
  files: { changed: number; selected: number; processed: number; skipped: number; failed: number };
  tests: {
    generated: number;
    accepted: number;
    rejected: number;
    initial: { passed: number; failed: number; skipped: number };
    final: { passed: number; failed: number; skipped: number };
    repaired: number;
    flaggedAsSourceBugs: number;
    removed: number;
    gaveUp: number;
  };
  regressions: number;
  infrastructureFailures: number;
  durationMs: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Skip reasons decided after a file passed selection. */
const LATE_SKIPS = new Set(["file-limit", "budget", "no-exported-functions", "preview-exists", "dry-run", "not-processed"]);

export function computeTotals(files: FileReport[]): Totals {
  const ran = files.filter((f) => f.initial && f.final);
  return {
    files: {
      changed: files.length,
      selected: files.filter((f) => f.status !== "skipped" || LATE_SKIPS.has(f.skipReason ?? "")).length,
      processed: files.filter((f) => f.status === "processed").length,
      skipped: files.filter((f) => f.status === "skipped").length,
      failed: files.filter((f) => f.status === "failed").length,
    },
    tests: {
      generated: sum(files.map((f) => f.generated)),
      accepted: sum(files.map((f) => f.accepted)),
      rejected: sum(files.map((f) => f.rejected)),
      initial: {
        passed: sum(ran.map((f) => f.initial!.passed)),
        failed: sum(ran.map((f) => f.initial!.failed)),
        skipped: sum(ran.map((f) => f.initial!.skipped)),
      },
      final: {
        passed: sum(ran.map((f) => f.final!.passed)),
        failed: sum(ran.map((f) => f.final!.failed)),
        skipped: sum(ran.map((f) => f.final!.skipped)),
      },
      repaired: sum(files.map((f) => f.repaired)),
      flaggedAsSourceBugs: sum(files.map((f) => f.flaggedAsSourceBugs)),
      removed: sum(files.map((f) => f.removed)),
      gaveUp: sum(files.map((f) => f.gaveUp)),
    },
    regressions: sum(files.map((f) => f.regressions)),
    infrastructureFailures: files.filter((f) => f.infra).length,
    durationMs: sum(files.map((f) => f.durationMs)),
  };
}

/**
 * `errors`: fail if any selected file could not be processed (generation error, tests that could not run, timeout).
 * `tests`: also fail unless every generated test passes, with none skipped or removed by repair.
 * `never`: only configuration errors fail the run.
 */
export function evaluatePolicy(failOn: FailOn, files: FileReport[]): { failed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (failOn === "never") return { failed: false, reasons };
  const failed = files.filter((f) => f.status === "failed");
  if (failed.length) reasons.push(`${failed.length} file${failed.length === 1 ? "" : "s"} could not be processed`);
  if (failOn === "tests") {
    const notPassing = files.filter(
      (f) => f.status === "processed" && f.final && (f.final.failed > 0 || f.final.skipped > 0 || f.removed > 0 || f.final.status !== "passed"),
    );
    if (notPassing.length) reasons.push(`${notPassing.length} file${notPassing.length === 1 ? "" : "s"} ended with failing, skipped, or removed tests`);
  }
  return { failed: reasons.length > 0, reasons };
}

/**
 * Removes credentials from text that leaves the process (reports, summaries, logs): the exact values of the
 * configured secrets, plus anything that looks like a key or token.
 */
export function createRedactor(secrets: Array<string | undefined>): (text: string) => string {
  const values = [...new Set(secrets.filter((s): s is string => !!s && s.length >= 6))].sort((a, b) => b.length - a.length);
  return (text) => {
    let result = text;
    for (const value of values) result = result.split(value).join("<redacted>");
    return redactSecrets(result).code;
  };
}

/** Escapes untrusted text (file names, error messages) for a Markdown table cell. Not for code spans, which show entities literally. */
export function cell(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>|#!~&]/g, (c) => `&#${c.charCodeAt(0)};`)
    .slice(0, 300);
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? "–" : `${Math.round(value * 10) / 10}%`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const counts = (s?: { passed: number; failed: number; skipped: number }) => (s ? `${s.passed} / ${s.failed} / ${s.skipped}` : "–");

const SKIP_LABELS: Record<string, string> = {
  deleted: "deleted",
  unsupported: "unsupported type",
  excluded: "excluded",
  "not-included": "not included",
  generated: "generated file",
  "not-a-file": "not a regular file",
  "outside-workspace": "outside the repository",
  "too-large": "too large",
  "file-limit": "file limit reached",
  budget: "budget exhausted",
  "no-exported-functions": "no exported functions",
  "preview-exists": "preview file already exists",
  "dry-run": "eligible (dry run)",
  "not-processed": "eligible, not reached",
};

export function renderSummary(report: CiReport): string {
  const t = report.totals;
  const lines: string[] = [];
  const verdict = report.error
    ? "⚠️ Stopped early"
    : report.policy.failed
      ? `❌ Failed (fail-on: ${report.policy.failOn})`
      : `✅ Completed (fail-on: ${report.policy.failOn})`;
  lines.push(`## Assertloom: generated tests for changed files`, "");
  lines.push(`**${verdict}.** Generated tests are previews for review. A completed run does not mean every generated test passed.`, "");
  if (report.error) lines.push(`> **Error:** ${cell(report.error)}`, "");
  for (const reason of report.policy.reasons) lines.push(`- ${cell(reason)}`);
  if (report.policy.reasons.length) lines.push("");
  if (report.budget.exhausted) lines.push("> **Budget exhausted.** The shared spending limit was reached; remaining files were not processed.", "");

  const cost = report.budget.costKnown && report.budget.spentUsd !== null ? `≈${formatUsd(report.budget.spentUsd)}` : "unknown (no price for this model)";
  lines.push(
    "| | |",
    "| --- | --- |",
    `| Files | ${t.files.changed} changed, ${t.files.selected} selected, ${t.files.processed} processed, ${t.files.skipped} skipped, ${t.files.failed} failed |`,
    `| Test cases | ${t.tests.generated} generated, ${t.tests.accepted} accepted, ${t.tests.rejected} rejected by validation |`,
    `| First run (passed / failed / skipped) | ${counts(t.tests.initial)} |`,
    `| Final run (passed / failed / skipped) | ${counts(t.tests.final)} |`,
    `| Repair | repaired: ${t.tests.repaired}; skipped as suspected source bugs: ${t.tests.flaggedAsSourceBugs}; skipped after repair gave up: ${t.tests.gaveUp}; removed: ${t.tests.removed} |`,
    `| Regressions (reverted repair rounds) | ${t.regressions} |`,
    `| Infrastructure failures | ${t.infrastructureFailures} |`,
    `| Runtime | ${seconds(t.durationMs)} |`,
    `| Model | ${report.model ? `${cell(report.model)} (${cell(report.provider)})` : "none (no model was called)"} |`,
    `| Tokens (in / out) | ${report.budget.tokens.input.toLocaleString("en-US")} / ${report.budget.tokens.output.toLocaleString("en-US")} |`,
    `| Estimated cost | ${cost} |`,
    "",
  );

  const evaluated = report.files.filter((f) => f.status !== "skipped" || f.generated > 0);
  if (evaluated.length) {
    lines.push(
      "### Files",
      "",
      "| File | Status | Cases | First run | Final run | Repaired | Skipped / removed | Lines | Branches | Time | Cost |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const f of evaluated) {
      const status = f.status === "processed" ? "processed" : `${f.status}: ${cell(f.detail ?? "")}`;
      const fileCost = f.costUsd === null ? (f.usage.inputTokens + f.usage.outputTokens > 0 ? "unknown" : "–") : formatUsd(f.costUsd);
      lines.push(
        `| ${cell(f.path)} | ${status} | ${f.accepted}/${f.generated} | ${counts(f.initial)} | ${counts(f.final)} | ${f.repaired} | ${f.flaggedAsSourceBugs + f.gaveUp} / ${f.removed} | ${pct(f.final?.coverage?.lines)} | ${pct(f.final?.coverage?.branches)} | ${seconds(f.durationMs)} | ${fileCost} |`,
      );
    }
    lines.push("");
  }

  const skipped = report.files.filter((f) => f.status === "skipped" && f.generated === 0);
  if (skipped.length) {
    lines.push("<details><summary>Skipped files (" + skipped.length + ")</summary>", "", "| File | Reason |", "| --- | --- |");
    for (const f of skipped) lines.push(`| ${cell(f.path)} | ${cell(SKIP_LABELS[f.skipReason ?? ""] ?? f.skipReason ?? "")} |`);
    lines.push("", "</details>", "");
  }

  lines.push(
    "Generated tests, `report.json`, and this summary are in the workflow artifact. Nothing was committed or pushed.",
    "",
  );
  return lines.join("\n");
}
