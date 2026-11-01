import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Budget } from "../src/ai/pricing.js";
import type { LLMProvider, StructuredRequest, StructuredResponse } from "../src/ai/provider.js";
import { computeTotals, createRedactor, evaluatePolicy, renderSummary, type CiReport } from "../src/ci/report.js";
import { countRepaired, runFiles, type FileReport } from "../src/ci/run.js";
import { changedFiles, checkRef, classify, globToRegExp, parseNameStatus, SelectionError, type Candidate } from "../src/ci/select.js";
import { registerCiCommand, runCi, type CiCommandOptions, type CiDependencies } from "../src/cli/commands/ci.js";
import type { RunResult, TestOutcome } from "../src/runner/index.js";
import { makeConsumer, UNUSUAL_NAME } from "../fixtures/ci/makeConsumer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const SECRET = "sk-test-0123456789abcdefghijklmnop";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A provider that answers from a function and reports a fixed token usage per call. */
class ScriptedProvider implements LLMProvider {
  readonly name = "fake";
  readonly requests: StructuredRequest<unknown>[] = [];
  constructor(
    private readonly respond: (request: StructuredRequest<unknown>) => unknown,
    readonly model = "fake-model",
    private readonly usage = { inputTokens: 100, outputTokens: 50 },
  ) {}
  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    const data = request.schema.parse(this.respond(request as StructuredRequest<unknown>));
    return { data, model: this.model, usage: this.usage };
  }
}

const isRepair = (r: StructuredRequest<unknown>) => r.schemaName !== "assertloom_tests";

/** Test cases for the fixture's source files, chosen by the function names in the prompt. One pricing test is wrong on purpose. */
function fixtureGeneration(prompt: string) {
  if (prompt.includes("applyDiscount")) {
    return {
      suites: [
        {
          functionName: "applyDiscount",
          cases: [
            { name: "applies a discount", category: "normal", body: "expect(applyDiscount(100, 10)).toBe(91);" },
            { name: "rejects negative percentages", category: "error", body: "expect(() => applyDiscount(100, -1)).toThrow(RangeError);" },
          ],
        },
        { functionName: "formatPrice", cases: [{ name: "formats cents", category: "normal", body: 'expect(formatPrice(1250)).toBe("$12.50");' }] },
      ],
    };
  }
  if (prompt.includes("addTax")) {
    return { suites: [{ functionName: "addTax", cases: [{ name: "adds tax", category: "normal", body: "expect(addTax(100, 0.2)).toBe(120);" }] }] };
  }
  return {
    suites: [{ functionName: "slugify", cases: [{ name: "joins words", category: "normal", body: 'expect(slugify(" Hello World ")).toBe("hello-world");' }] }],
  };
}

function fixtureRepair() {
  return {
    repairs: [{ functionName: "applyDiscount", name: "applies a discount", action: "fix", body: "expect(applyDiscount(100, 10)).toBe(90);", reason: "10% off 100 is 90." }],
  };
}

function runOf(tests: Array<[suite: string, name: string, status: TestOutcome["status"]]>, extra: Partial<RunResult> = {}): RunResult {
  const outcomes: TestOutcome[] = tests.map(([suite, name, status]) => ({
    suite,
    name,
    status,
    ...(status === "failed" ? { failure: { kind: "assertion" as const, message: "Expected: 1\nReceived: 2" } } : {}),
  }));
  const count = (s: TestOutcome["status"]) => outcomes.filter((t) => t.status === s).length;
  return {
    status: count("failed") ? "failed" : "passed",
    tests: outcomes,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    total: outcomes.length,
    durationMs: 1,
    setup: "fake",
    coverage: { lines: 80, statements: 80, functions: 100, branches: 50 },
    ...extra,
  };
}

/** Every test in the generated file passes, except names listed in `failing` on the first run of each file. */
function fakeRunner(failing: string[] = []) {
  const runs = new Map<string, number>();
  return async (testPath: string): Promise<RunResult> => {
    const n = (runs.get(testPath) ?? 0) + 1;
    runs.set(testPath, n);
    const content = await readFile(testPath, "utf8");
    const tests: Array<[string, string, TestOutcome["status"]]> = [];
    let suite = "";
    for (const line of content.split("\n")) {
      const d = /^describe\(("(?:[^"\\]|\\.)*")/.exec(line);
      if (d) suite = JSON.parse(d[1]);
      const t = /^\s+it(\.skip)?\(("(?:[^"\\]|\\.)*")/.exec(line);
      if (t) {
        const name = JSON.parse(t[2]);
        tests.push([suite, name, t[1] ? "skipped" : n === 1 && failing.includes(name) ? "failed" : "passed"]);
      }
    }
    return runOf(tests);
  };
}

