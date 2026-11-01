import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { estimateCost, type Budget } from "../ai/pricing.js";
import type { LLMProvider, TokenUsage } from "../ai/provider.js";
import { analyzeSource } from "../analyzer/index.js";
import { validateSourceFile } from "../cli/validateFile.js";
import { BudgetExceededError, generateTests, previewPathFor, writeTestFile, type GenerationResult } from "../generator/index.js";
import { repairTests, summarize, type RepairResult } from "../repair/index.js";
import type { RunSummary } from "../repair/repairLoop.js";
import { runJest, type RunResult } from "../runner/index.js";
import type { Candidate, ChangedFile, SkipReason } from "./select.js";

export interface FileReport {
  path: string;
  from?: string;
  change: ChangedFile["status"];
  status: "processed" | "skipped" | "failed";
  skipReason?: SkipReason;
  /** Why the file was skipped or failed. */
  detail?: string;
  generated: number;
  accepted: number;
  rejected: number;
  initial?: RunSummary;
  final?: RunSummary;
  /** Tests that failed on the first run and pass at the end. Skips and removals are counted separately. */
  repaired: number;
  /** Tests the model marked `it.skip` as suspected source bugs. */
  flaggedAsSourceBugs: number;
  /** Tests removed by repair because they could not be made reliable. */
  removed: number;
  /** Tests still failing after repair, kept as `it.skip`. */
  gaveUp: number;
  repairRounds: number;
  /** Repair rounds that broke passing tests and were reverted. */
  regressions: number;
  stopReason?: string;
  infra?: { kind: string; message: string };
  durationMs: number;
  usage: TokenUsage;
  costUsd: number | null;
  /** Path of the generated tests inside the artifact directory. */
  artifact?: string;
}

export interface RunFilesOptions {
  /** Repository root; candidate paths are relative to it. */
  root: string;
  candidates: Candidate[];
  provider: LLMProvider;
  /** One budget shared by every model call in the run. */
  budget: Budget;
  maxFiles: number;
  maxAttempts: number;
  /** Time limit for each Jest run. */
  timeoutMs: number;
  /** Where generated tests are copied for review. */
  testsDir: string;
  /** Called after every file, so partial results survive a crash or cancellation. */
  onProgress?: (files: FileReport[]) => Promise<void>;
  /** For tests: replaces Jest. */
  runTests?: (testPath: string, sourcePath: string) => Promise<RunResult>;
  log?: (line: string) => void;
}

export interface RunFilesResult {
  files: FileReport[];
  budgetExhausted: boolean;
}

const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 });

function emptyReport(candidate: Candidate): FileReport {
  return {
    path: candidate.path,
    ...(candidate.from ? { from: candidate.from } : {}),
    change: candidate.status,
    status: "processed",
    generated: 0,
    accepted: 0,
    rejected: 0,
    repaired: 0,
    flaggedAsSourceBugs: 0,
    removed: 0,
    gaveUp: 0,
    repairRounds: 0,
    regressions: 0,
    durationMs: 0,
    usage: zeroUsage(),
    costUsd: null,
  };
}

const key = (suite: string, name: string) => `${suite}\u0000${name}`;

