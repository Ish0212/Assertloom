import type { Command } from "commander";
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
  const params = fn.parameters
    .map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional && !p.rest && !p.defaultValue ? "?" : ""}${p.type ? `: ${p.type}` : ""}${p.defaultValue ? ` = ${p.defaultValue}` : ""}`)
    .join(", ");
  const prefix = `${fn.async ? "async " : ""}${fn.generator ? "*" : ""}`;
  const alias = fn.exportedAs.filter((name) => name !== fn.name);
  const notes = [
    alias.length ? `exported as ${alias.join(", ")}` : "",
    fn.throws ? "throws" : "",
    fn.dependencies.length ? `uses ${fn.dependencies.join(", ")}` : "",
  ].filter(Boolean);
  return `${prefix}${fn.name}${fn.typeParameters ?? ""}(${params})${fn.returnType ? `: ${fn.returnType}` : ""}${notes.length ? `  [${notes.join("; ")}]` : ""}`;
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
