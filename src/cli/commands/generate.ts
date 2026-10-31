import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Option, type Command } from "commander";
import { createProvider, PROVIDERS } from "../../ai/index.js";
import { Budget, estimateCost, formatUsd } from "../../ai/pricing.js";
import type { TokenUsage } from "../../ai/provider.js";
import { UserError } from "../../errors.js";
import { generateTests, testPathFor, TestFileExistsError, writeTestFile, type GenerationResult } from "../../generator/index.js";
import { MAX_REPAIR_ATTEMPTS, repairTests, summarize, type RepairResult, type StopReason } from "../../repair/index.js";
import { runJest, type RunResult } from "../../runner/index.js";
import { formatCoverage, printRunResult } from "../report.js";
import { validateSourceFile } from "../validateFile.js";

interface GenerateOptions {
  provider: string;
  model?: string;
  out?: string;
  dryRun?: boolean;
  force?: boolean;
  run: boolean;
  repair: boolean;
  maxAttempts: string;
  report?: string;
  mock: string[];
  keepReal: string[];
  allowNetwork?: boolean;
  maxCost: string;
}

export const DEFAULT_MAX_COST_USD = 1;

function tokens(usage: TokenUsage, model: string): string {
  const cost = estimateCost(model, usage);
  return `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out${cost === undefined ? "" : `, ≈${formatUsd(cost)}`}`;
}

const collect = (value: string, previous: string[]) => [...previous, value];

function printMocks(result: GenerationResult): void {
  const { mocked, real, globals } = result.mocks;
  const names = [...mocked.map((m) => m.source), ...globals.map((g) => `global ${g}`)];
  if (names.length) console.log(`✓ Mocked ${names.length} ${names.length === 1 ? "dependency" : "dependencies"}: ${names.join(", ")}`);
  for (const m of mocked) console.log(`  - ${m.source}: ${m.reason}${m.virtual ? " (virtual mock)" : ""}`);
  if (real.length) console.log(`  Kept real: ${real.map((r) => `${r.source} (${r.reason})`).join(", ")}`);
}

function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

/** Prints what changes in an existing test file before it is overwritten. Previews are scratch files. */
function showDiff(file: string): ((diff: string[]) => void) | undefined {
  if (file.includes(".test.preview.")) return undefined;
  return (diff) => {
    console.log(`\nOverwriting ${relative(file)}. Changes:`);
    for (const line of diff) console.log(`  ${line}`);
  };
}

const STOP_MESSAGES: Record<StopReason, string> = {
  "all-passing": "all tests pass",
  "max-attempts": "reached the repair limit",
  regressed: "a repair broke passing tests and was reverted",
  "no-valid-repairs": "the model proposed no usable repairs",
  unrepairable: "the remaining failures cannot be fixed by editing tests",
  budget: "another repair round could exceed the spending limit",
};

function printRepair(repair: RepairResult, model: string): void {
  for (const attempt of repair.attempts) {
    const counts = (["fix", "skip", "remove"] as const)
      .map((action) => [action, attempt.changes.filter((c) => c.action === action).length] as const)
      .filter(([, n]) => n > 0)
      .map(([action, n]) => `${n} ${action === "fix" ? "fixed" : action === "skip" ? "flagged as source bugs" : "removed"}`);
    const after = attempt.after ? ` → ${attempt.after.passed} passed, ${attempt.after.failed} failed` : "";
    console.log(`${attempt.regressed ? "!" : "✓"} Repair attempt ${attempt.attempt}: ${counts.join(", ") || "no changes"}${after}`);
    for (const change of attempt.changes) console.log(`  - ${change.action} ${change.functionName} › "${change.name}": ${change.reason}`);
    for (const invalid of attempt.invalid) console.log(`  ! ignored repair for ${invalid.functionName} › "${invalid.name}": ${invalid.reason}`);
    if (attempt.regressed) console.log("  ! This attempt broke passing tests; it was reverted.");
  }
  for (const change of repair.gaveUp) console.log(`  - skipped ${change.functionName} › "${change.name}": ${change.reason}`);

  const { final } = repair;
  const total = final.passed + final.failed + final.skipped;
  const skipped = final.skipped ? `, ${final.skipped} skipped` : "";
  console.log(`✓ Final result: ${final.passed}/${total} passing${skipped} (${STOP_MESSAGES[repair.stopReason]})`);
  if (final.coverage) console.log(`✓ Coverage: ${formatCoverage(final.coverage)}`);
  console.log(`  Repair tokens: ${tokens(repair.usage, model)}`);
  if (!repair.sourceUnchanged) console.error("✗ A test run modified the source file. Assertloom restored the original contents.");
}

