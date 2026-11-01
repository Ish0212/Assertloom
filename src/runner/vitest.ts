import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UserError } from "../errors.js";
import type { TestFramework } from "../types/index.js";
import type { RunFiles } from "./jestConfig.js";
import { findProjectRoot } from "./project.js";

const VITEST_CONFIG_FILES = ["vitest.config", "vite.config"].flatMap((name) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((ext) => `${name}.${ext}`),
);

export interface VitestSetup {
  root: string;
  vitestBin: string;
  /** `vite` as resolved from the project's Vitest, for loading the project's config. */
  viteEntry: string;
  configFile?: string;
  /** Whether @vitest/coverage-v8 is installed. */
  coverage: boolean;
}

function readPackageJson(root: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Vitest when the project uses it and not Jest; Jest otherwise. */
export function detectFramework(sourcePath: string): TestFramework {
  const root = findProjectRoot(sourcePath);
  const pkg = readPackageJson(root);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const usesVitest = "vitest" in deps || VITEST_CONFIG_FILES.some((name) => name.startsWith("vitest.") && existsSync(path.join(root, name)));
  const usesJest = "jest" in deps || existsSync(path.join(root, "jest.config.js")) || "jest" in (pkg as Record<string, unknown>);
  return usesVitest && !usesJest ? "vitest" : "jest";
}

export function detectVitestSetup(sourcePath: string): VitestSetup {
  const root = findProjectRoot(sourcePath);
  const require = createRequire(path.join(root, "package.json"));
  let vitestDir: string;
  try {
    vitestDir = path.dirname(require.resolve("vitest/package.json"));
  } catch {
    throw new UserError(`Vitest is not installed in ${root}. Install it (npm install --save-dev vitest) or use --framework jest.`);
  }
  const fromVitest = createRequire(path.join(vitestDir, "package.json"));
  let coverage = true;
  try {
    require.resolve("@vitest/coverage-v8/package.json");
  } catch {
    coverage = false;
  }

  return {
    root,
    vitestBin: path.join(vitestDir, "vitest.mjs"),
    viteEntry: fromVitest.resolve("vite"),
    configFile: VITEST_CONFIG_FILES.map((name) => path.join(root, name)).find((file) => existsSync(file)),
    coverage,
  };
}

const escapeGlob = (text: string) => text.replace(/[[\]{}()*?!+@]/g, "\\$&");
const relativePosix = (from: string, to: string) => path.relative(from, to).split(path.sep).join("/");

/**
 * Writes a Vitest config that loads the project's own config (if any) and overrides only test selection,
 * reporting, and coverage, so exactly this test file runs.
 */
export async function writeVitestRunConfig(
  setup: VitestSetup,
  files: RunFiles & { resultsPath: string; testTimeoutMs: number },
  runDir: string,
): Promise<string> {
  const coverage = setup.coverage
    ? {
        enabled: true,
        provider: "v8",
        reporter: ["json-summary"],
        reportsDirectory: files.coverageDir,
        reportOnFailure: true,
        include: [escapeGlob(relativePosix(setup.root, files.sourcePath))],
        exclude: [],
      }
    : { enabled: false };
  const overrides = {
    dir: setup.root,
    include: [escapeGlob(relativePosix(setup.root, files.testPath))],
    exclude: [],
    watch: false,
    passWithNoTests: false,
    reporters: ["json"],
    outputFile: { json: files.resultsPath },
    testTimeout: files.testTimeoutMs,
    coverage,
  };

  const file = path.join(runDir, "vitest.config.mjs");
  await writeFile(
    file,
    `const root = ${JSON.stringify(setup.root)};
const configFile = ${JSON.stringify(setup.configFile ?? null)};

export default async (env) => {
  let config = {};
  if (configFile) {
    const { loadConfigFromFile } = await import(${JSON.stringify(pathToFileURL(setup.viteEntry).href)});
    config = (await loadConfigFromFile(env, configFile, root))?.config ?? {};
  }
  const test = { ...config.test };
  if (test.projects || test.workspace) throw new Error("Assertloom: Vitest projects/workspaces are not supported yet.");
  return { ...config, root, test: { ...test, ...${JSON.stringify(overrides)} } };
};
`,
  );
  return file;
}

export function vitestArgs(setup: VitestSetup, configPath: string): string[] {
  return [setup.vitestBin, "run", "--config", configPath, "--root", setup.root];
}

export function describeVitestSetup(setup: VitestSetup): string {
  const config = setup.configFile ? path.basename(setup.configFile) : "no Vitest config";
  return `project Vitest, ${config}${setup.coverage ? "" : ", no coverage (install @vitest/coverage-v8)"}`;
}