const baseOptions = (overrides: Partial<CiCommandOptions>): CiCommandOptions => ({
  defaultExcludes: true,
  maxFiles: "10",
  maxCost: "1",
  maxAttempts: "3",
  timeout: "120",
  out: "",
  failOn: "errors",
  provider: "openai",
  ...overrides,
});

let repo: string;
let shas: { base: string; head: string };
const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-ci-"));
  temps.push(dir);
  return dir;
}

beforeAll(async () => {
  repo = path.join(await tempDir(), "consumer");
  shas = makeConsumer(repo);
});

afterAll(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

describe("changed-file selection", () => {
  it("parses NUL-separated name-status output, including renames and file names with newlines and quotes", () => {
    const output = ["M", "src/a.ts", "R087", "src/old name.js", 'src/new "name"\n.js', "D", "src/gone.js", "A", "src/$(x).ts", ""].join("\0");
    expect(parseNameStatus(output)).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: 'src/new "name"\n.js', status: "renamed", from: "src/old name.js" },
      { path: "src/gone.js", status: "deleted" },
      { path: "src/$(x).ts", status: "added" },
    ]);
  });

  it("matches globs", () => {
    expect(globToRegExp("**/*.test.*").test("src/a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.*").test("a.test.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("lib/a.ts")).toBe(false);
    expect(globToRegExp("*.min.js").test("vendor/x/app.min.js")).toBe(true);
    expect(globToRegExp("src/*.{ts,js}").test("src/a.js")).toBe(true);
    expect(globToRegExp("src/*.{ts,js}").test("src/deep/a.js")).toBe(false);
    expect(globToRegExp("**/dist/**").test("dist/bundle.js")).toBe(true);
  });

  it("rejects refs that git could read as options or ranges", () => {
    for (const ref of ["--output=/tmp/x", "-p", "a..b", "$(id)", "main;rm", ""]) expect(() => checkRef(ref, "Base")).toThrow(SelectionError);
    expect(checkRef("a".repeat(40), "Base")).toBe("a".repeat(40));
    expect(checkRef("origin/main", "Base")).toBe("origin/main");
  });

  it("selects added, modified, and renamed files and reports the rest with reasons", async () => {
    const files = await changedFiles({ cwd: repo, base: shas.base });
    const candidates = await classify(files, { root: repo, include: [], exclude: [], useDefaultExcludes: true });
    const byPath = Object.fromEntries(candidates.map((c) => [c.path, c]));

    expect(candidates.filter((c) => !c.skip).map((c) => c.path)).toEqual(["src/constants.js", "src/pricing.js", UNUSUAL_NAME, "src/text/slug helper.js"]);
    expect(byPath["src/text/slug helper.js"]).toMatchObject({ status: "renamed", from: "src/slug.js" });
    expect(byPath[UNUSUAL_NAME]).toMatchObject({ status: "added" });
    expect(byPath["src/legacy.js"].skip?.reason).toBe("deleted");
    expect(byPath["src/pricing.test.js"].skip?.reason).toBe("excluded");
    expect(byPath["src/types.d.ts"].skip?.reason).toBe("excluded");
    expect(byPath["dist/bundle.js"].skip?.reason).toBe("excluded");
    expect(byPath["src/schema.generated.js"].skip?.reason).toBe("excluded");
    expect(byPath["src/client.js"].skip?.reason).toBe("generated");
    expect(byPath["notes.md"].skip?.reason).toBe("unsupported");
  });

  it("applies include and exclude patterns", async () => {
    const files = await changedFiles({ cwd: repo, base: shas.base });
    const candidates = await classify(files, { root: repo, include: ["src/text/**", "src/pricing.js"], exclude: ["src/text/**"], useDefaultExcludes: true });
    expect(candidates.filter((c) => !c.skip).map((c) => c.path)).toEqual(["src/pricing.js"]);
    expect(candidates.find((c) => c.path === "src/text/slug helper.js")?.skip?.reason).toBe("excluded");
    expect(candidates.find((c) => c.path === "src/constants.js")?.skip?.reason).toBe("not-included");
  });

  it("explains how to fix a missing base commit", async () => {
    await expect(changedFiles({ cwd: repo, base: "0123456789abcdef0123456789abcdef01234567" })).rejects.toThrow(/fetch-depth: 0/);
  });

  it("detects a shallow checkout where the base commit is unavailable", async () => {
    const shallow = path.join(await tempDir(), "shallow");
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "feature", `file://${repo.split(path.sep).join("/")}`, shallow]);
    await expect(changedFiles({ cwd: shallow, base: shas.base })).rejects.toThrow(/shallow clone[\s\S]*fetch-depth: 0/);
  });

  it("skips paths outside the repository and symbolic links", async () => {
    const candidates = await classify(
      [
        { path: "../outside.js", status: "explicit" },
        { path: "src/missing.js", status: "explicit" },
      ],
      { root: repo, include: [], exclude: [], useDefaultExcludes: true },
    );
    expect(candidates.map((c) => c.skip?.reason)).toEqual(["outside-workspace", "not-a-file"]);
  });
});

