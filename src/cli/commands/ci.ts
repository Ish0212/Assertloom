import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Option, type Command } from "commander";
import { createProvider, PROVIDERS, type LLMProvider, type ProviderOptions } from "../../ai/index.js";
import { Budget } from "../../ai/pricing.js";
import { UserError } from "../../errors.js";
import { MAX_REPAIR_ATTEMPTS } from "../../repair/index.js";
import { cell, computeTotals, createRedactor, evaluatePolicy, FAIL_ON, renderSummary, type CiReport, type FailOn } from "../../ci/report.js";
import { runFiles, type FileReport } from "../../ci/run.js";
import { changedFiles, classify, explicitFiles, repositoryRoot, splitLines, splitList, type Candidate } from "../../ci/select.js";
import type { RunResult } from "../../runner/index.js";

const { version } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };

/** Environment variables that hold provider credentials. Their values are redacted from everything Assertloom writes. */
export const CREDENTIAL_ENV = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ASSERTLOOM_API_KEY"];

export const DEFAULT_CI_MAX_FILES = 10;
export const DEFAULT_CI_MAX_COST_USD = 1;
const MAX_TIMEOUT_SECONDS = 3600;

export interface CiCommandOptions {
  base?: string;
  head?: string;
  files?: string;
  include?: string;
  exclude?: string;
  defaultExcludes: boolean;
  maxFiles: string;
  maxCost: string;
  maxTokens?: string;
  maxAttempts: string;
  timeout: string;
  out: string;
  failOn: string;
  provider: string;
  model?: string;
  baseUrl?: string;
  workingDirectory?: string;
  dryRun?: boolean;
  githubSummary?: string;
  githubOutput?: string;
}

export interface CiDependencies {
  createProvider: (name: string, options: ProviderOptions) => LLMProvider;
  runTests?: (testPath: string, sourcePath: string) => Promise<RunResult>;
  log: (line: string) => void;
}

/** Commander passes "" for inputs the action leaves empty; treat them as unset. */
const given = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value.trim());

