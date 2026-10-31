import { readFile } from "node:fs/promises";
import type { FileAnalysis, SourceFile } from "../types/index.js";
import { scanImports, summarizeDependencies } from "./dependencies.js";
import { extractFunctions } from "./functions.js";
import { parseSource } from "./parser.js";
import { collectImportUsage } from "./usage.js";

export { ParseError, parseSource } from "./parser.js";

/** Statically analyzes source code. Target code is parsed, never executed. */
export function analyzeSource(code: string, source: Pick<SourceFile, "inputPath" | "extension" | "language">): FileAnalysis {
  const ast = parseSource(code, source.extension);
  const scan = scanImports(ast);

  const usesEsm =
    scan.imports.some((i) => i.kind === "import" || i.kind === "re-export") ||
    ast.program.body.some((s) => s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration");
  const usesCommonJs = scan.usesCommonJsExports || scan.imports.some((i) => i.kind === "require");
  const { importUsage, globals } = collectImportUsage(ast);

  return {
    file: source.inputPath.replaceAll("\\", "/"),
    language: source.language,
    moduleSystem: usesEsm && usesCommonJs ? "mixed" : usesEsm ? "esm" : usesCommonJs ? "commonjs" : "none",
    functions: extractFunctions(ast, code, scan),
    imports: scan.imports,
    importUsage,
    globals,
    dependencies: summarizeDependencies(scan.imports),
  };
}

export async function analyzeFile(source: SourceFile): Promise<FileAnalysis> {
  return analyzeSource(await readFile(source.absolutePath, "utf8"), source);
}
