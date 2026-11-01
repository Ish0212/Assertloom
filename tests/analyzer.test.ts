import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFile, analyzeSource, ParseError } from "../src/analyzer/index.js";
import { classifySource } from "../src/analyzer/dependencies.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import type { FileAnalysis, FunctionInfo } from "../src/types/index.js";

const root = path.resolve(import.meta.dirname, "..");

async function analyze(file: string): Promise<FileAnalysis> {
  return analyzeFile(await validateSourceFile(file, root));
}

function fn(analysis: FileAnalysis, name: string): FunctionInfo {
  const found = analysis.functions.find((f) => f.name === name);
  if (!found) throw new Error(`No function "${name}" in ${analysis.file}`);
  return found;
}

describe("analyzer: examples/math.ts", () => {
  it("matches the roadmap's expected output", async () => {
    const analysis = await analyze("examples/math.ts");

    expect(analysis.file).toBe("examples/math.ts");
    expect(
      analysis.functions.map((f) => ({ name: f.name, exported: f.exported, parameters: f.parameters.map((p) => p.name), async: f.async })),
    ).toEqual([
      { name: "add", exported: true, parameters: ["a", "b"], async: false },
      { name: "divide", exported: true, parameters: ["a", "b"], async: false },
    ]);
  });
});

describe("analyzer: function shapes (basic.ts)", async () => {
  const analysis = await analyze("fixtures/analyzer/basic.ts");

  it("finds every top-level function", () => {
    expect(analysis.functions.map((f) => f.name)).toEqual([
      "add", "divide", "multiply", "subtract", "delay", "fetchJson", "range", "sum", "greet",
      "formatUser", "head", "identity", "safeParse", "validateAll", "clamp", "default",
    ]);
  });

  it("captures parameter and return types", () => {
    expect(fn(analysis, "add")).toMatchObject({
      kind: "declaration",
      parameters: [
        { name: "a", type: "number", optional: false, rest: false },
        { name: "b", type: "number", optional: false, rest: false },
      ],
      returnType: "number",
      throws: false,
    });
  });

  it("detects direct throws but not throws inside nested callbacks or caught errors", () => {
    expect(fn(analysis, "divide").throws).toBe(true);
    expect(fn(analysis, "fetchJson").throws).toBe(true);
    expect(fn(analysis, "validateAll").throws).toBe(false);
    expect(fn(analysis, "safeParse").throws).toBe(false);
  });

  it("distinguishes arrow functions, function expressions, async, and generators", () => {
    expect(fn(analysis, "multiply")).toMatchObject({ kind: "arrow", returnType: "number" });
    expect(fn(analysis, "subtract")).toMatchObject({ kind: "expression", returnType: undefined });
    expect(fn(analysis, "delay")).toMatchObject({ async: true, returnType: "Promise<void>" });
    expect(fn(analysis, "fetchJson")).toMatchObject({ kind: "arrow", async: true, typeParameters: "<T>", returnType: "Promise<T>" });
    expect(fn(analysis, "range")).toMatchObject({ generator: true, async: false });
  });

  it("handles optional, default, rest, and destructured parameters", () => {
    expect(fn(analysis, "fetchJson").parameters[1]).toEqual({ name: "init", type: "RequestInit", optional: true, rest: false });
    expect(fn(analysis, "range").parameters[2]).toEqual({ name: "step", type: undefined, optional: true, rest: false, defaultValue: "1" });
    expect(fn(analysis, "sum").parameters).toEqual([{ name: "values", type: "number[]", optional: true, rest: true }]);
    expect(fn(analysis, "greet").parameters.map((p) => [p.name, p.optional, p.defaultValue])).toEqual([
      ["name", false, undefined],
      ["greeting", true, '"Hello"'],
      ["punctuation", true, undefined],
    ]);
    expect(fn(analysis, "formatUser").parameters[0]).toMatchObject({
      name: "{ first, last }",
      type: "{ first: string; last: string }",
    });
    expect(fn(analysis, "head").parameters[0]).toMatchObject({ name: "[first]", type: "T[]" });
  });

  it("marks internal helpers and anonymous default exports", () => {
    expect(fn(analysis, "clamp")).toMatchObject({ exported: false, exportedAs: [] });
    expect(fn(analysis, "default")).toMatchObject({ exported: true, exportedAs: ["default"], kind: "declaration" });
  });
});

