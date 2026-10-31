import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Budget } from "../src/ai/pricing.js";
import { buildRepairPrompt, MAX_FAILURE_MESSAGE_CHARS, REPAIR_SYSTEM_PROMPT } from "../src/ai/prompts.js";
import { analyzeFile } from "../src/analyzer/index.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests, writeTestFile, type ValidatedSuite } from "../src/generator/index.js";
import { planImports } from "../src/generator/importPlan.js";
import { classifyInfraFailure, classifyTestFailure, repairTests } from "../src/repair/index.js";
import type { RepairResponse } from "../src/repair/schema.js";
import { runJest, type RunResult, type TestOutcome } from "../src/runner/index.js";
import { initialGeneration, repairAttemptOf, repairsByAttempt } from "../fixtures/repair/scenario.js";
import { FakeProvider } from "./helpers/fakeProvider.js";

const root = path.resolve(import.meta.dirname, "..");

type Status = TestOutcome["status"];

function runOf(tests: Array<[suite: string, name: string, status: Status, message?: string]>): RunResult {
  const outcomes: TestOutcome[] = tests.map(([suite, name, status, message]) => ({
    suite,
    name,
    status,
    ...(status === "failed" ? { failure: { kind: "assertion" as const, message: message ?? "Expected: 1\nReceived: 2" } } : {}),
  }));
  const count = (s: Status) => outcomes.filter((t) => t.status === s).length;
  return {
    status: count("failed") ? "failed" : "passed",
    tests: outcomes,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    total: outcomes.length,
    durationMs: 1,
    setup: "fake",
  };
}

/** Returns the queued results in order, recording the test file content seen by each run. */
function scriptedRunner(results: RunResult[]) {
  const seen: string[] = [];
  const run = async (testPath: string) => {
    seen.push(await readFile(testPath, "utf8"));
    const next = results.shift();
    if (!next) throw new Error("runner called more times than scripted");
    return next;
  };
  return { run, seen };
}

const repairs = (...items: RepairResponse["repairs"]): RepairResponse => ({ repairs: items });

describe("failure classification", () => {
  const failed = (kind: "assertion" | "error" | "timeout", message: string): TestOutcome => ({
    suite: "f",
    name: "t",
    status: "failed",
    failure: { kind, message },
  });

  it("sorts test failures into repair categories", () => {
    expect(classifyTestFailure(failed("assertion", "Expected: 1\nReceived: 2"))).toEqual({ category: "assertion", repairable: true });
    expect(classifyTestFailure(failed("error", "ReferenceError: x is not defined"))).toEqual({ category: "runtime", repairable: true });
    expect(classifyTestFailure(failed("timeout", "Exceeded timeout of 5000 ms"))).toEqual({ category: "timeout", repairable: true });
    expect(classifyTestFailure(failed("error", "TypeError: fetch failed\n[cause]: connect ECONNREFUSED"))).toEqual({ category: "mock", repairable: false });
    expect(classifyTestFailure(failed("error", "Cannot find module './db'"))).toEqual({ category: "import", repairable: false });
  });

  it("treats failures involving Assertloom's own mocks as repairable test bugs", () => {
    const callMismatch = 'expect(jest.fn()).toHaveBeenCalledWith(...expected)\nExpected: "/app/settings.json"\nReceived: "\\\\app\\\\settings.json"';
    expect(classifyTestFailure(failed("assertion", callMismatch))).toEqual({ category: "assertion", repairable: true });
    expect(classifyTestFailure(failed("error", "TypeError: Cannot read properties of undefined (reading 'rows')"))).toEqual({
      category: "runtime",
      repairable: true,
    });
  });

  it("treats whole-file failures as import or configuration problems", () => {
    expect(classifyInfraFailure({ kind: "module-not-found", message: "" })).toEqual({ category: "import", repairable: false });
    expect(classifyInfraFailure({ kind: "transform", message: "" })).toEqual({ category: "configuration", repairable: false });
    expect(classifyInfraFailure({ kind: "timeout", message: "" })).toEqual({ category: "configuration", repairable: false });
  });
});

