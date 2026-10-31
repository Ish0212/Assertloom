import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zodTextFormat } from "openai/helpers/zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGenerationPrompt, GENERATION_SYSTEM_PROMPT } from "../src/ai/prompts.js";
import { redactSecrets } from "../src/ai/redact.js";
import { analyzeFile, parseSource } from "../src/analyzer/index.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests, GenerationError, TestFileExistsError, writeTestFile } from "../src/generator/index.js";
import type { FileAnalysis } from "../src/types/index.js";
import { importSpecifier, planImports } from "../src/generator/importPlan.js";
import { GenerationSchema, type Generation } from "../src/generator/schema.js";
import { GENERATED_HEADER, previewPathFor } from "../src/generator/testWriter.js";
import { checkBody, MAX_CASES_PER_FUNCTION, validateGeneration } from "../src/generator/validate.js";
import { FakeProvider } from "./helpers/fakeProvider.js";

const root = path.resolve(import.meta.dirname, "..");

async function load(file: string) {
  const source = await validateSourceFile(file, root);
  return { source, analysis: await analyzeFile(source) };
}

async function planFor(file: string) {
  const { source, analysis } = await load(file);
  return planImports(analysis, exported(analysis), source.absolutePath, previewPathFor(source.absolutePath));
}

function exported(analysis: FileAnalysis) {
  return analysis.functions.filter((fn) => fn.exported);
}

const mathGeneration: Generation = {
  suites: [
    {
      functionName: "add",
      cases: [
        { name: "adds two positive numbers", category: "normal", body: "expect(add(2, 3)).toBe(5);" },
        { name: "handles negative numbers", category: "edge", body: "expect(add(-2, -3)).toBe(-5);" },
      ],
    },
    {
      functionName: "divide",
      cases: [
        { name: "divides evenly", category: "normal", body: "expect(divide(10, 2)).toBe(5);" },
        { name: "throws when dividing by zero", category: "error", body: 'expect(() => divide(1, 0)).toThrow("Cannot divide by zero");' },
        { name: "missing expect", category: "edge", body: "divide(1, 1);" },
      ],
    },
    {
      functionName: "multiply",
      cases: [{ name: "not in the file", category: "normal", body: "expect(multiply(2, 3)).toBe(6);" }],
    },
  ],
};

describe("planImports", () => {
  it("imports named ESM exports without the .ts extension", async () => {
    expect((await planFor("examples/math.ts")).statements).toEqual(['import { add, divide } from "./math";']);
  });

  it("uses export aliases and names anonymous default exports after the file", async () => {
    const exportsPlan = await planFor("fixtures/analyzer/exports.ts");
    expect(exportsPlan.statements).toEqual(['import { normalize, toSlug, parse, double } from "./exports";']);
    expect(exportsPlan.bindings.find((b) => b.fn.name === "slugify")?.binding).toBe("toSlug");

    const basicPlan = await planFor("fixtures/analyzer/basic.ts");
    expect(basicPlan.bindings.find((b) => b.exportName === "default")?.binding).toBe("basic");
    expect(basicPlan.statements[0]).toMatch(/^import basic, \{ add, divide, .* \} from "\.\/basic";$/);
  });

  it("uses require() for CommonJS and keeps .cjs extensions", async () => {
    expect((await planFor("fixtures/analyzer/commonjs.js")).statements).toEqual(['const { readJson, writeJson, format } = require("./commonjs");']);
    expect((await planFor("fixtures/analyzer/exports-object.cjs")).statements).toEqual([
      'const { pick, isEmpty, retry } = require("./exports-object.cjs");',
    ]);
    expect((await planFor("fixtures/analyzer/default-export.cjs")).statements).toEqual([
      'const fetchAll = require("./default-export.cjs");',
    ]);
  });

  it("builds relative specifiers across directories", () => {
    expect(importSpecifier(path.join(root, "tests", "math.test.ts"), path.join(root, "examples", "math.ts"))).toBe("../examples/math");
  });
});