describe("analyzer: export forms (exports.ts)", async () => {
  const analysis = await analyze("fixtures/analyzer/exports.ts");

  it("resolves export lists, aliases, and default identifiers", () => {
    expect(fn(analysis, "normalize").exportedAs).toEqual(["normalize"]);
    expect(fn(analysis, "slugify").exportedAs).toEqual(["toSlug", "default"]);
    expect(fn(analysis, "internalOnly").exported).toBe(false);
  });

  it("keeps only the implementation of overloaded functions and skips declarations", () => {
    expect(analysis.functions.filter((f) => f.name === "parse")).toHaveLength(1);
    expect(fn(analysis, "parse").parameters[0].type).toBe("string | number");
    expect(analysis.functions.some((f) => f.name === "provided")).toBe(false);
  });

  it("unwraps `satisfies` and ignores non-function exports", () => {
    expect(fn(analysis, "double")).toMatchObject({ kind: "arrow", exported: true });
    expect(analysis.functions.some((f) => f.name === "VERSION")).toBe(false);
    expect(analysis.functions).toHaveLength(5);
  });
});

describe("analyzer: dependencies (dependencies.ts)", async () => {
  const analysis = await analyze("fixtures/analyzer/dependencies.ts");

  it("summarizes runtime dependencies, excluding type-only imports", () => {
    expect(analysis.dependencies).toEqual({
      local: ["./config", "./dates", "./db", "./shared"],
      external: ["@prisma/client", "axios", "chalk"],
      builtin: ["fs/promises", "path"],
    });
  });

  it("records import kinds and specifiers", () => {
    const bySource = Object.fromEntries(analysis.imports.map((i) => [i.source, i]));

    expect(bySource["./db"].specifiers).toEqual([{ kind: "namespace", imported: "*", local: "db" }]);
    expect(bySource["axios"]).toMatchObject({ kind: "import", category: "external", packageName: "axios" });
    expect(bySource["./models"]).toMatchObject({ typeOnly: true });
    expect(bySource["./config"]).toMatchObject({ typeOnly: false });
    expect(bySource["./dates"]).toMatchObject({ kind: "re-export", specifiers: [{ imported: "formatDate", local: "formatDate" }] });
    expect(bySource["./shared"]).toMatchObject({ kind: "re-export" });
    expect(bySource["chalk"]).toMatchObject({ kind: "dynamic-import", category: "external" });
    expect(bySource["node:fs/promises"]).toMatchObject({ category: "builtin" });
  });

  it("maps each function to the modules it uses", () => {
    expect(fn(analysis, "readConfigFile").dependencies).toEqual(["node:fs/promises", "path"]);
    expect(fn(analysis, "getUser").dependencies).toEqual(["axios"]);
    expect(fn(analysis, "saveUser").dependencies).toEqual(["./db"]);
    expect(fn(analysis, "countUsers").dependencies).toEqual(["@prisma/client"]);
    expect(fn(analysis, "getConfig").dependencies).toEqual(["./config"]);
    expect(fn(analysis, "loadColors").dependencies).toEqual(["chalk"]);
  });

  it("ignores parameters that shadow an import", () => {
    expect(fn(analysis, "shout").dependencies).toEqual([]);
  });
});