function buildReport(file: string, generation: GenerationResult, run: RunResult, repair: RepairResult | undefined, budget: Budget) {
  return {
    file,
    model: generation.model,
    mocks: { mocked: generation.mocks.mocked, real: generation.mocks.real, globals: generation.mocks.globals },
    generated: generation.suites.reduce((n, s) => n + s.cases.length, 0),
    rejected: generation.rejected,
    initial: repair?.initial ?? summarize(run),
    attempts: repair?.attempts ?? [],
    gaveUp: repair?.gaveUp ?? [],
    final: summarize(run),
    stopReason: repair?.stopReason ?? (run.status === "passed" ? "all-passing" : "not-repaired"),
    sourceUnchanged: repair?.sourceUnchanged ?? true,
    usage: {
      generation: generation.usage,
      repair: repair?.usage ?? { inputTokens: 0, outputTokens: 0 },
    },
    costUsd: budget.spentUsd ?? null,
  };
}

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate Jest tests for a source file, run them, and keep them if they pass")
    .argument("<file>", "path to a JavaScript or TypeScript source file")
    .addOption(new Option("--provider <name>", "LLM provider").choices(PROVIDERS).default("openai"))
    .option("--model <model>", "model name (default: $ASSERTLOOM_MODEL or the provider default)")
    .option("--out <path>", "where to write the tests (default: <file>.test.preview.<ext>, promoted to <file>.test.<ext> when all pass)")
    .option("--dry-run", "print the generated tests instead of writing or running them")
    .option("--no-run", "write the preview file without running it")
    .option("--no-repair", "do not try to repair failing tests")
    .option("--max-attempts <n>", `repair rounds, 0-${MAX_REPAIR_ATTEMPTS}`, String(MAX_REPAIR_ATTEMPTS))
    .option("--report <file>", "write before/after results of every run and repair round as JSON")
    .option("--mock <module>", "mock this import even if Assertloom would keep it real (repeatable)", collect, [])
    .option("--keep-real <module>", "do not mock this import (repeatable)", collect, [])
    .option("--allow-network", "let generated tests open network connections (blocked by default)")
    .option("--max-cost <usd>", "stop before model calls could push spending past this many US dollars", String(DEFAULT_MAX_COST_USD))
    .option("--force", "overwrite an existing test file that Assertloom did not generate")
    .action(async (file: string, options: GenerateOptions) => {
      const maxAttempts = Number(options.maxAttempts);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > MAX_REPAIR_ATTEMPTS) {
        throw new UserError(`--max-attempts must be a whole number from 0 to ${MAX_REPAIR_ATTEMPTS}.`);
      }
      const maxCost = Number(options.maxCost);
      if (!Number.isFinite(maxCost) || maxCost <= 0) throw new UserError("--max-cost must be a positive number of US dollars.");
      const source = await validateSourceFile(file);
      const provider = createProvider(options.provider, options.model);
      const budget = new Budget(provider.model, maxCost);
      const testPath = options.out ? path.resolve(options.out) : undefined;
      const allowNetwork = !!options.allowNetwork;

      console.log(`Generating tests for ${source.inputPath} with ${provider.name} (${provider.model})...`);
      const result = await generateTests({ source, provider, testPath, mock: options.mock, keepReal: options.keepReal, budget });

      const exported = result.analysis.functions.filter((f) => f.exported).length;
      const caseCount = result.suites.reduce((n, s) => n + s.cases.length, 0);
      const byCategory = (category: string) =>
        result.suites.reduce((n, s) => n + s.cases.filter((c) => c.category === category).length, 0);

      console.log(`✓ Analyzed ${exported} exported functions (${result.suites.length} tested)`);
      printMocks(result);
      if (result.redactions) console.log(`✓ Redacted ${result.redactions} likely secrets before sending`);
      console.log(
        `✓ Generated ${caseCount} test cases (${byCategory("normal")} normal, ${byCategory("edge")} edge, ${byCategory("error")} error)`,
      );
      for (const r of result.rejected) console.log(`  ! rejected ${r.functionName} › "${r.name}": ${r.reason}`);
      console.log(`  Tokens: ${tokens(result.usage, result.model)} (${result.model})`);

      if (options.dryRun) {
        console.log(`\n${result.content}`);
        return;
      }

      await writeTestFile(result.testPath, result.content, options.force, showDiff(result.testPath));
      if (!options.run) {
        console.log(`\nTests saved to ${relative(result.testPath)} (not run)`);
        return;
      }

      let run = await runJest({ testPath: result.testPath, sourcePath: source.absolutePath, allowNetwork });
      printRunResult(run);
      let content = result.content;
      let repair: RepairResult | undefined;

      if (run.status === "failed" && options.repair) {
        repair = await repairTests({
          provider,
          analysis: result.analysis,
          promptSource: result.promptSource,
          sourcePath: source.absolutePath,
          testPath: result.testPath,
          extension: source.extension,
          preamble: result.preamble,
          mockSummary: result.mocks.summary,
          suites: result.suites,
          initialRun: run,
          maxAttempts,
          allowNetwork,
          budget,
        });
        printRepair(repair, result.model);
        run = repair.run;
        content = repair.content;
      }

      if (options.report) {
        await writeFile(options.report, JSON.stringify(buildReport(source.inputPath, result, run, repair, budget), null, 2));
        console.log(`  Report written to ${relative(path.resolve(options.report))}`);
      }

      if (run.status !== "passed") {
        console.log(`\nTests kept in ${relative(result.testPath)} for review.`);
        process.exitCode = 1;
        return;
      }

      if (testPath) {
        console.log(`\nTests saved to ${relative(result.testPath)}`);
        return;
      }

      const finalPath = testPathFor(source.absolutePath);
      try {
        await writeTestFile(finalPath, content, options.force, showDiff(finalPath));
        await rm(result.testPath);
        console.log(`\nTests saved to ${relative(finalPath)}`);
      } catch (error) {
        if (!(error instanceof TestFileExistsError)) throw error;
        console.log(`\n${relative(finalPath)} already exists and was not generated by Assertloom.`);
        console.log(`Passing tests kept in ${relative(result.testPath)}; rerun with --force to replace the existing file.`);
      }
    });
}