describe("checkBody", () => {
  it("accepts a body with expect() and detects await", () => {
    expect(checkBody("expect(add(1, 2)).toBe(3);", ".ts")).toEqual({ async: false });
    expect(checkBody("await expect(load()).rejects.toThrow();", ".ts")).toEqual({ async: true });
    expect(checkBody("const xs = [1].map(async (x) => await x);\nexpect(xs).toHaveLength(1);", ".ts")).toEqual({ async: false });
  });

  it("allows TypeScript syntax in TS files", () => {
    expect(checkBody("expect(() => add('1' as any, 2)).not.toThrow();", ".ts")).toEqual({ async: false });
  });

  it.each([
    ["add(1, 2);", "does not call expect()"],
    ["const fs = require('fs'); expect(fs).toBeDefined();", "uses require()"],
    ["jest.mock('./db'); expect(1).toBe(1);", "calls jest.mock()"],
    ["const real = jest.requireActual('pg'); expect(real).toBeDefined();", "calls jest.requireActual()"],
    ["const m = await import('./x'); expect(m).toBeDefined();", "uses import()"],
    ["process.exit(1); expect(1).toBe(1);", "calls a process method"],
    ["it('nested', () => { expect(1).toBe(1); });", "wraps the body in it()"],
  ])("rejects %s", (body, reason) => {
    expect(checkBody(body, ".ts")).toEqual({ error: reason });
  });

  it("rejects syntax errors", () => {
    expect(checkBody("expect(add(1, 2).toBe(3);", ".ts")).toMatchObject({ error: expect.stringMatching(/^syntax error/) });
  });
});

describe("validateGeneration", () => {
  it("keeps valid cases and explains every rejection", async () => {
    const plan = await planFor("examples/math.ts");
    const { suites, rejected } = validateGeneration(mathGeneration, plan.bindings, ".ts");

    expect(suites.map((s) => [s.binding.binding, s.cases.length])).toEqual([
      ["add", 2],
      ["divide", 2],
    ]);
    expect(rejected).toEqual([
      { functionName: "divide", name: "missing expect", reason: "does not call expect()" },
      { functionName: "multiply", name: "not in the file", reason: "not a target function" },
    ]);
  });

  it("deduplicates names and caps cases per function", async () => {
    const plan = await planFor("examples/math.ts");
    const cases = Array.from({ length: MAX_CASES_PER_FUNCTION + 2 }, () => ({
      name: "adds",
      category: "normal" as const,
      body: "expect(add(1, 1)).toBe(2);",
    }));
    const { suites, rejected } = validateGeneration({ suites: [{ functionName: "add", cases }] }, plan.bindings, ".ts");

    expect(suites[0].cases).toHaveLength(MAX_CASES_PER_FUNCTION);
    expect(suites[0].cases.slice(0, 3).map((c) => c.name)).toEqual(["adds", "adds (2)", "adds (3)"]);
    expect(rejected).toHaveLength(2);
  });
});

describe("prompts", () => {
  it("lists bindings with signatures and includes the source", async () => {
    const { source, analysis } = await load("fixtures/analyzer/exports.ts");
    const plan = planImports(analysis, exported(analysis), source.absolutePath, previewPathFor(source.absolutePath));
    const prompt = buildGenerationPrompt({ analysis, code: "SOURCE_MARKER", bindings: plan.bindings, testFileName: "exports.test.preview.ts" });

    expect(prompt).toContain("- `toSlug`: `toSlug(text: string): string` (declared as `slugify` in the source; defined at line 7)");
    expect(prompt).toContain("```typescript\nSOURCE_MARKER\n```");
    expect(GENERATION_SYSTEM_PROMPT).toContain("Do not write import or require statements");
  });

  it("produces a schema OpenAI structured outputs accepts", () => {
    const format = zodTextFormat(GenerationSchema, "assertloom_tests");

    expect(format).toMatchObject({ type: "json_schema", name: "assertloom_tests", strict: true });
  });
});

describe("redactSecrets", () => {
  it("replaces credentials but leaves ordinary code alone", () => {
    const code = [
      'const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";',
      'const password = "hunter2hunter2";',
      'const url = "postgres://admin:s3cret@db.example.com/app";',
      'const aws = "AKIAABCDEFGHIJKLMNOP";',
      'const greeting = "hello world, not a secret";',
      "const tokenCount = 5;",
    ].join("\n");
    const { code: redacted, redactions } = redactSecrets(code);

    expect(redactions).toBe(4);
    expect(redacted).not.toMatch(/sk-proj|hunter2|s3cret|AKIA/);
    expect(redacted).toContain("hello world, not a secret");
    expect(redacted).toContain("const tokenCount = 5;");
  });
});

