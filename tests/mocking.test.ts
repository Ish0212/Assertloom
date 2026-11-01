import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeFile, analyzeSource } from "../src/analyzer/index.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests, planMocks, previewPathFor, writeTestFile } from "../src/generator/index.js";
import { runJest } from "../src/runner/index.js";
import type { FileAnalysis, ImportUsage } from "../src/types/index.js";
import { scenarios } from "../fixtures/mocking/scenarios.js";
import { FakeProvider } from "./helpers/fakeProvider.js";

const root = path.resolve(import.meta.dirname, "..");

async function load(file: string) {
  const source = await validateSourceFile(path.resolve(root, file));
  return { source, analysis: await analyzeFile(source) };
}

function inline(code: string, extension: ".ts" | ".js" = ".ts"): FileAnalysis {
  return analyzeSource(code, { inputPath: `inline${extension}`, extension, language: extension === ".ts" ? "typescript" : "javascript" });
}

const usage = (analysis: FileAnalysis, local: string): ImportUsage | undefined => analysis.importUsage.find((u) => u.local === local);

describe("import usage analysis", () => {
  it("records calls, constructors, and objects created when the module loads", async () => {
    const { analysis } = await load("examples/users.ts");

    expect(usage(analysis, "axios")).toMatchObject({ source: "axios", imported: "default", style: "esm" });
    expect(Object.keys(usage(analysis, "axios")!.shape.members)).toEqual(["get", "isAxiosError"]);
    expect(usage(analysis, "axios")!.shape.members.get.called).toBe(true);

    const pool = usage(analysis, "Pool")!;
    expect(pool).toMatchObject({ source: "pg", imported: "Pool", style: "esm" });
    expect(pool.shape).toMatchObject({ constructed: true, createdAtLoad: true, resultNames: ["pool"] });
    expect(pool.shape.result?.members.query.called).toBe(true);

    expect(analysis.functions.find((f) => f.name === "getUser")?.dependencies).toEqual(["axios", "pg"]);
  });

  it("records CommonJS requires, destructuring, inline requires, and instanceof", () => {
    const analysis = inline(
      [
        'const db = require("./db");',
        'const { AxiosError } = require("axios");',
        "exports.load = async (id) => db.users.find(id);",
        "exports.isApiError = (e) => e instanceof AxiosError;",
        'exports.paint = (s) => require("chalk").red(s);',
      ].join("\n"),
      ".js",
    );

    expect(usage(analysis, "db")).toMatchObject({ imported: "*", style: "commonjs" });
    expect(usage(analysis, "db")!.shape.members.users.members.find.called).toBe(true);
    expect(usage(analysis, "AxiosError")!.shape.instanceOf).toBe(true);
    expect(analysis.importUsage.find((u) => u.source === "chalk")!.shape.members.red.called).toBe(true);
  });

  it("finds the global fetch per function, ignoring parameters that shadow it", () => {
    const analysis = inline(
      [
        "export async function a(url: string) { return (await fetch(url)).json(); }",
        "export function b(fetch: (u: string) => unknown) { return fetch('x'); }",
      ].join("\n"),
    );

    expect(analysis.globals).toEqual(["fetch"]);
    expect(analysis.functions.map((f) => [f.name, f.globals])).toEqual([
      ["a", ["fetch"]],
      ["b", []],
    ]);
  });
});

