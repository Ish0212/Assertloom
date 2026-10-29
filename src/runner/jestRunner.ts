import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCoverage } from "./coverage.js";
import { writeRunConfig } from "./jestConfig.js";
import { detectJestSetup, type JestSetup } from "./project.js";
import { cleanMessage, parseJestReport, type JestJsonReport } from "./results.js";
import type { RunResult } from "./types.js";

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_TEST_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_CHARS = 8_000;

const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE/i;

export interface RunOptions {
  testPath: string;
  sourcePath: string;
  timeoutMs?: number;
  testTimeoutMs?: number;
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
  options: { cwd: string; timeoutMs: number },
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: sanitizedEnv(), windowsHide: true });
    let output = "";
    let timedOut = false;

    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
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
  const testPath = path.resolve(options.testPath);
  const sourcePath = path.resolve(options.sourcePath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const setup = detectJestSetup(sourcePath);
  const runDir = await mkdtemp(path.join(os.tmpdir(), "assertloom-run-"));
  const started = Date.now();

  const base = { tests: [], passed: 0, failed: 0, skipped: 0, total: 0, setup: describeSetup(setup) };

  try {
    const coverageDir = path.join(runDir, "coverage");
    const resultsPath = path.join(runDir, "results.json");
    const configPath = await writeRunConfig(setup, { testPath, sourcePath, coverageDir }, runDir);

    const { timedOut, output } = await runProcess(
      process.execPath,
      [
        setup.jestBin,
        "--config",
        configPath,
        "--runInBand",
        "--ci",
        "--no-watchman",
        "--json",
        "--outputFile",
        resultsPath,
        "--coverage",
        `--testTimeout=${options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS}`,
      ],
      { cwd: setup.root, timeoutMs },
    );

    const durationMs = Date.now() - started;
    if (timedOut) {
      return { ...base, status: "error", durationMs, infra: { kind: "timeout", message: `Jest did not finish within ${timeoutMs / 1000}s.` } };
    }

    let report: JestJsonReport;
    try {
      report = JSON.parse(await readFile(resultsPath, "utf8")) as JestJsonReport;
    } catch {
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
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