describe("repairTests (scripted runner)", () => {
  let dir: string;
  let sourcePath: string;
  let testPath: string;
  let base: Omit<Parameters<typeof repairTests>[0], "provider" | "initialRun" | "runTests">;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-repair-"));
    sourcePath = path.join(dir, "math.ts");
    testPath = path.join(dir, "math.test.preview.ts");
    await copyFile(path.join(root, "examples", "math.ts"), sourcePath);

    const source = await validateSourceFile(sourcePath);
    const analysis = await analyzeFile(source);
    const plan = planImports(analysis, analysis.functions, sourcePath, testPath);
    const suites: ValidatedSuite[] = [
      { binding: plan.bindings[0], cases: [{ name: "A", category: "normal", body: "expect(add(1, 1)).toBe(2);", async: false }] },
      { binding: plan.bindings[1], cases: [{ name: "B", category: "normal", body: "expect(divide(4, 2)).toBe(3);", async: false }] },
    ];
    base = { analysis, promptSource: "SOURCE", sourcePath, testPath, extension: ".ts", preamble: plan.statements, suites };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fixB = repairs({ functionName: "divide", name: "B", action: "fix", body: "expect(divide(4, 2)).toBe(2);", reason: "4 / 2 is 2." });

  it("fixes a failing test in one attempt", async () => {
    const provider = new FakeProvider(fixB);
    const runner = scriptedRunner([runOf([["add", "A", "passed"], ["divide", "B", "passed"]])]);

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests: runner.run });

    expect(result.stopReason).toBe("all-passing");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ requested: 1, regressed: false, before: { passed: 1, failed: 1 }, after: { passed: 2, failed: 0 } });
    expect(result.content).toContain("expect(divide(4, 2)).toBe(2);");
    expect(await readFile(testPath, "utf8")).toBe(result.content);
    expect(provider.requests[0].system).toBe(REPAIR_SYSTEM_PROMPT);
  });

  it("reverts an attempt that breaks a passing test and stops", async () => {
    const provider = new FakeProvider(fixB);
    const runner = scriptedRunner([
      runOf([["add", "A", "failed"], ["divide", "B", "passed"]]),
      runOf([["add", "A", "passed"], ["divide", "B", "skipped"]]),
    ]);

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests: runner.run });

    expect(result.stopReason).toBe("regressed");
    expect(result.attempts[0].regressed).toBe(true);
    expect(result.content).toContain("expect(divide(4, 2)).toBe(3);");
    expect(result.content).toContain('it.skip("B"');
    expect(result.gaveUp).toEqual([
      { functionName: "divide", name: "B", action: "gave-up", reason: "still failing after repair (assertion): Expected: 1" },
    ]);
    expect(result.final).toMatchObject({ passed: 1, failed: 0, skipped: 1 });
  });

  it("stops after three attempts and skips what is still failing", async () => {
    const provider = new FakeProvider(fixB);
    const stillFailing = () => runOf([["add", "A", "passed"], ["divide", "B", "failed"]]);
    const runner = scriptedRunner([stillFailing(), stillFailing(), stillFailing(), runOf([["add", "A", "passed"], ["divide", "B", "skipped"]])]);

    const result = await repairTests({ ...base, provider, initialRun: stillFailing(), runTests: runner.run, maxAttempts: 10 });

    expect(provider.requests).toHaveLength(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.stopReason).toBe("max-attempts");
    expect(result.final.skipped).toBe(1);
  });

  it("stops before a repair call that could pass the spending limit", async () => {
    const provider = new FakeProvider(fixB);
    const runner = scriptedRunner([runOf([["add", "A", "passed"], ["divide", "B", "skipped"]])]);
    const budget = new Budget("gpt-5.4-mini", 0.05);

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests: runner.run, budget });

    expect(provider.requests).toHaveLength(0);
    expect(result.stopReason).toBe("budget");
    expect(result.attempts).toHaveLength(0);
    expect(result.final.skipped).toBe(1);
  });

  it("ignores proposals that fail validation", async () => {
    const provider = new FakeProvider(repairs({ functionName: "divide", name: "B", action: "fix", body: "divide(4, 2);", reason: "no expect" }));
    const runner = scriptedRunner([runOf([["add", "A", "passed"], ["divide", "B", "skipped"]])]);

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests: runner.run });

    expect(result.stopReason).toBe("no-valid-repairs");
    expect(result.attempts[0].invalid).toEqual([{ functionName: "divide", name: "B", reason: "proposed body does not call expect()" }]);
    expect(runner.seen).toHaveLength(1);
  });

  it("removes tests the model says cannot be made reliable", async () => {
    const provider = new FakeProvider(repairs({ functionName: "divide", name: "B", action: "remove", body: "", reason: "flaky" }));
    const runner = scriptedRunner([runOf([["add", "A", "passed"]])]);

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests: runner.run });

    expect(result.stopReason).toBe("all-passing");
    expect(result.content).not.toContain('"B"');
    expect(result.content).not.toContain('describe("divide"');
  });

  it("does not call the model when the file could not run", async () => {
    const provider = new FakeProvider(fixB);
    const initialRun: RunResult = { ...runOf([]), status: "error", infra: { kind: "module-not-found", message: "Cannot find module" } };

    const result = await repairTests({ ...base, provider, initialRun, runTests: scriptedRunner([]).run });

    expect(result.stopReason).toBe("unrepairable");
    expect(provider.requests).toHaveLength(0);
  });

  it("restores the source file if a test run modifies it", async () => {
    const provider = new FakeProvider(fixB);
    const original = await readFile(sourcePath, "utf8");
    const runTests = async () => {
      await writeFile(sourcePath, "export const hacked = true;\n");
      return runOf([["add", "A", "passed"], ["divide", "B", "passed"]]);
    };

    const result = await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed"]]), runTests });

    expect(result.sourceUnchanged).toBe(false);
    expect(await readFile(sourcePath, "utf8")).toBe(original);
  });

  it("refuses to treat the source file as the test file", async () => {
    const provider = new FakeProvider(fixB);

    await expect(
      repairTests({ ...base, testPath: sourcePath, provider, initialRun: runOf([["divide", "B", "failed"]]), runTests: scriptedRunner([]).run }),
    ).rejects.toThrow(/test path is the source file/);
  });

  it("sends bounded failure context", async () => {
    const provider = new FakeProvider(fixB);
    const longMessage = `Expected: 3\nReceived: 2\n${"x".repeat(5000)}`;
    const runner = scriptedRunner([runOf([["add", "A", "passed"], ["divide", "B", "passed"]])]);

    await repairTests({ ...base, provider, initialRun: runOf([["add", "A", "passed"], ["divide", "B", "failed", longMessage]]), runTests: runner.run });
    const prompt = provider.requests[0].prompt;

    expect(prompt).toContain("Repair attempt 1: 1 generated test");
    expect(prompt).toContain("`divide` › \"B\"");
    expect(prompt).toContain("expect(divide(4, 2)).toBe(3);");
    expect(prompt).toContain("…(truncated)");
    expect(prompt).not.toContain("x".repeat(MAX_FAILURE_MESSAGE_CHARS));
    expect(prompt).not.toContain('"A"');
  });

  it("builds a prompt that marks the source as read-only", () => {
    const prompt = buildRepairPrompt({ analysis: base.analysis, code: "SOURCE", targets: [], attempt: 2 });

    expect(prompt).toContain("(read-only)");
    expect(REPAIR_SYSTEM_PROMPT).toContain("You cannot change the source code");
  });
});