describe("generateTests", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("generates a syntactically valid Jest file from model output", async () => {
    const provider = new FakeProvider(mathGeneration);
    const source = await validateSourceFile("examples/math.ts", root);
    const result = await generateTests({ source, provider });

    expect(result.testPath).toBe(path.join(root, "examples", "math.test.preview.ts"));
    expect(result.content).toBe(`${GENERATED_HEADER} Source: examples/math.ts. Review before committing.
import { add, divide } from "./math";

describe("add", () => {
  it("adds two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("handles negative numbers", () => {
    expect(add(-2, -3)).toBe(-5);
  });
});

describe("divide", () => {
  it("divides evenly", () => {
    expect(divide(10, 2)).toBe(5);
  });

  it("throws when dividing by zero", () => {
    expect(() => divide(1, 0)).toThrow("Cannot divide by zero");
  });
});
`);
    expect(() => parseSource(result.content, ".ts")).not.toThrow();
    expect(result.rejected).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("sends redacted source and the target bindings to the provider", async () => {
    const file = path.join(dir, "config.ts");
    await writeFile(file, 'const secret = "super-secret-value";\nexport function getName(): string {\n  return "app";\n}\n');
    const provider = new FakeProvider({
      suites: [{ functionName: "getName", cases: [{ name: "returns app", category: "normal", body: 'expect(getName()).toBe("app");' }] }],
    });

    const result = await generateTests({ source: await validateSourceFile(file), provider });
    const prompt = provider.requests[0].prompt;

    expect(result.redactions).toBe(1);
    expect(prompt).not.toContain("super-secret-value");
    expect(prompt).toContain("`getName`: `getName(): string`");
    expect(provider.requests[0].system).toBe(GENERATION_SYSTEM_PROMPT);
  });

  it("wraps async bodies in async callbacks", async () => {
    const file = path.join(dir, "wait.ts");
    await writeFile(file, "export async function wait(): Promise<number> {\n  return 1;\n}\n");
    const provider = new FakeProvider({
      suites: [{ functionName: "wait", cases: [{ name: "resolves to 1", category: "normal", body: "await expect(wait()).resolves.toBe(1);" }] }],
    });

    const result = await generateTests({ source: await validateSourceFile(file), provider });

    expect(result.content).toContain('it("resolves to 1", async () => {');
  });

  it("fails clearly when the file exports no functions", async () => {
    const file = path.join(dir, "constants.ts");
    await writeFile(file, "export const LIMIT = 10;\n");
    const provider = new FakeProvider({ suites: [] });

    await expect(generateTests({ source: await validateSourceFile(file), provider })).rejects.toThrow(GenerationError);
    expect(provider.requests).toHaveLength(0);
  });

  it("fails when every case is rejected", async () => {
    const provider = new FakeProvider({ suites: [{ functionName: "add", cases: [{ name: "bad", category: "normal", body: "add(1, 2);" }] }] });
    const source = await validateSourceFile("examples/math.ts", root);

    await expect(generateTests({ source, provider })).rejects.toThrow(/no usable test cases \(1 rejected\)/);
  });
});

describe("writeTestFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("overwrites its own files but not hand-written ones", async () => {
    const generated = path.join(dir, "a.test.preview.ts");
    const handWritten = path.join(dir, "b.test.preview.ts");
    await writeFile(generated, `${GENERATED_HEADER} old\n`);
    await writeFile(handWritten, "// my tests\n");

    expect(await writeTestFile(generated, "new")).toEqual({ overwritten: true });
    await expect(writeTestFile(handWritten, "new")).rejects.toBeInstanceOf(TestFileExistsError);
    expect(await readFile(handWritten, "utf8")).toBe("// my tests\n");

    await writeTestFile(handWritten, "forced", true);
    expect(await readFile(handWritten, "utf8")).toBe("forced");
  });
});