/** Tests that failed in the first run and pass in the final run. */
export function countRepaired(initial: RunResult, final: RunResult): number {
  const failedAtFirst = new Set(initial.tests.filter((t) => t.status === "failed").map((t) => key(t.suite, t.name)));
  return final.tests.filter((t) => t.status === "passed" && failedAtFirst.has(key(t.suite, t.name))).length;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * Generates, runs, and repairs tests for each eligible file in turn, with one shared budget.
 * Never writes outside generated preview files, which are removed from the tree once copied to `testsDir`.
 */
export async function runFiles(options: RunFilesOptions): Promise<RunFilesResult> {
  const log = options.log ?? (() => {});
  const files: FileReport[] = [];
  let budgetExhausted = false;
  let started = 0;

  for (const candidate of options.candidates) {
    const report = emptyReport(candidate);
    files.push(report);

    if (candidate.skip) {
      Object.assign(report, { status: "skipped", skipReason: candidate.skip.reason, detail: candidate.skip.detail });
      continue;
    }
    if (budgetExhausted) {
      Object.assign(report, { status: "skipped", skipReason: "budget", detail: "the shared spending limit was reached" });
      continue;
    }
    if (started >= options.maxFiles) {
      Object.assign(report, { status: "skipped", skipReason: "file-limit", detail: `max-files (${options.maxFiles}) reached` });
      continue;
    }

    started++;
    log(`${candidate.path} ...`);
    const outcome = await processFile(candidate, report, options);
    if (outcome === "budget") budgetExhausted = true;
    log(`  ${describe(report)}`);
    await options.onProgress?.(files);
  }

  await options.onProgress?.(files);
  return { files, budgetExhausted };
}

function describe(report: FileReport): string {
  if (report.status === "skipped") return `skipped: ${report.detail}`;
  if (report.status === "failed") return `failed: ${report.detail}`;
  const f = report.final!;
  return `${f.passed} passed, ${f.failed} failed, ${f.skipped} skipped`;
}

async function processFile(candidate: Candidate, report: FileReport, options: RunFilesOptions): Promise<"ok" | "budget"> {
  const { budget, provider } = options;
  const startedAt = Date.now();
  const usageBefore = { ...budget.usage };
  const absolute = path.resolve(options.root, candidate.path);
  const previewPath = previewPathFor(absolute);
  let wrotePreview = false;
  let result: "ok" | "budget" = "ok";

  const runTests =
    options.runTests ?? ((testPath: string, sourcePath: string) => runJest({ testPath, sourcePath, timeoutMs: options.timeoutMs }));

  try {
    const source = await validateSourceFile(candidate.path, options.root);
    const analysis = analyzeSource(await readFile(absolute, "utf8"), source);
    if (!analysis.functions.some((f) => f.exported)) {
      Object.assign(report, { status: "skipped", skipReason: "no-exported-functions", detail: "no exported functions to test" });
      return result;
    }
    // Never overwrite a file that is already there, generated or not.
    if (await exists(previewPath)) {
      Object.assign(report, { status: "skipped", skipReason: "preview-exists", detail: `${path.basename(previewPath)} already exists` });
      return result;
    }

    let generation: GenerationResult;
    try {
      generation = await generateTests({ source, provider, budget });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        Object.assign(report, { status: "skipped", skipReason: "budget", detail: "the shared spending limit was reached" });
        return (result = "budget");
      }
      throw error;
    }
    report.accepted = generation.suites.reduce((n, s) => n + s.cases.length, 0);
    report.rejected = generation.rejected.length;
    report.generated = report.accepted + report.rejected;

    await writeTestFile(previewPath, generation.content);
    wrotePreview = true;

    const firstRun = await runTests(previewPath, absolute);
    report.initial = summarize(firstRun);
    let finalRun = firstRun;
    let content = generation.content;
    let repair: RepairResult | undefined;

    if (firstRun.status === "failed" && options.maxAttempts > 0) {
      repair = await repairTests({
        provider,
        analysis: generation.analysis,
        promptSource: generation.promptSource,
        sourcePath: absolute,
        testPath: previewPath,
        extension: source.extension,
        preamble: generation.preamble,
        mockSummary: generation.mocks.summary,
        suites: generation.suites,
        initialRun: firstRun,
        maxAttempts: options.maxAttempts,
        budget,
        runTests: (testPath) => runTests(testPath, absolute),
      });
      finalRun = repair.run;
      content = repair.content;
      const kept = repair.attempts.filter((a) => !a.regressed);
      report.repairRounds = repair.attempts.length;
      report.regressions = repair.attempts.length - kept.length;
      report.flaggedAsSourceBugs = kept.flatMap((a) => a.changes).filter((c) => c.action === "skip").length;
      report.removed = kept.flatMap((a) => a.changes).filter((c) => c.action === "remove").length;
      report.gaveUp = repair.gaveUp.length;
      report.stopReason = repair.stopReason;
      if (repair.stopReason === "budget") result = "budget";
    } else {
      report.stopReason = firstRun.status === "passed" ? "all-passing" : firstRun.status === "failed" ? "not-repaired" : "unrepairable";
    }

    report.final = summarize(finalRun);
    report.repaired = countRepaired(firstRun, finalRun);
    if (finalRun.infra) {
      report.infra = { kind: finalRun.infra.kind, message: firstLine(finalRun.infra.message) };
      Object.assign(report, { status: "failed", detail: `tests could not run (${finalRun.infra.kind})` });
    }

    const artifact = path.join(options.testsDir, path.dirname(candidate.path), path.basename(previewPath));
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, content);
    report.artifact = path.relative(path.dirname(options.testsDir), artifact).split(path.sep).join("/");
  } catch (error) {
    // Keep whatever generation produced, then move on to the next file.
    if (wrotePreview && !report.artifact) await saveArtifact(previewPath, candidate.path, options.testsDir, report);
    Object.assign(report, { status: "failed", detail: firstLine(error instanceof Error ? error.message : String(error)) });
  } finally {
    if (wrotePreview) await rm(previewPath, { force: true });
    report.durationMs = Date.now() - startedAt;
    report.usage = {
      inputTokens: budget.usage.inputTokens - usageBefore.inputTokens,
      outputTokens: budget.usage.outputTokens - usageBefore.outputTokens,
    };
    report.costUsd = estimateCost(budget.model, report.usage) ?? null;
  }
  return result;
}

async function saveArtifact(previewPath: string, relativeSource: string, testsDir: string, report: FileReport): Promise<void> {
  const artifact = path.join(testsDir, path.dirname(relativeSource), path.basename(previewPath));
  try {
    await mkdir(path.dirname(artifact), { recursive: true });
    await copyFile(previewPath, artifact);
    report.artifact = path.relative(path.dirname(testsDir), artifact).split(path.sep).join("/");
  } catch {
    // The preview may not exist any more; the report still records the failure.
  }
}
