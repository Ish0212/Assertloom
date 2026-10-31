/**
 * Runs Assertloom's full pipeline (generate → run → repair) on pinned open-source files and
 * records success rates, runtime, model cost, and coverage.
 *
 *   npm run bench                         # all targets, default model
 *   npm run bench -- --only ms,cookie     # a subset
 *   npm run bench -- --model gpt-5.4      # another model
 *
 * Needs OPENAI_API_KEY. Results go to bench/results/latest.{json,md}.
 */
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createProvider } from "../src/ai/index.js";
import { Budget, formatUsd, PRICES_CHECKED } from "../src/ai/pricing.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests, writeTestFile, type GenerationResult } from "../src/generator/index.js";
import { repairTests, summarize, type RepairResult, type RunSummary } from "../src/repair/index.js";
import { runJest, type RunResult } from "../src/runner/index.js";
import { TARGETS, type Target } from "./targets.js";

const benchDir = import.meta.dirname;
const cacheDir = path.join(benchDir, ".cache");
const resultsDir = path.join(benchDir, "results");

interface TargetResult {
  package: string;
  file: string;
  why: string;
  exportedFunctions: number;
  testedFunctions: number;
  generated: number;
  accepted: number;
  /** Why generated cases failed validation, with counts. */
  rejected: Record<string, number>;
  mocked: string[];
  initial?: RunSummary & { infra?: string };
  final?: RunSummary & { infra?: string };
  repairAttempts: number;
  stopReason?: string;
  flaggedAsSourceBugs: number;
  gaveUp: number;
  durationMs: { generation: number; firstRun: number; repair: number; total: number };
  tokens: { input: number; output: number };
  costUsd: number | null;
  error?: string;
}

const run = (command: string, cwd: string) => execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function unpack(target: Target, workDir: string): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const [{ filename }] = JSON.parse(run(`npm pack ${target.package} --json --pack-destination "${cacheDir}"`, cacheDir)) as Array<{ filename: string }>;
  run(`tar -xzf "${path.join(cacheDir, filename)}" -C "${workDir}"`, workDir);
  return path.join(workDir, "package", target.file);
}

const withInfra = (result: RunResult): RunSummary & { infra?: string } => ({
  ...summarize(result),
  ...(result.infra ? { infra: `${result.infra.kind}: ${result.infra.message.split("\n")[0]}` } : {}),
});

