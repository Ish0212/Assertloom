import path from "node:path";
import { Option, type Command } from "commander";
import { createProvider, PROVIDERS } from "../../ai/index.js";
import { generateTests, writeTestFile } from "../../generator/index.js";
import { validateSourceFile } from "../validateFile.js";

interface GenerateOptions {
  provider: string;
  model?: string;
  out?: string;
  dryRun?: boolean;
  force?: boolean;
}

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description("Generate Jest tests for the exported functions in a source file (written to a preview file)")
    .argument("<file>", "path to a JavaScript or TypeScript source file")
    .addOption(new Option("--provider <name>", "LLM provider").choices(PROVIDERS).default("openai"))
    .option("--model <model>", "model name (default: $ASSERTLOOM_MODEL or the provider default)")
    .option("--out <path>", "where to write the tests (default: <file>.test.preview.<ext> next to the source)")
    .option("--dry-run", "print the generated tests instead of writing them")
    .option("--force", "overwrite an existing file that Assertloom did not generate")
    .action(async (file: string, options: GenerateOptions) => {
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
      console.log("✓ Syntax check passed");
      console.log(`  Tokens: ${result.usage.inputTokens.toLocaleString()} in / ${result.usage.outputTokens.toLocaleString()} out (${result.model})`);

      if (options.dryRun) {
        console.log(`\n${result.content}`);
        return;
      }

      const { overwritten } = await writeTestFile(result.testPath, result.content, options.force);
      const shownPath = path.relative(process.cwd(), result.testPath) || result.testPath;
      console.log(`\nTests ${overwritten ? "updated" : "saved"} to ${shownPath} (not run yet)`);
    });
}