describe("documented repair scenario (real Jest)", { timeout: 300_000 }, () => {
  it("repairs the intentionally failing tests in fixtures/repair without editing the source", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-scenario-"));
    try {
      const sourcePath = path.join(dir, "pricing.ts");
      await copyFile(path.join(root, "fixtures", "repair", "pricing.ts"), sourcePath);
      const originalSource = await readFile(sourcePath, "utf8");

      const provider = new FakeProvider((request) =>
        request.schemaName === "assertloom_tests" ? initialGeneration : repairsByAttempt[repairAttemptOf(request.prompt)],
      );
      const source = await validateSourceFile(sourcePath);
      const generated = await generateTests({ source, provider });
      await writeTestFile(generated.testPath, generated.content);
      const initialRun = await runJest({ testPath: generated.testPath, sourcePath });

      expect(initialRun).toMatchObject({ status: "failed", passed: 3, failed: 7 });

      const result = await repairTests({
        provider,
        analysis: generated.analysis,
        promptSource: generated.promptSource,
        sourcePath,
        testPath: generated.testPath,
        extension: source.extension,
        preamble: generated.preamble,
        mockSummary: generated.mocks.summary,
        suites: generated.suites,
        initialRun,
      });

      expect(result.attempts.map((a) => [a.requested, a.changes.length, a.invalid.length, a.after?.passed, a.regressed])).toEqual([
        [7, 6, 1, 8, false],
        [1, 1, 0, 9, false],
      ]);
      expect(result.attempts[0].changes.find((c) => c.name === "returns 0 for an empty list")?.action).toBe("skip");
      expect(result.gaveUp).toEqual([]);
      expect(result.stopReason).toBe("all-passing");
      expect(result.final).toMatchObject({ status: "passed", passed: 9, failed: 0, skipped: 1 });
      expect(result.content).toContain("globalThis.fetch = jest.fn() as unknown as typeof fetch;");
      expect(provider.requests[1].prompt).toContain("global `fetch` is a jest.fn() mock");
      expect(result.content).toContain("// Assertloom skipped this test: suspected bug in the source: average([]) divides by zero");
      expect(result.content).toContain('it("doubles a number", async () => {');
      expect(result.sourceUnchanged).toBe(true);
      expect(await readFile(sourcePath, "utf8")).toBe(originalSource);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
