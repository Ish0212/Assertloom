import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inferSourcePath } from "../src/cli/commands/run.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests, writeTestFile } from "../src/generator/index.js";
import { FakeProvider } from "./helpers/fakeProvider.js";
import { readCoverage } from "../src/runner/coverage.js";
import { defaultJestConfig, testRegexFor } from "../src/runner/jestConfig.js";
import { detectJestSetup, findProjectRoot, runJest, sanitizedEnv } from "../src/runner/index.js";
import { classifySuiteFailure, classifyTestFailure, cleanMessage, parseJestReport } from "../src/runner/results.js";

const root = path.resolve(import.meta.dirname, "..");
const fixture = (...parts: string[]) => path.join(root, "fixtures", "runner", ...parts);
const calc = fixture("calc.ts");

describe("classifyTestFailure", () => {
  it.each([
    ["Error: expect(received).toBe(expected)\nExpected: 5\nReceived: 4", "assertion"],
    ["\u001b[2mexpect(\u001b[22mreceived).toEqual(expected)", "assertion"],
    ['thrown: "Exceeded timeout of 5000 ms for a test.', "timeout"],
    ["TypeError: result.toFixedd is not a function", "error"],
    ["ReferenceError: foo is not defined", "error"],
  ])("%s → %s", (message, kind) => {
    expect(classifyTestFailure(message)).toBe(kind);
  });
});

describe("classifySuiteFailure", () => {
  it("recognizes missing modules, transform errors, and everything else", () => {
    expect(classifySuiteFailure("Cannot find module './x' from 'a.test.ts'").kind).toBe("module-not-found");
    expect(classifySuiteFailure("Jest encountered an unexpected token").kind).toBe("transform");
    expect(classifySuiteFailure("SyntaxError: Unexpected token 'export'").kind).toBe("transform");
    expect(classifySuiteFailure("Your test suite must contain at least one test.").kind).toBe("suite-error");
  });
});

describe("cleanMessage", () => {
  it("strips colors, node_modules frames, and extra stack frames", () => {
    const message = [
      "\u001b[31mError: boom\u001b[39m",
      "    at one (a.ts:1:1)",
      "    at inner (node_modules/jest-circus/x.js:1:1)",
      "    at two (a.ts:2:2)",
      "    at three (a.ts:3:3)",
      "    at four (a.ts:4:4)",
    ].join("\n");

    expect(cleanMessage(message)).toBe("Error: boom\n    at one (a.ts:1:1)\n    at two (a.ts:2:2)\n    at three (a.ts:3:3)");
  });
});

describe("parseJestReport", () => {
  it("turns assertion results into outcomes", () => {
    const { tests, infra } = parseJestReport({
      testResults: [
        {
          status: "failed",
          assertionResults: [
            { ancestorTitles: ["math", "add"], title: "adds", status: "passed", duration: 3 },
            { ancestorTitles: ["math"], title: "fails", status: "failed", failureMessages: ["Expected: 1\nReceived: 2"] },
            { ancestorTitles: [], title: "later", status: "pending" },
          ],
        },
      ],
    });

    expect(infra).toBeUndefined();
    expect(tests).toEqual([
      { suite: "math › add", name: "adds", status: "passed", durationMs: 3 },
      { suite: "math", name: "fails", status: "failed", durationMs: undefined, failure: { kind: "assertion", message: "Expected: 1\nReceived: 2" } },
      { suite: "", name: "later", status: "skipped", durationMs: undefined },
    ]);
  });

  it("reports a suite that failed to run as an infrastructure failure", () => {
    const { infra } = parseJestReport({
      testResults: [{ status: "failed", message: "● Test suite failed to run\n\nCannot find module './db'", assertionResults: [] }],
    });

    expect(infra?.kind).toBe("module-not-found");
  });
});

