import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFramework, runJest } from "../src/runner/index.js";
import { classifySuiteFailure, classifyTestFailure } from "../src/runner/results.js";

// Inside the repo, so the project resolves the repo's own vitest and @vitest/coverage-v8.
const runsDir = path.resolve(import.meta.dirname, "..", ".vitest-runs");
let project: string;

beforeAll(async () => {
  await mkdir(runsDir, { recursive: true });
  project = await mkdtemp(path.join(runsDir, "project-"));
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ type: "module", devDependencies: { vitest: "*" } }),
  );
  await writeFile(
    path.join(project, "math.ts"),
    `export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
`,
  );
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("Vitest runner", () => {
  it("detects Vitest-only projects", () => {
    expect(detectFramework(path.join(project, "math.ts"))).toBe("vitest");
  });

  it("runs one test file with Vitest and reports results and coverage", async () => {
    const testPath = path.join(project, "math.test.ts");
    await writeFile(
      testPath,
      `import { describe, expect, it } from "vitest";
import { clamp } from "./math";

describe("clamp", () => {
  it("clamps low values", () => expect(clamp(-1, 0, 5)).toBe(0));
  it("is wrong on purpose", () => expect(clamp(9, 0, 5)).toBe(9));
});
`,
    );
    // A second test file the run must ignore.
    await writeFile(path.join(project, "other.test.ts"), `import { it } from "vitest";\nit("other", () => {});\n`);

    const result = await runJest({ testPath, sourcePath: path.join(project, "math.ts"), framework: "vitest" });

    expect(result.infra).toBeUndefined();
    expect(result.setup).toContain("project Vitest");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.tests.find((test) => test.status === "failed")?.failure?.kind).toBe("assertion");
    expect(result.coverage?.lines).toBeGreaterThan(0);
    expect(result.coverage?.lines).toBeLessThan(100);
  }, 120_000);
});

describe("Vitest failure messages", () => {
  it("classifies timeouts and unresolved imports", () => {
    expect(classifyTestFailure("Error: Test timed out in 5000ms.")).toBe("timeout");
    expect(classifyTestFailure("AssertionError: expected 9 to be 5 // Object.is equality")).toBe("assertion");
    expect(classifySuiteFailure('Error: Failed to resolve import "./nope" from "a.test.ts"').kind).toBe("module-not-found");
  });
});