describe("shared budget", () => {
  async function candidatesFor(paths: string[]): Promise<Candidate[]> {
    return classify(
      paths.map((p) => ({ path: p, status: "modified" as const })),
      { root: repo, include: [], exclude: [], useDefaultExcludes: true },
    );
  }

  it("charges generation and repair calls of every file to one limit, then stops starting new files", async () => {
    // Each call reports 20,000 tokens. Worst cases checked before calls: generation 32,000 output, repair 16,000 output.
    const provider = new ScriptedProvider((r) => (isRepair(r) ? fixtureRepair() : fixtureGeneration(r.prompt)), "fake-model", {
      inputTokens: 15_000,
      outputTokens: 5_000,
    });
    const budget = new Budget(provider.model, 1, 60_000);
    const testsDir = path.join(await tempDir(), "tests");
    const candidates = await candidatesFor(["src/pricing.js", UNUSUAL_NAME, "src/text/slug helper.js"]);

    const { files, budgetExhausted } = await runFiles({
      root: repo,
      candidates,
      provider,
      budget,
      maxFiles: 10,
      maxAttempts: 3,
      timeoutMs: 10_000,
      testsDir,
      runTests: fakeRunner(["applies a discount"]),
    });

    // pricing.js: generation (20k) + one repair round (20k). The next generation could reach 40k + prompt + 32k > 60k.
    expect(provider.requests.map((r) => (isRepair(r) ? "repair" : "generate"))).toEqual(["generate", "repair"]);
    expect(budgetExhausted).toBe(true);
    const pricing = files.find((f) => f.path === "src/pricing.js")!;
    expect(pricing).toMatchObject({ status: "processed", repaired: 1, repairRounds: 1, usage: { inputTokens: 30_000, outputTokens: 10_000 } });
    expect(files.filter((f) => f.path !== "src/pricing.js").map((f) => [f.status, f.skipReason])).toEqual([
      ["skipped", "budget"],
      ["skipped", "budget"],
    ]);
    const charged = files.reduce((n, f) => n + f.usage.inputTokens + f.usage.outputTokens, 0);
    expect(charged).toBe(budget.usage.inputTokens + budget.usage.outputTokens);
    expect(pricing.costUsd).toBeNull();
  });

  it("stops at max-files and reports the rest as skipped", async () => {
    const provider = new ScriptedProvider((r) => fixtureGeneration(r.prompt));
    const { files } = await runFiles({
      root: repo,
      candidates: await candidatesFor(["src/pricing.js", UNUSUAL_NAME, "src/text/slug helper.js"]),
      provider,
      budget: new Budget(provider.model, 1, 1_000_000),
      maxFiles: 1,
      maxAttempts: 0,
      timeoutMs: 10_000,
      testsDir: path.join(await tempDir(), "tests"),
      runTests: fakeRunner(),
    });
    expect(files.map((f) => f.skipReason ?? f.status)).toEqual(["processed", "file-limit", "file-limit"]);
  });

  it("uses dollar prices when the model has one", () => {
    const budget = new Budget("gpt-5.4-mini", 0.01);
    expect(budget.priced).toBe(true);
    expect(budget.allows({ inputTokens: 1000, outputTokens: 1000 })).toBe(true);
    expect(budget.allows({ inputTokens: 1000, outputTokens: 10_000 })).toBe(false);
    expect(new Budget("my-local-model", 1, 5000).describeLimit()).toContain("5,000 tokens");
  });
});