async function benchmark(target: Target, model: string | undefined, maxCost: number, testsDir: string): Promise<TargetResult> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "assertloom-bench-"));
  const provider = createProvider("openai", model);
  const budget = new Budget(provider.model, maxCost);
  const result: TargetResult = {
    package: target.package,
    file: target.file,
    why: target.why,
    exportedFunctions: 0,
    testedFunctions: 0,
    generated: 0,
    accepted: 0,
    rejected: {},
    mocked: [],
    repairAttempts: 0,
    flaggedAsSourceBugs: 0,
    gaveUp: 0,
    durationMs: { generation: 0, firstRun: 0, repair: 0, total: 0 },
    tokens: { input: 0, output: 0 },
    costUsd: null,
  };
  const started = Date.now();
  const lap = (since: number) => Date.now() - since;

  try {
    const sourcePath = await unpack(target, workDir);
    const source = await validateSourceFile(sourcePath, workDir);

    let t = Date.now();
    let generation: GenerationResult;
    try {
      generation = await generateTests({ source, provider, budget });
    } finally {
      result.durationMs.generation = lap(t);
    }
    const accepted = generation.suites.reduce((n, s) => n + s.cases.length, 0);
    Object.assign(result, {
      exportedFunctions: generation.analysis.functions.filter((f) => f.exported).length,
      testedFunctions: generation.suites.length,
      generated: accepted + generation.rejected.length,
      accepted,
      mocked: [...generation.mocks.mocked.map((m) => m.source), ...generation.mocks.globals.map((g) => `global ${g}`)],
    });
    for (const { reason } of generation.rejected) result.rejected[reason] = (result.rejected[reason] ?? 0) + 1;

    await writeTestFile(generation.testPath, generation.content);
    t = Date.now();
    const firstRun = await runJest({ testPath: generation.testPath, sourcePath: source.absolutePath });
    result.durationMs.firstRun = lap(t);
    result.initial = withInfra(firstRun);

    let finalRun = firstRun;
    let content = generation.content;
    if (firstRun.status === "failed") {
      t = Date.now();
      const repair: RepairResult = await repairTests({
        provider,
        analysis: generation.analysis,
        promptSource: generation.promptSource,
        sourcePath: source.absolutePath,
        testPath: generation.testPath,
        extension: source.extension,
        preamble: generation.preamble,
        mockSummary: generation.mocks.summary,
        suites: generation.suites,
        initialRun: firstRun,
        budget,
      });
      result.durationMs.repair = lap(t);
      finalRun = repair.run;
      content = repair.content;
      result.repairAttempts = repair.attempts.length;
      result.stopReason = repair.stopReason;
      result.flaggedAsSourceBugs = repair.attempts.flatMap((a) => a.changes).filter((c) => c.action === "skip").length;
      result.gaveUp = repair.gaveUp.length;
    } else {
      result.stopReason = firstRun.status === "passed" ? "all-passing" : "unrepairable";
    }
    result.final = withInfra(finalRun);

    const name = target.package.split("@")[0];
    await writeFile(path.join(testsDir, `${name}.test${source.extension}`), content);
  } catch (error) {
    result.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  } finally {
    result.durationMs.total = lap(started);
    result.tokens = { input: budget.usage.inputTokens, output: budget.usage.outputTokens };
    result.costUsd = budget.spentUsd ?? null;
    await rm(workDir, { recursive: true, force: true });
  }
  return result;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function aggregate(results: TargetResult[]) {
  const ran = results.filter((r) => r.initial && !r.initial.infra);
  const total = (s?: RunSummary) => (s ? s.passed + s.failed + s.skipped : 0);
  const initialFailed = sum(ran.map((r) => r.initial!.failed));
  const repaired = sum(ran.map((r) => Math.max(0, r.final!.passed - r.initial!.passed)));
  const coverage = ran.map((r) => r.final?.coverage?.lines).filter((v): v is number => typeof v === "number");
  const branches = ran.map((r) => r.final?.coverage?.branches).filter((v): v is number => typeof v === "number");
  const costs = results.map((r) => r.costUsd).filter((c): c is number => c !== null);

  return {
    files: results.length,
    generation: {
      filesWithTests: results.filter((r) => r.accepted > 0).length,
      fileRate: pct(results.filter((r) => r.accepted > 0).length, results.length),
      generatedCases: sum(results.map((r) => r.generated)),
      acceptedCases: sum(results.map((r) => r.accepted)),
      caseRate: pct(sum(results.map((r) => r.accepted)), sum(results.map((r) => r.generated))),
    },
    execution: {
      filesThatRan: ran.length,
      fileRate: pct(ran.length, results.length),
      firstRunPassed: sum(ran.map((r) => r.initial!.passed)),
      firstRunTotal: sum(ran.map((r) => total(r.initial))),
      firstRunPassRate: pct(sum(ran.map((r) => r.initial!.passed)), sum(ran.map((r) => total(r.initial)))),
    },
    repair: {
      initiallyFailing: initialFailed,
      repaired,
      rate: pct(repaired, initialFailed),
      flaggedAsSourceBugs: sum(results.map((r) => r.flaggedAsSourceBugs)),
      gaveUp: sum(results.map((r) => r.gaveUp)),
      filesNeedingRepair: ran.filter((r) => r.repairAttempts > 0).length,
    },
    final: {
      passed: sum(ran.map((r) => r.final!.passed)),
      total: sum(ran.map((r) => total(r.final))),
      passRate: pct(sum(ran.map((r) => r.final!.passed)), sum(ran.map((r) => total(r.final)))),
      filesAllPassing: ran.filter((r) => r.final!.status === "passed" && r.final!.failed === 0 && r.final!.skipped === 0).length,
    },
    coverage: {
      before: 0,
      meanLines: coverage.length ? Math.round((sum(coverage) / coverage.length) * 10) / 10 : null,
      meanBranches: branches.length ? Math.round((sum(branches) / branches.length) * 10) / 10 : null,
    },
    runtime: {
      totalSeconds: Math.round(sum(results.map((r) => r.durationMs.total)) / 100) / 10,
      medianSecondsPerFile: Math.round(median(results.map((r) => r.durationMs.total)) / 100) / 10,
    },
    cost: {
      totalUsd: Math.round(sum(costs) * 10_000) / 10_000,
      meanUsdPerFile: costs.length ? Math.round((sum(costs) / costs.length) * 10_000) / 10_000 : null,
      tokens: { input: sum(results.map((r) => r.tokens.input)), output: sum(results.map((r) => r.tokens.output)) },
    },
  };
}

const show = (value: number | null | undefined, suffix = "%") => (value === null || value === undefined ? "–" : `${value}${suffix}`);

