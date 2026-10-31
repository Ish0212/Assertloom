import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promptTokens, type Budget } from "../ai/pricing.js";
import { buildRepairPrompt, REPAIR_SYSTEM_PROMPT, type RepairTarget } from "../ai/prompts.js";
import type { LLMProvider, TokenUsage } from "../ai/provider.js";
import { checkBody, renderTestFile, type ValidatedSuite } from "../generator/index.js";
import { runJest, type RunResult, type TestOutcome } from "../runner/index.js";
import type { FileAnalysis, SupportedExtension } from "../types/index.js";
import { classifyTestFailure, type FailureCategory } from "./classifyFailure.js";
import { RepairSchema, type RepairAction } from "./schema.js";

export const MAX_REPAIR_ATTEMPTS = 3;
const MAX_TARGETS_PER_ATTEMPT = 15;
const MAX_OUTPUT_TOKENS = 16_000;

export interface RunSummary {
  status: RunResult["status"];
  passed: number;
  failed: number;
  skipped: number;
  coverage?: RunResult["coverage"];
}

export interface RepairChange {
  functionName: string;
  name: string;
  action: RepairAction | "set-aside" | "gave-up";
  reason: string;
}

export interface RepairAttempt {
  attempt: number;
  before: RunSummary;
  after?: RunSummary;
  requested: number;
  changes: RepairChange[];
  invalid: Array<{ functionName: string; name: string; reason: string }>;
  regressed: boolean;
  usage: TokenUsage;
}

export type StopReason = "all-passing" | "max-attempts" | "regressed" | "no-valid-repairs" | "unrepairable" | "budget";

export interface RepairResult {
  suites: ValidatedSuite[];
  content: string;
  run: RunResult;
  initial: RunSummary;
  final: RunSummary;
  attempts: RepairAttempt[];
  /** Cases marked `it.skip` after the loop because they still failed. */
  gaveUp: RepairChange[];
  stopReason: StopReason;
  /** False if a test run modified the source file; Assertloom restores it. */
  sourceUnchanged: boolean;
  usage: TokenUsage;
}

export interface RepairOptions {
  provider: LLMProvider;
  analysis: FileAnalysis;
  /** Source as sent to the model (secrets redacted). */
  promptSource: string;
  sourcePath: string;
  testPath: string;
  extension: SupportedExtension;
  preamble: string[];
  /** Description of the mocks, as given to the model when generating. */
  mockSummary?: string;
  suites: ValidatedSuite[];
  initialRun: RunResult;
  maxAttempts?: number;
  runTests?: (testPath: string) => Promise<RunResult>;
  /** Let tests open network connections. Off by default. */
  allowNetwork?: boolean;
  budget?: Budget;
}

interface FailingCase {
  suiteIndex: number;
  caseIndex: number;
  outcome: TestOutcome;
  category: FailureCategory;
  repairable: boolean;
}

export function summarize(run: RunResult): RunSummary {
  return { status: run.status, passed: run.passed, failed: run.failed, skipped: run.skipped, coverage: run.coverage };
}

const key = (functionName: string, name: string) => `${functionName}\u0000${name}`;

function cloneSuites(suites: ValidatedSuite[]): ValidatedSuite[] {
  return suites.map((s) => ({ binding: s.binding, cases: s.cases.map((c) => ({ ...c })) }));
}

function outcomesByKey(run: RunResult): Map<string, TestOutcome> {
  return new Map(run.tests.map((t) => [key(t.suite, t.name), t]));
}