describe("partial failures", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("records a timeout and a provider error, continues with the next file, and redacts credentials", async () => {
    process.env.OPENAI_API_KEY = SECRET;
    const provider = new ScriptedProvider((r) => {
      if (r.prompt.includes("addTax")) throw new Error(`Provider rejected key ${SECRET} (401)`);
      return fixtureGeneration(r.prompt);
    });
    const baseRunner = fakeRunner();
    const runTests = async (testPath: string, sourcePath: string) =>
      sourcePath.includes("slug helper")
        ? runOf([], { status: "error", infra: { kind: "timeout", message: "Jest did not finish within 1 second" } })
        : baseRunner(testPath);
    const out = path.join(await tempDir(), "report");
    const deps: CiDependencies = { createProvider: () => provider, runTests, log: () => {} };

    const files = ["src/pricing.js", UNUSUAL_NAME, "src/text/slug helper.js"].join("\n");
    const report = await runCi(baseOptions({ files, out, workingDirectory: repo, maxTokens: "1000000" }), deps);

    const status = Object.fromEntries(report.files.map((f) => [f.path, f]));
    expect(status["src/pricing.js"].status).toBe("processed");
    expect(status[UNUSUAL_NAME]).toMatchObject({ status: "failed" });
    expect(status[UNUSUAL_NAME].detail).not.toContain(SECRET);
    expect(status["src/text/slug helper.js"]).toMatchObject({ status: "failed", infra: { kind: "timeout" } });
    expect(report.totals.infrastructureFailures).toBe(1);
    expect(report.policy).toMatchObject({ failOn: "errors", failed: true });

    // Artifacts: only the report, the summary, and generated test previews. No credentials anywhere.
    const listed = (await readdir(out, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(out, path.join(e.parentPath, e.name)).split(path.sep).join("/"));
    expect(listed.sort()).toEqual(["report.json", "summary.md", "tests/src/pricing.test.preview.js", "tests/src/text/slug helper.test.preview.js"].sort());
    for (const file of listed) expect(await readFile(path.join(out, file), "utf8")).not.toContain(SECRET);
    expect(await readFile(path.join(out, "report.json"), "utf8")).toContain("<redacted>");

    // The checkout is left as it was: previews removed, sources untouched.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("requires an explicit token limit for models without a known price", async () => {
    const provider = new ScriptedProvider((r) => fixtureGeneration(r.prompt), "local-model");
    const out = path.join(await tempDir(), "report");
    await expect(runCi(baseOptions({ files: "src/pricing.js", out, workingDirectory: repo }), { createProvider: () => provider, log: () => {} })).rejects.toThrow(
      /--max-tokens/,
    );
    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8")) as CiReport;
    expect(report.error).toMatch(/no known price/);
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses to reuse a directory that is not an Assertloom report directory", async () => {
    const out = await tempDir();
    await writeFile(path.join(out, "important.txt"), "keep me");
    await expect(runCi(baseOptions({ files: "src/pricing.js", out, workingDirectory: repo, dryRun: true }), { createProvider: () => { throw new Error("unused"); }, log: () => {} })).rejects.toThrow(
      /not an Assertloom report directory/,
    );
    expect(await readFile(path.join(out, "important.txt"), "utf8")).toBe("keep me");
  });
});