describe("analyzer: CommonJS", () => {
  it("reads module.exports objects, shorthand, aliases, and methods (commonjs.js)", async () => {
    const analysis = await analyze("fixtures/analyzer/commonjs.js");

    expect(analysis.moduleSystem).toBe("commonjs");
    expect(analysis.functions.map((f) => [f.name, f.exportedAs])).toEqual([
      ["readJson", ["readJson"]],
      ["writeJsonFile", ["writeJson"]],
      ["format", ["format"]],
    ]);
    expect(fn(analysis, "writeJsonFile").dependencies).toEqual(["fs", "path"]);
    expect(analysis.imports.map((i) => [i.kind, i.source, i.specifiers.map((s) => s.local)])).toEqual([
      ["require", "fs", ["fs"]],
      ["require", "path", ["join"]],
    ]);
  });

  it("reads exports.x and module.exports.x assignments (exports-object.cjs)", async () => {
    const analysis = await analyze("fixtures/analyzer/exports-object.cjs");

    expect(analysis.functions.map((f) => [f.name, f.exportedAs])).toEqual([
      ["pick", ["pick"]],
      ["isEmpty", ["isEmpty"]],
      ["retry", ["retry"]],
    ]);
    expect(fn(analysis, "pick").dependencies).toEqual(["lodash/fp"]);
    expect(fn(analysis, "retry")).toMatchObject({ async: true, throws: true });
    expect(analysis.dependencies.external).toEqual(["lodash"]);
  });

  it("reads module.exports = function (default-export.cjs)", async () => {
    const analysis = await analyze("fixtures/analyzer/default-export.cjs");

    expect(analysis.functions).toHaveLength(1);
    expect(analysis.functions[0]).toMatchObject({ name: "fetchAll", exportedAs: ["default"], async: true });
  });

  it("follows module.exports = object and exports.x = object.x", () => {
    const code = [
      "function parse(src) { return src; }",
      "function config() { return {}; }",
      "function _internal() {}",
      "const Api = { parse, config, inline: () => 1 };",
      "module.exports.parse = Api.parse;",
      "module.exports.inline = Api.inline;",
      "module.exports = Api;",
    ].join("\n");
    const analysis = analyzeSource(code, { inputPath: "inline.cjs", extension: ".cjs", language: "javascript" });

    expect(analysis.functions.filter((f) => f.exported).map((f) => [f.name, f.exportedAs])).toEqual([
      ["parse", ["parse"]],
      ["config", ["config"]],
      ["inline", ["inline"]],
    ]);
  });
});

describe("analyzer: JSX (component.tsx)", () => {
  it("parses TSX and tracks hooks as dependencies", async () => {
    const analysis = await analyze("fixtures/analyzer/component.tsx");

    expect(fn(analysis, "Counter")).toMatchObject({
      exported: true,
      dependencies: ["react"],
      parameters: [{ name: "{ initial = 0 }", type: "{ initial?: number }" }],
    });
  });
});

describe("analyzer: corpus", () => {
  it("extracts at least 20 hand-written functions across fixtures", async () => {
    const files = [
      "basic.ts", "exports.ts", "dependencies.ts", "commonjs.js", "exports-object.cjs", "default-export.cjs", "component.tsx",
    ];
    const analyses = await Promise.all(files.map((f) => analyze(`fixtures/analyzer/${f}`)));
    const total = analyses.reduce((count, a) => count + a.functions.length, 0);

    expect(total).toBe(36);
  });
});

describe("analyzer: errors and safety", () => {
  it("reports syntax errors with a location", async () => {
    const error = await analyze("fixtures/analyzer/invalid.ts").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ParseError);
    expect(error).toMatchObject({ line: 1 });
  });

  it("omits TypeScript's this parameter", () => {
    const analysis = analyzeSource("export function f(this: Window, x: number) { return x; }", { inputPath: "inline.ts", extension: ".ts", language: "typescript" });

    expect(analysis.functions[0].parameters.map((p) => p.name)).toEqual(["x"]);
  });

  it("never executes the code it analyzes", () => {
    const code = `globalThis.__assertloomRan = true; export function f() { globalThis.__assertloomRan = true; }`;
    analyzeSource(code, { inputPath: "inline.ts", extension: ".ts", language: "typescript" });

    expect((globalThis as Record<string, unknown>).__assertloomRan).toBeUndefined();
  });
});

describe("classifySource", () => {
  it.each([
    ["./utils", "local", undefined],
    ["../lib/db", "local", undefined],
    ["#internal", "local", undefined],
    ["fs", "builtin", undefined],
    ["node:test", "builtin", undefined],
    ["fs/promises", "builtin", undefined],
    ["lodash/fp", "external", "lodash"],
    ["@scope/pkg/sub/path", "external", "@scope/pkg"],
  ])("%s → %s", (source, category, packageName) => {
    expect(classifySource(source)).toEqual(packageName ? { category, packageName } : { category });
  });
});