describe("planMocks", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-mocks-"));
    await writeFile(path.join(dir, "pure.ts"), 'import path from "node:path";\nexport const base = (p: string) => path.basename(p);\n');
    await writeFile(path.join(dir, "client.ts"), 'import axios from "axios";\nexport const get = (u: string) => axios.get(u);\n');
    await writeFile(path.join(dir, "service.ts"), 'export { get } from "./client";\nimport { get } from "./client";\nexport const load = () => get("/x");\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function plan(code: string, options: { mock?: string[]; keepReal?: string[]; testDir?: string } = {}) {
    const file = path.join(dir, "subject.ts");
    await writeFile(file, code);
    const source = await validateSourceFile(file);
    const analysis = await analyzeFile(source);
    const testPath = path.join(options.testDir ?? dir, "subject.test.preview.ts");
    return planMocks({ analysis, sourcePath: file, testPath, extension: ".ts", reserved: ["run"], ...options });
  }

  it("mocks I/O dependencies and keeps pure ones real", async () => {
    const result = await plan(
      [
        'import { z } from "zod";',
        'import path from "node:path";',
        'import { readFileSync } from "node:fs";',
        'import { base } from "./pure";',
        'import { load } from "./service";',
        'import { thing } from "./missing";',
        "export const run = () => [z, path, readFileSync('x'), base('a'), load(), thing()];",
      ].join("\n"),
    );

    expect(result.mocked.map((m) => [m.source, m.reason, m.virtual])).toEqual([
      ["node:fs", "Node built-in with side effects", false],
      ["./service", "depends on ./client (depends on axios)", false],
      ["./missing", "local module not found", true],
    ]);
    expect(result.real).toEqual([
      { source: "zod", reason: "utility library without I/O" },
      { source: "node:path", reason: "pure Node built-in" },
      { source: "./pure", reason: "local module without side effects" },
    ]);
  });

  it("follows re-exports when deciding whether a local module is pure", async () => {
    await writeFile(path.join(dir, "barrel.ts"), 'export * from "./client";\nexport type { Thing } from "./types";\n');
    const result = await plan('import { get } from "./barrel";\nexport const run = () => get("/x");\n');

    expect(result.mocked.map((m) => [m.source, m.reason])).toEqual([["./barrel", "depends on ./client (depends on axios)"]]);
  });

  it("mocks an instanceof target that also has members as a class", async () => {
    const result = await plan(
      'import { ZodError } from "zod";\nexport const run = (e: unknown) => e instanceof ZodError && ZodError.create([]);\n',
      { mock: ["zod"] },
    );

    expect(result.imports[0]).toContain("ZodError: Object.assign(class {}, { create: jest.fn() })");
  });

  it("lets --mock and --keep-real override the defaults", async () => {
    const result = await plan('import { z } from "zod";\nimport fs from "node:fs";\nexport const run = () => [z.string(), fs.statSync("x")];\n', {
      mock: ["zod"],
      keepReal: ["fs"],
    });

    expect(result.mocked.map((m) => [m.source, m.reason])).toEqual([["zod", "mocked with --mock"]]);
    expect(result.real).toEqual([{ source: "node:fs", reason: "kept real with --keep-real" }]);
  });

  it("writes self-contained factories and shared instances for objects created at load time", async () => {
    const { source, analysis } = await load("examples/users.ts");
    const result = await planMocks({
      analysis,
      sourcePath: source.absolutePath,
      testPath: previewPathFor(source.absolutePath),
      extension: ".ts",
      reserved: ["getUser", "importUser", "countUsersByDomain"],
    });

    expect(result.imports).toEqual([
      'jest.mock("axios", () => ({ __esModule: true, default: { get: jest.fn(), isAxiosError: jest.fn() } }), { virtual: true });',
      'jest.mock("pg", () => {\n  const instance1 = { query: jest.fn() };\n  return { __esModule: true, Pool: function () { return instance1; } };\n}, { virtual: true });',
      "",
      'import axios from "axios";',
      'import { Pool } from "pg";',
    ]);
    expect(result.setup[0]).toBe("const pool = new Pool();");
    expect(result.summary).toContain("`new Pool()` returns one shared mock object, available in tests as `pool`");
    expect(result.summary).toContain("jest.fn() mocks: `pool.query`");
  });

  it("rewrites local specifiers relative to the test file and avoids name clashes", async () => {
    const result = await plan('import { load } from "./service";\nconst run2 = 1;\nexport const run = () => load();\n', { testDir: path.join(dir, "tests") });

    expect(result.imports[0]).toMatch(/^jest\.mock\("\.\.\/service", /);
    expect(result.imports).toContain('import { load } from "../service";');
  });

  it("mocks global fetch and restores it after the file", async () => {
    const result = await plan("export const run = async () => (await fetch('/x')).json();\n");

    expect(result.globals).toEqual(["fetch"]);
    expect(result.setup[0]).toBe(
      "const originalFetch = globalThis.fetch;\nglobalThis.fetch = jest.fn() as unknown as typeof fetch;\nafterAll(() => {\n  globalThis.fetch = originalFetch;\n});",
    );
    expect(result.setup).toContain("beforeEach(() => {\n  jest.resetAllMocks();\n});");
  });

  it("adds no mocks when there is nothing to mock, but shares pure built-ins with the test", async () => {
    const result = await plan('import path from "node:path";\nexport const run = () => path.sep;\n');

    expect(result).toMatchObject({ mocked: [], globals: [], imports: ['import path from "node:path";'], setup: [] });
    expect(result.summary).toBe("- Not mocked, and also imported in the test file for building expected values: `path` (node:path)");
  });
});

describe("generated tests with mocks (real Jest)", { timeout: 300_000 }, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-mocking-"));
    await mkdir(path.join(dir, "examples"));
    await cp(path.join(root, "examples", "users.ts"), path.join(dir, "examples", "users.ts"));
    await cp(path.join(root, "fixtures", "mocking"), path.join(dir, "fixtures", "mocking"), { recursive: true });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.concurrent.each(scenarios.map((s) => [s.file, s] as const))("%s passes with Assertloom's mocks", async (_file, scenario) => {
    const provider = new FakeProvider(scenario.generation);
    const source = await validateSourceFile(path.join(dir, scenario.file));
    const generated = await generateTests({ source, provider });

    expect(generated.rejected).toEqual([]);
    expect(provider.requests[0].prompt).toContain("Mocks (already set up in the test file):");

    await writeTestFile(generated.testPath, generated.content);
    const run = await runJest({ testPath: generated.testPath, sourcePath: source.absolutePath });

    expect(run.tests.filter((t) => t.status === "failed").map((t) => `${t.name}: ${t.failure?.message}`)).toEqual([]);
    expect(run.infra).toBeUndefined();
    expect(run).toMatchObject({ status: "passed", passed: scenario.tests, failed: 0 });
    expect(run.coverage?.lines).toBe(100);
  });
});
