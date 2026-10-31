import type { Command } from "commander";
import { formatSignature } from "../../analyzer/format.js";
import { analyzeFile } from "../../analyzer/index.js";
import type { FileAnalysis, FunctionInfo } from "../../types/index.js";
import { validateSourceFile } from "../validateFile.js";

interface AnalyzeOptions {
  json?: boolean;
}

function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

function signature(fn: FunctionInfo): string {
  const alias = fn.exportedAs.filter((name) => name !== fn.name);
  const notes = [
    alias.length ? `exported as ${alias.join(", ")}` : "",
    fn.throws ? "throws" : "",
    fn.dependencies.length || fn.globals.length ? `uses ${[...fn.dependencies, ...fn.globals.map((g) => `global ${g}`)].join(", ")}` : "",
  ].filter(Boolean);
  return `${formatSignature(fn)}${notes.length ? `  [${notes.join("; ")}]` : ""}`;
}

function printSummary(analysis: FileAnalysis): void {
  const exported = analysis.functions.filter((f) => f.exported);
  const internal = analysis.functions.length - exported.length;
  const { local, external, builtin } = analysis.dependencies;
  const language = analysis.language === "typescript" ? "TypeScript" : "JavaScript";

  console.log(`✓ Parsed ${analysis.file} (${language}, ${analysis.moduleSystem === "none" ? "no imports/exports" : analysis.moduleSystem.toUpperCase()})`);
  console.log(`✓ Found ${plural(exported.length, "exported function")}${internal ? ` (+${internal} internal)` : ""}`);
  console.log(
    `✓ Found ${plural(local.length + external.length + builtin.length, "dependency", "dependencies")} ` +
      `(${external.length} external, ${local.length} local, ${builtin.length} built-in)`,
  );

  if (exported.length) {
    console.log("");
    for (const fn of exported) console.log(`  ${signature(fn)}`);
  }
  if (external.length) console.log(`\nExternal packages: ${external.join(", ")}`);
}

export function registerAnalyzeCommand(program: Command): void {
  program
    .command("analyze")
    .description("Statically analyze a JS/TS file: exported functions, parameters, imports, and dependencies")
    .argument("<file>", "path to a JavaScript or TypeScript source file")
    .option("--json", "print the full analysis as JSON")
    .action(async (file: string, options: AnalyzeOptions) => {
      const analysis = await analyzeFile(await validateSourceFile(file));

      if (options.json) {
        console.log(JSON.stringify(analysis, null, 2));
      } else {
        printSummary(analysis);
      }
    });
}