function markdown(meta: Record<string, string>, results: TargetResult[], totals: ReturnType<typeof aggregate>): string {
  const rows = results.map((r) => {
    const status = r.error
      ? `error: ${r.error}`
      : r.final?.infra
        ? `did not run (${r.final.infra.split(":")[0]})`
        : `${r.final!.passed}/${r.final!.passed + r.final!.failed + r.final!.skipped} passing`;
    const first = r.initial && !r.initial.infra ? `${r.initial.passed}/${r.initial.passed + r.initial.failed + r.initial.skipped}` : "–";
    return `| \`${r.package}\` ${r.file} | ${r.testedFunctions}/${r.exportedFunctions} | ${r.accepted}/${r.generated} | ${first} | ${status} | ${r.repairAttempts} | ${show(r.final?.coverage?.lines)} | ${show(r.final?.coverage?.branches)} | ${(r.durationMs.total / 1000).toFixed(1)}s | ${r.costUsd === null ? "–" : formatUsd(r.costUsd)} | ${r.mocked.join(", ") || "–"} |`;
  });
  const t = totals;
  return `# Assertloom benchmark

${Object.entries(meta)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

| Target | Functions tested | Valid cases | First run | Final | Repair rounds | Lines | Branches | Time | Cost | Mocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

| Metric | Result |
| --- | --- |
| Test generation (files with valid tests) | ${t.generation.filesWithTests}/${t.files} (${show(t.generation.fileRate)}) |
| Test generation (cases passing validation) | ${t.generation.acceptedCases}/${t.generation.generatedCases} (${show(t.generation.caseRate)}) |
| Execution (files whose tests ran) | ${t.execution.filesThatRan}/${t.files} (${show(t.execution.fileRate)}) |
| Execution (tests passing on first run) | ${t.execution.firstRunPassed}/${t.execution.firstRunTotal} (${show(t.execution.firstRunPassRate)}) |
| Repair (initially failing tests fixed) | ${t.repair.repaired}/${t.repair.initiallyFailing} (${show(t.repair.rate)}) |
| Repair (flagged as source bugs / set aside) | ${t.repair.flaggedAsSourceBugs} / ${t.repair.gaveUp} |
| Final (tests passing) | ${t.final.passed}/${t.final.total} (${show(t.final.passRate)}) |
| Files with every test passing (none skipped) | ${t.final.filesAllPassing}/${t.files} |
| Line coverage, before → after (mean) | ${t.coverage.before}% → ${show(t.coverage.meanLines)} |
| Branch coverage after (mean) | ${show(t.coverage.meanBranches)} |
| Runtime (total / median per file) | ${t.runtime.totalSeconds}s / ${t.runtime.medianSecondsPerFile}s |
| Model cost (total / mean per file) | ${formatUsd(t.cost.totalUsd)} / ${t.cost.meanUsdPerFile === null ? "–" : formatUsd(t.cost.meanUsdPerFile)} |
| Tokens (in / out) | ${t.cost.tokens.input.toLocaleString("en-US")} / ${t.cost.tokens.output.toLocaleString("en-US")} |
`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      only: { type: "string" },
      "max-cost": { type: "string", default: "0.5" },
    },
  });
  const only = values.only?.split(",").map((s) => s.trim());
  const targets = only ? TARGETS.filter((t) => only.includes(t.package.split("@")[0])) : TARGETS;
  if (targets.length === 0) throw new Error(`No targets match --only ${values.only}`);

  const model = createProvider("openai", values.model).model;
  const testsDir = path.join(resultsDir, "tests");
  await rm(testsDir, { recursive: true, force: true });
  await mkdir(testsDir, { recursive: true });

  const results: TargetResult[] = [];
  for (const target of targets) {
    process.stdout.write(`${target.package} ${target.file} ... `);
    const result = await benchmark(target, values.model, Number(values["max-cost"]), testsDir);
    results.push(result);
    console.log(
      result.error
        ? `error: ${result.error}`
        : `${result.final?.passed ?? 0} passing, ${result.final?.failed ?? 0} failing, ${result.final?.skipped ?? 0} skipped (${(result.durationMs.total / 1000).toFixed(1)}s)`,
    );
  }

  const pkg = JSON.parse(await readFile(path.join(benchDir, "..", "package.json"), "utf8")) as { version: string };
  const meta = {
    Date: new Date().toISOString().slice(0, 10),
    Assertloom: pkg.version,
    Model: model,
    Prices: `OpenAI standard rates checked ${PRICES_CHECKED}`,
    Node: process.version,
    OS: `${os.platform()} ${os.arch()}`,
    "Spending limit": `$${values["max-cost"]} per file`,
    "Coverage before": "0% for every file (published npm packages ship without their tests)",
  };
  const totals = aggregate(results);
  await writeFile(path.join(resultsDir, "latest.json"), JSON.stringify({ meta, totals, results }, null, 2) + "\n");
  await writeFile(path.join(resultsDir, "latest.md"), markdown(meta, results, totals));
  console.log(`\n${markdown(meta, results, totals)}`);
}

await main();