function findFailing(suites: ValidatedSuite[], run: RunResult): FailingCase[] {
  const outcomes = outcomesByKey(run);
  const failing: FailingCase[] = [];
  suites.forEach((suite, suiteIndex) =>
    suite.cases.forEach((testCase, caseIndex) => {
      const outcome = outcomes.get(key(suite.binding.binding, testCase.name));
      if (testCase.skipReason || outcome?.status !== "failed") return;
      failing.push({ suiteIndex, caseIndex, outcome, ...classifyTestFailure(outcome) });
    }),
  );
  return failing;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function activeCaseCount(suites: ValidatedSuite[]): number {
  return suites.reduce((n, s) => n + s.cases.filter((c) => !c.skipReason).length, 0);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Repairs failing generated tests in bounded rounds. Only the test file is ever written;
 * a round that breaks a previously passing test is reverted and ends the loop.
 */
export async function repairTests(options: RepairOptions): Promise<RepairResult> {
  if (path.resolve(options.testPath) === path.resolve(options.sourcePath)) {
    throw new Error("Refusing to repair: the test path is the source file.");
  }
  const maxAttempts = Math.max(0, Math.min(options.maxAttempts ?? MAX_REPAIR_ATTEMPTS, MAX_REPAIR_ATTEMPTS));
  const runTests =
    options.runTests ?? ((testPath: string) => runJest({ testPath, sourcePath: options.sourcePath, allowNetwork: options.allowNetwork }));
  const originalSource = await readFile(options.sourcePath, "utf8");
  const originalHash = sha256(originalSource);

  const render = (suites: ValidatedSuite[]) =>
    renderTestFile({
      sourceFile: options.analysis.file,
      preamble: options.preamble,
      suites,
      extension: options.extension,
    });

  let suites = cloneSuites(options.suites);
  let content = render(suites);
  let run = options.initialRun;
  const attempts: RepairAttempt[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason | undefined;

  while (!stopReason && attempts.length < maxAttempts) {
    if (run.infra) {
      stopReason = "unrepairable";
      break;
    }

    const failing = findFailing(suites, run);
    if (failing.length === 0) {
      stopReason = "all-passing";
      break;
    }

    const targets = failing.filter((f) => f.repairable).slice(0, MAX_TARGETS_PER_ATTEMPT);
    if (targets.length === 0) {
      stopReason = "unrepairable";
      break;
    }

    const repairTargets: RepairTarget[] = targets.map((t) => {
      const suite = suites[t.suiteIndex];
      const testCase = suite.cases[t.caseIndex];
      return {
        binding: suite.binding,
        testName: testCase.name,
        body: testCase.body,
        failureCategory: t.category,
        message: t.outcome.failure?.message ?? "",
      };
    });

    const prompt = buildRepairPrompt({
      analysis: options.analysis,
      code: options.promptSource,
      targets: repairTargets,
      attempt: attempts.length + 1,
      mockSummary: options.mockSummary,
    });
    if (options.budget && !options.budget.allows({ inputTokens: promptTokens(REPAIR_SYSTEM_PROMPT, prompt), outputTokens: MAX_OUTPUT_TOKENS })) {
      stopReason = "budget";
      break;
    }

    const attempt: RepairAttempt = {
      attempt: attempts.length + 1,
      before: summarize(run),
      requested: targets.length,
      changes: [],
      invalid: [],
      regressed: false,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    attempts.push(attempt);

    const response = await options.provider.generateStructured({
      system: REPAIR_SYSTEM_PROMPT,
      prompt,
      schema: RepairSchema,
      schemaName: "assertloom_repairs",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    options.budget?.add(response.usage);
    attempt.usage = response.usage;
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;

    const proposals = new Map(response.data.repairs.map((r) => [key(r.functionName, r.name), r]));
    const candidate = cloneSuites(suites);
    const removals: Array<{ suiteIndex: number; caseIndex: number }> = [];

    for (const target of targets) {
      const suite = candidate[target.suiteIndex];
      const testCase = suite.cases[target.caseIndex];
      const functionName = suite.binding.binding;
      const proposal = proposals.get(key(functionName, testCase.name));
      const invalid = (reason: string) => attempt.invalid.push({ functionName, name: testCase.name, reason });

      if (!proposal) {
        invalid("no repair returned");
        continue;
      }

      if (proposal.action === "fix") {
        const check = checkBody(proposal.body, options.extension, new Set(suites.map((s) => s.binding.binding)));
        if ("error" in check) {
          invalid(`proposed body ${check.error}`);
          continue;
        }
        if (proposal.body.trim() === testCase.body.trim()) {
          invalid("proposed body is unchanged");
          continue;
        }
        testCase.body = proposal.body.trim();
        testCase.async = check.async;
      } else if (proposal.action === "skip") {
        testCase.skipReason = `suspected bug in the source: ${proposal.reason}`;
      } else {
        removals.push({ suiteIndex: target.suiteIndex, caseIndex: target.caseIndex });
      }
      attempt.changes.push({ functionName, name: testCase.name, action: proposal.action, reason: proposal.reason });
    }

    for (const { suiteIndex, caseIndex } of removals.sort((a, b) => b.caseIndex - a.caseIndex)) {
      candidate[suiteIndex].cases.splice(caseIndex, 1);
    }
    const nonEmpty = candidate.filter((s) => s.cases.length > 0);

    if (attempt.changes.length === 0 || activeCaseCount(nonEmpty) === 0) {
      stopReason = "no-valid-repairs";
      break;
    }

    const candidateContent = render(nonEmpty);
    await writeFile(options.testPath, candidateContent, "utf8");
    const candidateRun = await runTests(options.testPath);
    attempt.after = summarize(candidateRun);

    const before = outcomesByKey(run);
    const after = outcomesByKey(candidateRun);
    const brokeAPassingTest = [...before].some(
      ([testKey, outcome]) => outcome.status === "passed" && after.get(testKey)?.status === "failed",
    );

    if (candidateRun.infra || brokeAPassingTest) {
      attempt.regressed = true;
      await writeFile(options.testPath, content, "utf8");
      stopReason = "regressed";
      break;
    }

    suites = nonEmpty;
    content = candidateContent;
    run = candidateRun;
  }

  const gaveUp: RepairChange[] = [];
  if (!run.infra) {
    const remaining = findFailing(suites, run);
    if (remaining.length > 0) {
      for (const f of remaining) {
        const testCase = suites[f.suiteIndex].cases[f.caseIndex];
        const reason =
          f.category === "mock"
            ? "opens a real network connection; mock the dependency (--mock <module>) or rerun with --allow-network"
            : `still failing after repair (${f.category}): ${firstLine(f.outcome.failure?.message ?? "")}`;
        testCase.skipReason = reason;
        gaveUp.push({ functionName: suites[f.suiteIndex].binding.binding, name: testCase.name, action: "gave-up", reason });
      }
      content = render(suites);
      await writeFile(options.testPath, content, "utf8");
      run = await runTests(options.testPath);
    }
  }

  stopReason ??= findFailing(suites, run).length || gaveUp.length ? "max-attempts" : "all-passing";

  const currentSource = await readFile(options.sourcePath, "utf8");
  const sourceUnchanged = sha256(currentSource) === originalHash;
  if (!sourceUnchanged) await writeFile(options.sourcePath, originalSource, "utf8");

  return {
    suites,
    content,
    run,
    initial: summarize(options.initialRun),
    final: summarize(run),
    attempts,
    gaveUp,
    stopReason,
    sourceUnchanged,
    usage,
  };
}