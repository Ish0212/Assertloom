import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const CONFIG_FILES = ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json", "jest.config.ts", "jest.config.mts", "jest.config.cts"];

export type JestConfigSource =
  | { kind: "default" }
  | { kind: "file"; path: string }
  | { kind: "package-json"; config: Record<string, unknown> };

export interface JestSetup {
  root: string;
  jestBin: string;
  jestSource: "project" | "bundled";
  config: JestConfigSource;
  /** Things the user should know, such as falling back to the bundled Jest. */
  notes: string[];
}

/**
 * Nearest directory with a package.json. The search stops at a git repository root, and stray
 * package.json files in the home directory or at the filesystem root are ignored.
 */
export function findProjectRoot(fromFile: string): string {
  const fileDir = path.dirname(path.resolve(fromFile));
  const home = path.resolve(os.homedir());

  for (let dir = fileDir; ; dir = path.dirname(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return fileDir;
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (existsSync(path.join(dir, ".git"))) return fileDir;
  }
}

function resolveJestBin(require: NodeJS.Require): string | undefined {
  try {
    return path.join(path.dirname(require.resolve("jest/package.json")), "bin", "jest.js");
  } catch {
    return undefined;
  }
}

function bundledJestBin(): string {
  const bin = resolveJestBin(createRequire(import.meta.url));
  if (!bin) throw new Error("Assertloom's bundled Jest is missing; reinstall Assertloom.");
  return bin;
}

export function detectJestSetup(sourcePath: string): JestSetup {
  const root = findProjectRoot(sourcePath);
  const notes: string[] = [];
  let config: JestConfigSource = { kind: "default" };

  const configFile = CONFIG_FILES.map((name) => path.join(root, name)).find((file) => existsSync(file));
  if (configFile && /\.[cm]?ts$/.test(configFile)) {
    notes.push(`${path.basename(configFile)} is not supported yet; using Assertloom's default Jest config.`);
  } else if (configFile) {
    config = { kind: "file", path: configFile };
  } else {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { jest?: Record<string, unknown> };
      if (pkg.jest && typeof pkg.jest === "object") config = { kind: "package-json", config: pkg.jest };
    } catch {
      // No readable package.json: use the default config.
    }
  }

  if (config.kind !== "default" && (config.kind === "package-json" ? "projects" in config.config : false)) {
    notes.push("Jest `projects` configurations are not supported yet; using Assertloom's default Jest config.");
    config = { kind: "default" };
  }

  const projectJest = config.kind === "default" ? undefined : resolveJestBin(createRequire(path.join(root, "package.json")));
  if (config.kind !== "default" && !projectJest) {
    notes.push("The project has a Jest config but Jest is not installed; using Assertloom's bundled Jest.");
  }

  return projectJest
    ? { root, jestBin: projectJest, jestSource: "project", config, notes }
    : { root, jestBin: bundledJestBin(), jestSource: "bundled", config, notes };
}