describe("summary and policy", () => {
  const file = (overrides: Partial<FileReport>): FileReport => ({
    path: "src/a.js",
    change: "modified",
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
    durationMs: 1000,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: null,
    ...overrides,
  });

  const files: FileReport[] = [
    file({
      path: "src/a.js",
      generated: 6,
      accepted: 5,
      rejected: 1,
      initial: { status: "failed", passed: 3, failed: 2, skipped: 0 },
      final: { status: "passed", passed: 4, failed: 0, skipped: 1, coverage: { lines: 90, statements: 90, functions: 100, branches: 75 } },
      repaired: 1,
      flaggedAsSourceBugs: 1,
      repairRounds: 2,
      regressions: 1,
    }),
    file({
      path: "src/b|`<img src=x>`.js",
      generated: 3,
      accepted: 3,
      initial: { status: "failed", passed: 1, failed: 2, skipped: 0 },
      final: { status: "passed", passed: 1, failed: 0, skipped: 0 },
      removed: 2,
    }),
    file({ path: "src/c.js", status: "failed", detail: "tests could not run (timeout)", infra: { kind: "timeout", message: "x" } }),
    file({ path: "src/d.js", status: "skipped", skipReason: "deleted", detail: "deleted" }),
    file({ path: "src/e.js", status: "skipped", skipReason: "budget", detail: "budget" }),
  ];

  it("keeps repairs, skips, and removals separate in the totals", () => {
    const t = computeTotals(files);
    expect(t.files).toEqual({ changed: 5, selected: 4, processed: 2, skipped: 2, failed: 1 });
    expect(t.tests).toEqual({
      generated: 9,
      accepted: 8,
      rejected: 1,
      initial: { passed: 4, failed: 4, skipped: 0 },
      final: { passed: 5, failed: 0, skipped: 1 },
      repaired: 1,
      flaggedAsSourceBugs: 1,
      removed: 2,
      gaveUp: 0,
    });
    expect(t.regressions).toBe(1);
    expect(t.infrastructureFailures).toBe(1);
  });

  it("evaluates the failure policy", () => {
    expect(evaluatePolicy("never", files).failed).toBe(false);
    expect(evaluatePolicy("errors", files)).toEqual({ failed: true, reasons: ["1 file could not be processed"] });
    expect(evaluatePolicy("errors", files.filter((f) => f.status !== "failed")).failed).toBe(false);
    // a.js ends with a skipped test and b.js had tests removed.
    expect(evaluatePolicy("tests", files.filter((f) => f.status !== "failed"))).toEqual({
      failed: true,
      reasons: ["2 files ended with failing, skipped, or removed tests"],
    });
  });

  it("renders a summary with escaped file names and unknown cost for unpriced models", () => {
    const report: CiReport = {
      schemaVersion: 1,
      assertloom: "0.0.0",
      startedAt: "",
      finishedAt: "",
      mode: "pull-request",
      provider: "openai-compatible",
      model: "local",
      limits: { maxFiles: 10, maxCostUsd: 1, maxTokens: 1000, maxAttempts: 3, timeoutSeconds: 120 },
      budget: { exhausted: true, costKnown: false, spentUsd: null, tokens: { input: 1200, output: 300 } },
      totals: computeTotals(files),
      policy: { failOn: "errors", ...evaluatePolicy("errors", files) },
      files,
    };
    const md = renderSummary(report);
    expect(md).toContain("A completed run does not mean every generated test passed");
    expect(md).toContain("Budget exhausted");
    expect(md).toContain("unknown (no price for this model)");
    expect(md).toContain("repaired: 1; skipped as suspected source bugs: 1; skipped after repair gave up: 0; removed: 2");
    expect(md).toContain("| 90% | 75% |");
    expect(md).not.toContain("<img");
    expect(md).not.toMatch(/b\|/);
  });

  it("counts a repair only when a test that failed first passes at the end", () => {
    const initial = runOf([
      ["s", "a", "failed"],
      ["s", "b", "failed"],
      ["s", "c", "passed"],
    ]);
    const final = runOf([
      ["s", "a", "passed"],
      ["s", "b", "skipped"],
      ["s", "c", "passed"],
    ]);
    expect(countRepaired(initial, final)).toBe(1);
  });

  it("redacts configured secret values and key-shaped strings", () => {
    const redact = createRedactor(["plain-secret-value", undefined, "abc"]);
    expect(redact("x plain-secret-value y sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX abc")).toBe("x <redacted> y <redacted> abc");
  });
});