function wholeNumber(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function noNewlines(value: string, name: string): string {
  if (/[\r\n\0]/.test(value)) throw new UserError(`${name} must not contain line breaks.`);
  return value;
}

/** Only an empty directory or one holding a previous Assertloom report is reused, so nothing else is ever deleted. */
async function prepareOutDir(outDir: string): Promise<void> {
  const entries = await readdir(outDir).catch(() => undefined);
  if (entries && entries.length && !entries.includes("report.json")) {
    throw new UserError(`${outDir} exists and is not an Assertloom report directory. Choose an empty or new directory with --out.`);
  }
  for (const name of ["tests", "report.json", "summary.md"]) await rm(path.join(outDir, name), { recursive: true, force: true });
  await mkdir(path.join(outDir, "tests"), { recursive: true });
}

export async function runCi(options: CiCommandOptions, deps: CiDependencies): Promise<CiReport> {
  const log = deps.log;
  const cwd = path.resolve(given(options.workingDirectory) ?? ".");
  const failOn = (given(options.failOn) ?? "errors") as FailOn;
  if (!FAIL_ON.includes(failOn)) throw new UserError(`--fail-on must be one of: ${FAIL_ON.join(", ")}.`);
  const maxFiles = wholeNumber(given(options.maxFiles) ?? String(DEFAULT_CI_MAX_FILES), "--max-files", 1, 1000);
  const maxAttempts = wholeNumber(given(options.maxAttempts) ?? String(MAX_REPAIR_ATTEMPTS), "--max-attempts", 0, MAX_REPAIR_ATTEMPTS);
  const timeoutSeconds = wholeNumber(given(options.timeout) ?? "120", "--timeout", 1, MAX_TIMEOUT_SECONDS);
  const maxCost = Number(given(options.maxCost) ?? DEFAULT_CI_MAX_COST_USD);
  if (!Number.isFinite(maxCost) || maxCost <= 0) throw new UserError("--max-cost must be a positive number of US dollars.");
  const maxTokensInput = given(options.maxTokens);
  const maxTokens = maxTokensInput === undefined ? undefined : wholeNumber(maxTokensInput, "--max-tokens", 1, 100_000_000);
  const outDir = path.resolve(cwd, noNewlines(given(options.out) ?? "assertloom-report", "--out"));
  const redact = createRedactor(CREDENTIAL_ENV.map((name) => process.env[name]));

  const base = given(options.base);
  const fileInput = splitLines(options.files);
  if (!base && fileInput.length === 0) {
    throw new UserError(
      "Nothing to select: pass --base (the pull request's base commit) or --files. In GitHub Actions, run on pull_request or set the `files` input.",
    );
  }

  await prepareOutDir(outDir);
  const report: CiReport = {
    schemaVersion: 1,
    assertloom: version,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    mode: fileInput.length ? "files" : "pull-request",
    ...(fileInput.length ? {} : { base, head: given(options.head) ?? "HEAD" }),
    provider: options.provider,
    model: given(options.model) ?? "",
    limits: { maxFiles, maxCostUsd: maxCost, maxTokens: maxTokens ?? null, maxAttempts, timeoutSeconds },
    budget: { exhausted: false, costKnown: false, spentUsd: null, tokens: { input: 0, output: 0 } },
    totals: computeTotals([]),
    policy: { failOn, failed: false, reasons: [] },
    files: [],
  };

  let budget: Budget | undefined;
  const write = async (files: FileReport[]) => {
    report.files = files;
    report.totals = computeTotals(files);
    if (budget) {
      report.budget = {
        ...report.budget,
        costKnown: budget.priced,
        spentUsd: budget.spentUsd ?? null,
        tokens: { input: budget.usage.inputTokens, output: budget.usage.outputTokens },
      };
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(outDir, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n");
    await writeFile(path.join(outDir, "summary.md"), redact(renderSummary(report)));
  };

  let candidates: Candidate[] = [];
  try {
    const root = await repositoryRoot(cwd);
    const files = fileInput.length ? explicitFiles(fileInput, root, cwd) : await changedFiles({ cwd: root, base: base!, head: given(options.head) });
    candidates = await classify(files, {
      root,
      include: splitList(options.include),
      exclude: splitList(options.exclude),
      useDefaultExcludes: options.defaultExcludes,
    });
    const eligible = candidates.filter((c) => !c.skip);
    log(`Selected ${eligible.length} of ${candidates.length} changed files${eligible.length > maxFiles ? ` (processing at most ${maxFiles})` : ""}.`);

    if (options.dryRun || eligible.length === 0) {
      if (eligible.length === 0) log("No eligible JavaScript or TypeScript source files changed.");
      const files = candidates.map((c): FileReport => skippedReport(c, "dry-run"));
      await write(files);
      return finish(report, failOn, files, write, redact);
    }

    const provider = deps.createProvider(options.provider, { model: given(options.model), baseUrl: given(options.baseUrl) });
    report.model = provider.model;
    budget = new Budget(provider.model, maxCost, maxTokens);
    if (!budget.priced && maxTokens === undefined) {
      throw new UserError(`${provider.model} has no known price, so a dollar limit cannot be enforced. Set a shared token limit with --max-tokens.`);
    }
    log(`Using ${provider.name} (${provider.model}); shared limit ${budget.describeLimit()}.`);

    const result = await runFiles({
      root,
      candidates,
      provider,
      budget,
      maxFiles,
      maxAttempts,
      timeoutMs: timeoutSeconds * 1000,
      testsDir: path.join(outDir, "tests"),
      onProgress: write,
      runTests: deps.runTests,
      log: (line) => log(redact(line)),
    });
    report.budget.exhausted = result.budgetExhausted;
    await write(result.files);
    return finish(report, failOn, result.files, write, redact);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /_API_KEY is not set/.test(message) && process.env.GITHUB_ACTIONS ? " In the GitHub Action, pass the key from a secret with the `api-key` input." : "";
    report.error = redact(message + hint);
    await write(report.files.length ? report.files : candidates.map((c) => skippedReport(c, "not-processed")));
    throw error instanceof UserError ? new UserError(report.error) : error;
  }
}

/** A file that was not processed: skipped by selection, or eligible but not reached (`reason`). */
function skippedReport(c: Candidate, reason: "dry-run" | "not-processed"): FileReport {
  return {
    path: c.path,
    ...(c.from ? { from: c.from } : {}),
    change: c.status,
    status: "skipped",
    ...(c.skip
      ? { skipReason: c.skip.reason, detail: c.skip.detail }
      : { skipReason: reason, detail: reason === "dry-run" ? "eligible; dry run, not processed" : "eligible; not processed because the run stopped" }),
    generated: 0,
    accepted: 0,
    rejected: 0,
    repaired: 0,
    flaggedAsSourceBugs: 0,
    removed: 0,
    gaveUp: 0,
    repairRounds: 0,
    regressions: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: null,
  };
}

async function finish(
  report: CiReport,
  failOn: FailOn,
  files: FileReport[],
  write: (files: FileReport[]) => Promise<void>,
  redact: (text: string) => string,
): Promise<CiReport> {
  report.policy = { failOn, ...evaluatePolicy(failOn, files) };
  await write(files);
  // Callers get the same redacted content that was written to disk.
  return JSON.parse(redact(JSON.stringify(report))) as CiReport;
}

/** Writes `key=value` pairs for GitHub Actions step outputs. Values never contain line breaks. */
async function writeGithubOutputs(file: string, report: CiReport, outDir: string): Promise<void> {
  const t = report.totals;
  const outputs: Record<string, string> = {
    "report-dir": outDir,
    "report-path": path.join(outDir, "report.json"),
    "summary-path": path.join(outDir, "summary.md"),
    "files-selected": String(t.files.selected),
    "files-processed": String(t.files.processed),
    "files-skipped": String(t.files.skipped),
    "files-failed": String(t.files.failed),
    "tests-final-passed": String(t.tests.final.passed),
    "tests-final-failed": String(t.tests.final.failed),
    "budget-exhausted": String(report.budget.exhausted),
    result: report.error ? "error" : report.policy.failed ? "failed" : "passed",
  };
  const lines = Object.entries(outputs)
    .filter(([, v]) => !/[\r\n]/.test(v))
    .map(([k, v]) => `${k}=${v}\n`);
  await appendFile(file, lines.join(""));
}

export function registerCiCommand(program: Command, deps: Partial<CiDependencies> = {}): void {
  program
    .command("ci")
    .description("Generate, run, and repair tests for JavaScript/TypeScript files changed in a pull request; write a report and test previews")
    .option("--base <commit>", "base commit of the pull request; files changed on --head since it are selected")
    .option("--head <commit>", "head commit (default: HEAD)")
    .option("--files <list>", "newline-separated files to process instead of a diff (for manual runs)")
    .option("--include <globs>", "only consider files matching these globs (newline- or comma-separated)")
    .option("--exclude <globs>", "skip files matching these globs, in addition to the defaults")
    .option("--no-default-excludes", "do not skip tests, node_modules, build output, declarations, and generated files by default")
    .option("--max-files <n>", "process at most this many files", String(DEFAULT_CI_MAX_FILES))
    .option("--max-cost <usd>", "spending limit in US dollars for the whole run, shared by all files and repair rounds", String(DEFAULT_CI_MAX_COST_USD))
    .option("--max-tokens <n>", "shared token limit for models without a known price (required for them)")
    .option("--max-attempts <n>", `repair rounds per file, 0-${MAX_REPAIR_ATTEMPTS}`, String(MAX_REPAIR_ATTEMPTS))
    .option("--timeout <seconds>", "time limit for each test run", "120")
    .option("--out <dir>", "directory for report.json, summary.md, and tests/", "assertloom-report")
    .addOption(new Option("--fail-on <policy>", "exit non-zero on: never, errors (files that could not be processed), or tests (also any test not passing)").default("errors"))
    .addOption(new Option("--provider <name>", "LLM provider").choices(PROVIDERS).default("openai"))
    .option("--model <model>", "model name (default: $ASSERTLOOM_MODEL or the provider default)")
    .option("--base-url <url>", "server URL for --provider openai-compatible (default: $ASSERTLOOM_BASE_URL)")
    .option("--working-directory <dir>", "directory inside the repository to run in (default: current directory)")
    .option("--dry-run", "select files and write the report without calling a model or running tests")
    .option("--github-summary <file>", "append the Markdown summary to this file ($GITHUB_STEP_SUMMARY)")
    .option("--github-output <file>", "append step outputs to this file ($GITHUB_OUTPUT)")
    .action(async (options: CiCommandOptions) => {
      const full: CiDependencies = { createProvider, log: (line) => console.log(line), ...deps };
      const outDir = path.resolve(given(options.workingDirectory) ?? ".", given(options.out) ?? "assertloom-report");
      let report: CiReport | undefined;
      let failure: string | undefined;
      try {
        report = await runCi(options, full);
      } catch (error) {
        failure = createRedactor(CREDENTIAL_ENV.map((name) => process.env[name]))(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        const summary = await readFile(path.join(outDir, "summary.md"), "utf8").catch(() => undefined);
        if (given(options.githubSummary)) {
          // A configuration error stops the run before any report exists; still say why in the job summary.
          const text = summary ?? `## Assertloom\n\n**Could not run:** ${cell(failure ?? "unknown error")}\n`;
          await appendFile(options.githubSummary!, text + "\n");
        }
        if (given(options.githubOutput)) {
          if (report) await writeGithubOutputs(options.githubOutput!, report, outDir);
          // Partial results may exist even after an error; expose them so they are uploaded.
          else await appendFile(options.githubOutput!, `result=error\n${summary !== undefined && !/[\r\n]/.test(outDir) ? `report-dir=${outDir}\n` : ""}`);
        }
      }
      const t = report.totals;
      console.log(
        `\n${t.files.processed} processed, ${t.files.skipped} skipped, ${t.files.failed} failed. ` +
          `Final tests: ${t.tests.final.passed} passed, ${t.tests.final.failed} failed, ${t.tests.final.skipped} skipped.`,
      );
      console.log(`Report: ${path.join(outDir, "report.json")}`);
      if (report.policy.failed) {
        for (const reason of report.policy.reasons) console.error(`✗ ${reason} (--fail-on ${report.policy.failOn})`);
        process.exitCode = 1;
      }
    });
}
