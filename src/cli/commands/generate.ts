import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Option, type Command } from "commander";
import { createProvider, PROVIDERS } from "../../ai/index.js";
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
}

function relative(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

const STOP_MESSAGES: Record<StopReason, string> = {
  "all-passing": "all tests pass",
  "max-attempts": "reached the repair limit",
  regressed: "a repair broke passing tests and was reverted",
  "no-valid-repairs": "the model proposed no usable repairs",
  unrepairable: "the remaining failures cannot be fixed by editing tests",
};

function printRepair(repair: RepairResult): void {
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
  console.log(`  Repair tokens: ${repair.usage.inputTokens.toLocaleString()} in / ${repair.usage.outputTokens.toLocaleString()} out`);
  if (!repair.sourceUnchanged) console.error("✗ A test run modified the source file. Assertloom restored the original contents.");
}

function buildReport(file: string, generation: GenerationResult, run: RunResult, repair?: RepairResult) {
  return {
    file,
    model: generation.model,
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
    .option("--force", "overwrite an existing test file that Assertloom did not generate")
    .action(async (file: string, options: GenerateOptions) => {
      const maxAttempts = Number(options.maxAttempts);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > MAX_REPAIR_ATTEMPTS) {
        throw new UserError(`--max-attempts must be a whole number from 0 to ${MAX_REPAIR_ATTEMPTS}.`);
      }
      const source = await validateSourceFile(file);
      const provider = createProvider(options.provider, options.model);
      const testPath = options.out ? path.resolve(options.out) : undefined;

      console.log(`Generating tests for ${source.inputPath} with ${provider.name} (${provider.model})...`);
      const result = await generateTests({ source, provider, testPath });

      const exported = result.analysis.functions.filter((f) => f.exported).length;
      const caseCount = result.suites.reduce((n, s) => n + s.cases.length, 0);
      const byCategory = (category: string) =>
        result.suites.reduce((n, s) => n + s.cases.filter((c) => c.category === category).length, 0);

      console.log(`✓ Analyzed ${exported} exported functions (${result.suites.length} tested)`);
      for (const { fn, reason } of result.skipped) console.log(`  - skipped ${fn.name}: ${reason}`);
      if (result.redactions) console.log(`✓ Redacted ${result.redactions} likely secrets before sending`);
      console.log(
        `✓ Generated ${caseCount} test cases (${byCategory("normal")} normal, ${byCategory("edge")} edge, ${byCategory("error")} error)`,
      );
      for (const r of result.rejected) console.log(`  ! rejected ${r.functionName} › "${r.name}": ${r.reason}`);
      console.log(`  Tokens: ${result.usage.inputTokens.toLocaleString()} in / ${result.usage.outputTokens.toLocaleString()} out (${result.model})`);

      if (options.dryRun) {
        console.log(`\n${result.content}`);
        return;
      }

      await writeTestFile(result.testPath, result.content, options.force);
      if (!options.run) {
        console.log(`\nTests saved to ${relative(result.testPath)} (not run)`);
        return;
      }

      let run = await runJest({ testPath: result.testPath, sourcePath: source.absolutePath });
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
          importStatements: result.importStatements,
          suites: result.suites,
          initialRun: run,
          maxAttempts,
        });
        printRepair(repair);
        run = repair.run;
        content = repair.content;
      }

      if (options.report) {
        await writeFile(options.report, JSON.stringify(buildReport(source.inputPath, result, run, repair), null, 2));
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
        await writeTestFile(finalPath, content, options.force);
        await rm(result.testPath);
        console.log(`\nTests saved to ${relative(finalPath)}`);
      } catch (error) {
        if (!(error instanceof TestFileExistsError)) throw error;
        console.log(`\n${relative(finalPath)} already exists and was not generated by Assertloom.`);
        console.log(`Passing tests kept in ${relative(result.testPath)}; rerun with --force to replace the existing file.`);
      }
    });
}