describe("readCoverage", () => {
  it("finds the source file's metrics and reports empty categories as null", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-"));
    try {
      const summary = path.join(dir, "coverage-summary.json");
      const metric = (total: number, pct: number | string) => ({ total, covered: 0, skipped: 0, pct });
      await writeFile(
        summary,
        JSON.stringify({
          total: { lines: metric(10, 50), statements: metric(10, 50), functions: metric(2, 50), branches: metric(0, "Unknown") },
          [calc]: { lines: metric(7, 71.42), statements: metric(7, 71.42), functions: metric(3, 66.66), branches: metric(0, 100) },
        }),
      );

      expect(await readCoverage(summary, calc)).toEqual({ lines: 71.42, statements: 71.42, functions: 66.66, branches: null });
      expect(await readCoverage(summary, fixture("other.ts"))).toBeUndefined();
      expect(await readCoverage(path.join(dir, "missing.json"), calc)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matches a source path reached through a symlink, as Jest reports real paths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-"));
    try {
      await mkdir(path.join(dir, "real"));
      await writeFile(path.join(dir, "real", "a.js"), "");
      await symlink(path.join(dir, "real"), path.join(dir, "link"), "junction");
      const summary = path.join(dir, "coverage-summary.json");
      const metric = { total: 1, covered: 1, skipped: 0, pct: 100 };
      const realFile = await realpath(path.join(dir, "real", "a.js"));
      await writeFile(summary, JSON.stringify({ [realFile]: { lines: metric, statements: metric, functions: metric, branches: metric } }));

      expect((await readCoverage(summary, path.join(dir, "link", "a.js")))?.lines).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sanitizedEnv", () => {
  it("removes credential-like variables and forces a test environment", () => {
    const env = sanitizedEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "t", DB_PASSWORD: "p", HOME: "/home/me", NODE_ENV: "production" });

    expect(env).toEqual({ PATH: "/bin", HOME: "/home/me", NODE_ENV: "test", CI: "true", FORCE_COLOR: "0" });
  });
});

describe("config helpers", () => {
  it("infers the source file from test file names", () => {
    expect(inferSourcePath("src/math.test.preview.ts")).toBe("src/math.ts");
    expect(inferSourcePath("src/math.test.ts")).toBe("src/math.ts");
    expect(inferSourcePath("lib/sum.spec.cjs")).toBe("lib/sum.cjs");
    expect(inferSourcePath("src/math.ts")).toBeUndefined();
  });

  it("builds a regex that matches only the test file", () => {
    const regex = new RegExp(testRegexFor("/repo/src/math.test.preview.ts"));

    expect(regex.test("/repo/src/math.test.preview.ts")).toBe(true);
    expect(regex.test("C:\\repo\\src\\math.test.preview.ts")).toBe(true);
    expect(regex.test("/repo/src/math.test.preview.tsx")).toBe(false);
    expect(regex.test("/repo/src/xmath.test.preview.ts")).toBe(false);
  });

  it("measures coverage only for the source file", () => {
    const config = defaultJestConfig(root, { testPath: fixture("calc.test.preview.ts"), sourcePath: calc, coverageDir: "/tmp/cov" });

    expect(config.collectCoverageFrom).toEqual(["fixtures/runner/calc.ts"]);
    expect(config.roots).toEqual([fixture()]);
  });

  it("finds the project root without escaping into stray parent package.json files", async () => {
    expect(findProjectRoot(calc)).toBe(root);
    expect(findProjectRoot(fixture("with-config", "sum.cjs"))).toBe(fixture("with-config"));

    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-"));
    try {
      const repo = path.join(dir, "repo");
      await mkdir(path.join(repo, ".git", "x"), { recursive: true });
      await mkdir(path.join(repo, "src"), { recursive: true });
      await writeFile(path.join(dir, "package.json"), "{}");

      expect(findProjectRoot(path.join(repo, "src", "a.ts"))).toBe(path.join(repo, "src"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects a Jest config in package.json and falls back to the default otherwise", () => {
    const withConfig = detectJestSetup(fixture("with-config", "sum.cjs"));
    expect(withConfig.root).toBe(fixture("with-config"));
    expect(withConfig.config).toEqual({ kind: "package-json", config: { testEnvironment: "node", testMatch: ["**/__tests__/**/*.cjs"] } });

    const plain = detectJestSetup(calc);
    expect(plain).toMatchObject({ root, config: { kind: "default" }, jestSource: "bundled" });
  });
});

describe.concurrent("runJest (real Jest runs)", { timeout: 180_000 }, () => {
  it("reports passing tests and coverage", async () => {
    const result = await runJest({ testPath: fixture("calc.test.preview.ts"), sourcePath: calc });

    expect(result).toMatchObject({ status: "passed", passed: 3, failed: 0, total: 3 });
    expect(result.tests.map((t) => `${t.suite} › ${t.name}`)).toEqual([
      "add › adds two numbers",
      "divide › divides",
      "divide › throws when dividing by zero",
    ]);
    expect(result.coverage?.functions).toBeCloseTo(66.67, 1);
    expect(result.coverage?.lines).toBeLessThan(100);
  });

  it("classifies assertion failures, runtime errors, and test timeouts", async () => {
    const result = await runJest({ testPath: fixture("failing.test.preview.ts"), sourcePath: calc, testTimeoutMs: 1000 });

    expect(result).toMatchObject({ status: "failed", passed: 1, failed: 3 });
    expect(Object.fromEntries(result.tests.filter((t) => t.failure).map((t) => [t.name, t.failure?.kind]))).toEqual({
      "has a wrong expectation": "assertion",
      "calls a method that does not exist": "error",
      "waits forever": "timeout",
    });
    expect(result.tests.find((t) => t.name === "has a wrong expectation")?.failure?.message).toContain("Expected: 5");
  });

  it("reports a missing import as an infrastructure failure", async () => {
    const result = await runJest({ testPath: fixture("broken-import.test.preview.ts"), sourcePath: calc });

    expect(result).toMatchObject({ status: "error", total: 0, infra: { kind: "module-not-found" } });
    expect(result.infra?.message).toContain("./does-not-exist");
    expect(result.coverage).toBeUndefined();
  });

  it("uses the project's Jest config but still runs only the preview file", async () => {
    const result = await runJest({ testPath: fixture("with-config", "sum.test.preview.cjs"), sourcePath: fixture("with-config", "sum.cjs") });

    expect(result).toMatchObject({ status: "passed", passed: 2, setup: expect.stringContaining('"jest" in package.json') });
    expect(result.coverage).toEqual({ lines: 100, statements: 100, functions: 100, branches: 100 });
  });

  it("loads a TypeScript Jest config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-tsconfig-"));
    try {
      await writeFile(path.join(dir, "package.json"), '{ "name": "ts-config-project" }\n');
      await writeFile(
        path.join(dir, "jest.config.ts"),
        'import type { Config } from "jest";\n\nconst config: Config = { testEnvironment: "node", globals: { FROM_TS_CONFIG: true } };\n\nexport default config;\n',
      );
      await copyFile(fixture("with-config", "sum.cjs"), path.join(dir, "sum.cjs"));
      await writeFile(
        path.join(dir, "sum.test.preview.cjs"),
        'const { sum } = require("./sum.cjs");\nit("sees the config", () => {\n  expect(globalThis.FROM_TS_CONFIG).toBe(true);\n  expect(sum([1, 2])).toBe(3);\n});\n',
      );

      const result = await runJest({ testPath: path.join(dir, "sum.test.preview.cjs"), sourcePath: path.join(dir, "sum.cjs") });

      expect(result).toMatchObject({ status: "passed", passed: 1, setup: expect.stringContaining("jest.config.ts") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs generated tests end to end: model output → preview file → Jest → coverage", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-e2e-"));
    try {
      const sourcePath = path.join(dir, "math.ts");
      await copyFile(path.join(root, "examples", "math.ts"), sourcePath);
      const provider = new FakeProvider({
        suites: [
          { functionName: "add", cases: [{ name: "adds", category: "normal", body: "expect(add(2, 3)).toBe(5);" }] },
          {
            functionName: "divide",
            cases: [
              { name: "divides", category: "normal", body: "expect(divide(9, 3)).toBe(3);" },
              { name: "rejects zero", category: "error", body: 'expect(() => divide(1, 0)).toThrow("Cannot divide by zero");' },
            ],
          },
        ],
      });

      const generated = await generateTests({ source: await validateSourceFile(sourcePath), provider });
      await writeTestFile(generated.testPath, generated.content);
      const result = await runJest({ testPath: generated.testPath, sourcePath });

      expect(result.infra).toBeUndefined();
      expect(result).toMatchObject({ status: "passed", passed: 3, failed: 0 });
      expect(result.coverage).toEqual({ lines: 100, statements: 100, functions: 100, branches: 100 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills Jest when the run exceeds its timeout", async () => {
    const result = await runJest({ testPath: fixture("calc.test.preview.ts"), sourcePath: calc, timeoutMs: 200 });

    expect(result).toMatchObject({ status: "error", infra: { kind: "timeout" } });
  });
});