describe("assertloom ci end to end (fake model, real Jest)", () => {
  it("runs the same command the action runs on a pull-request-style change", async () => {
    const provider = new ScriptedProvider((r) => (isRepair(r) ? fixtureRepair() : fixtureGeneration(r.prompt)), "gpt-5.4-mini");
    const out = path.join(await tempDir(), "report");
    const githubOutput = path.join(out, "..", "github-output.txt");
    const githubSummary = path.join(out, "..", "step-summary.md");
    const program = new Command().exitOverride();
    registerCiCommand(program, { createProvider: () => provider, log: () => {} });
    const before = git(repo, "rev-parse", "HEAD");

    await program.parseAsync(
      ["ci", "--base", shas.base, "--working-directory", repo, "--out", out, "--github-output", githubOutput, "--github-summary", githubSummary],
      { from: "user" },
    );

    const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8")) as CiReport;
    const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]));
    expect(report.mode).toBe("pull-request");
    expect(byPath["src/pricing.js"]).toMatchObject({ status: "processed", repaired: 1, initial: { failed: 1 }, final: { status: "passed", passed: 3, failed: 0 } });
    expect(byPath[UNUSUAL_NAME]).toMatchObject({ status: "processed", final: { status: "passed", passed: 1 } });
    expect(byPath["src/text/slug helper.js"]).toMatchObject({ status: "processed", from: "src/slug.js", final: { status: "passed" } });
    expect(byPath["src/constants.js"]).toMatchObject({ status: "skipped", skipReason: "no-exported-functions" });
    expect(byPath["src/pricing.js"].final?.coverage?.lines).toBe(100);
    expect(report.budget.costKnown).toBe(true);
    expect(report.policy.failed).toBe(false);
    expect(report.totals.files).toMatchObject({ processed: 3, failed: 0 });

    expect(await readFile(githubOutput, "utf8")).toContain("result=passed\n");
    expect(await readFile(githubSummary, "utf8")).toContain("## Assertloom: generated tests for changed files");
    expect(await readFile(path.join(out, "tests", "src", "pricing.test.preview.js"), "utf8")).toContain("toBe(90)");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  }, 120_000);

  it("works from the built CLI binary in dry-run mode without an API key", () => {
    const out = path.join(os.tmpdir(), `assertloom-ci-dry-${process.pid}`);
    const { OPENAI_API_KEY: _k, ...env } = process.env;
    const githubOutput = `${out}-github-output.txt`;
    temps.push(githubOutput);
    const args = ["ci", "--base", shas.base, "--out", out, "--dry-run", "--github-output", githubOutput];
    const result = spawnSync(process.execPath, [tsxCli, path.join(root, "src/cli/index.ts"), ...args], {
      cwd: repo,
      encoding: "utf8",
      env,
    });
    temps.push(out);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Selected 4 of 11 changed files");
    expect(result.stdout).toContain("0 processed, 11 skipped, 0 failed");
    const outputs = readFileSync(githubOutput, "utf8");
    expect(outputs).toContain("files-selected=4\n");
    expect(outputs).toContain("result=passed\n");
  }, 60_000);

  it("exits non-zero with an actionable message when there is nothing to select", () => {
    const result = spawnSync(process.execPath, [tsxCli, path.join(root, "src/cli/index.ts"), "ci"], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pass --base");
  }, 60_000);
});

describe("action.yml", () => {
  it("pins an exact Assertloom version no older than this package", async () => {
    const action = await readFile(path.join(root, "action.yml"), "utf8");
    const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
    // Checkouts with core.autocrlf have CRLF line endings.
    const pinned = /assertloom-version:\r?\n\s+description:.*\r?\n\s+default: "([^"]+)"/.exec(action)?.[1];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const parts = (v: string) => v.split(".").map(Number);
    const [a, b] = [parts(pinned!), parts(version)];
    expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThanOrEqual(b[0] * 1e6 + b[1] * 1e3 + b[2]);
  });

  it("never expands expressions inside run scripts and pins every action it uses", async () => {
    const lines = (await readFile(path.join(root, "action.yml"), "utf8")).split("\n");
    let scriptIndent = -1;
    for (const line of lines) {
      const indent = line.length - line.trimStart().length;
      if (scriptIndent >= 0 && line.trim() && indent <= scriptIndent) scriptIndent = -1;
      if (scriptIndent >= 0) expect(line, "expression inside a run script").not.toContain("${{");
      const run = /^(\s*)run: (.*)$/.exec(line);
      if (run) {
        if (run[2].trim() === "|") scriptIndent = run[1].length;
        else expect(run[2]).not.toContain("${{");
      }
      const uses = /uses: (\S+)/.exec(line);
      if (uses) expect(uses[1]).toMatch(/@(v\d+(\.\d+)*|[0-9a-f]{40})$/);
    }
    expect(lines.join("\n")).not.toContain("pull_request_target");
  });
});
