import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

function runCli(...args: string[]) {
  const result = spawnSync(process.execPath, [tsxCli, "src/cli/index.ts", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("assertloom CLI", () => {
  it("lists analyze and generate in help", () => {
    const { code, stdout } = runCli("--help");

    expect(code).toBe(0);
    expect(stdout).toContain("analyze");
    expect(stdout).toContain("generate");
  });

  it("analyzes the math example", () => {
    const { code, stdout } = runCli("analyze", "examples/math.ts");

    expect(code).toBe(0);
    expect(stdout).toContain("Found 2 exported functions");
    expect(stdout).toContain("divide(a: number, b: number): number  [throws]");
  });

  it("prints JSON with --json", () => {
    const { code, stdout } = runCli("analyze", "examples/math.ts", "--json");

    expect(code).toBe(0);
    const analysis = JSON.parse(stdout);
    expect(analysis).toMatchObject({ file: "examples/math.ts", language: "typescript", moduleSystem: "esm" });
    expect(analysis.functions.map((f: { name: string }) => f.name)).toEqual(["add", "divide"]);
  });

  it("reports syntax errors without a stack trace", () => {
    const { code, stderr } = runCli("analyze", "fixtures/analyzer/invalid.ts");

    expect(code).toBe(1);
    expect(stderr).toMatch(/^✗ Syntax error at line 1, column \d+/);
    expect(stderr).not.toContain("    at ");
  });

  it("exits non-zero for a missing file", () => {
    const { code, stderr } = runCli("analyze", "examples/missing.ts");

    expect(code).toBe(1);
    expect(stderr).toContain("File not found");
  });

  it("exits non-zero for an unsupported extension", () => {
    const { code, stderr } = runCli("generate", "fixtures/unsupported.py");

    expect(code).toBe(1);
    expect(stderr).toContain("Unsupported file type");
  });
}, 30_000);
