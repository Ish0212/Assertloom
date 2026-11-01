import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCoverage, realPath } from "./coverage.js";
import { writeRunConfig } from "./jestConfig.js";
import { writeNetworkGuard } from "./networkGuard.js";
import { detectJestSetup, jestCanStartIn, type JestSetup } from "./project.js";
import { cleanMessage, parseJestReport, type JestJsonReport } from "./results.js";
import type { RunResult } from "./types.js";
import type { TestFramework } from "../types/index.js";
import { describeVitestSetup, detectVitestSetup, vitestArgs, writeVitestRunConfig } from "./vitest.js";

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_TEST_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 8_000;

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE/i;

export interface RunOptions {
  testPath: string;
  sourcePath: string;
  timeoutMs?: number;
  testTimeoutMs?: number;
  /** Let tests open network connections. Off by default. */
  allowNetwork?: boolean;
  /** Default: jest. */
  framework?: TestFramework;
}

/** Environment for untrusted test code: drops anything that looks like a credential. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV.test(name)) clean[name] = value;
  }
  return { ...clean, NODE_ENV: "test", CI: "true", FORCE_COLOR: "0" };
}

function describeSetup(setup: JestSetup): string {
  const jest = setup.jestSource === "project" ? "project Jest" : "bundled Jest";
  const config =
    setup.config.kind === "default"
      ? "Assertloom default config"
      : setup.config.kind === "file"
        ? path.basename(setup.config.path)
        : `"jest" in package.json`;
  return `${jest}, ${config}`;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    let output = "";
    let timedOut = false;

    const append = (chunk: string) => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

export async function runJest(options: RunOptions): Promise<RunResult> {
  // Jest reports real paths, so configure it with them too.
  const testPath = realPath(options.testPath);
  const sourcePath = realPath(options.sourcePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const testTimeoutMs = options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const vitest = options.framework === "vitest" ? detectVitestSetup(sourcePath) : undefined;
  const jest = vitest ? undefined : detectJestSetup(sourcePath);
  const originalSource = await readFile(sourcePath);
  const runDir = await mkdtemp(path.join(os.tmpdir(), "assertloom-run-"));
  const started = Date.now();

  const network = options.allowNetwork ? "network allowed" : "network blocked";
  const described = vitest ? describeVitestSetup(vitest) : describeSetup(jest!);
  const base = { tests: [], passed: 0, failed: 0, skipped: 0, total: 0, setup: `${described}, ${network}` };
  let result: RunResult | undefined;

  try {
    result = await execute();
    return result;
  } finally {
    await rm(runDir, { recursive: true, force: true });
    const current = await readFile(sourcePath).catch(() => undefined);
    if (!current?.equals(originalSource)) {
      await writeFile(sourcePath, originalSource);
      if (result) result.sourceRestored = true;
    }
  }

  async function execute(): Promise<RunResult> {
    const coverageDir = path.join(runDir, "coverage");
    const resultsPath = path.join(runDir, "results.json");
    const files = { testPath, sourcePath, coverageDir };

    const env = sanitizedEnv();
    if (!options.allowNetwork) {
      env.NODE_OPTIONS = [env.NODE_OPTIONS, await writeNetworkGuard(runDir)].filter(Boolean).join(" ");
    }

    let args: string[];
    let cwd: string;
    if (vitest) {
      args = vitestArgs(vitest, await writeVitestRunConfig(vitest, { ...files, resultsPath, testTimeoutMs }, runDir));
      cwd = vitest.root;
    } else {
      const setup = jest!;
      args = [
        setup.jestBin,
        "--config",
        await writeRunConfig(setup, files, runDir),
        "--runInBand",
        "--ci",
        "--no-watchman",
        "--json",
        "--outputFile",
        resultsPath,
        "--coverage",
        // Open handles left by the code under test would otherwise keep Jest alive until the timeout.
        "--forceExit",
        `--testTimeout=${testTimeoutMs}`,
      ];
      // runDir holds the generated config, so Jest can always find one there.
      cwd = jestCanStartIn(setup.root) ? setup.root : runDir;
    }

    const { timedOut, output } = await runProcess(process.execPath, args, { cwd, timeoutMs, env });

    const durationMs = Date.now() - started;
    let report: JestJsonReport;
    try {
      report = JSON.parse(await readFile(resultsPath, "utf8")) as JestJsonReport;
    } catch {
      if (timedOut) {
        return { ...base, status: "error", durationMs, infra: { kind: "timeout", message: `Jest did not finish within ${timeoutMs / 1000}s.` } };
      }
      return { ...base, status: "error", durationMs, infra: { kind: "crash", message: cleanMessage(output) || "Jest exited without writing results." } };
    }

    const { tests, infra } = parseJestReport(report);
    const passed = tests.filter((t) => t.status === "passed").length;
    const failed = tests.filter((t) => t.status === "failed").length;
    const skipped = tests.filter((t) => t.status === "skipped").length;

    if (!infra && tests.length === 0) {
      return { ...base, status: "error", durationMs, infra: { kind: "suite-error", message: cleanMessage(output) || "Jest found no tests to run." } };
    }

    return {
      ...base,
      status: infra ? "error" : failed > 0 ? "failed" : "passed",
      tests,
      passed,
      failed,
      skipped,
      total: tests.length,
      infra,
      coverage: infra ? undefined : await readCoverage(path.join(coverageDir, "coverage-summary.json"), sourcePath),
      durationMs,
    };
  }
}
