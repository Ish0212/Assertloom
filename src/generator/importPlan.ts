import path from "node:path";
import type { FileAnalysis, FunctionInfo } from "../types/index.js";

export interface Binding {
  /** Name the test code uses to call the function. */
  binding: string;
  /** Exported name in the source module, or `"default"`. */
  exportName: string;
  fn: FunctionInfo;
}

export interface ImportPlan {
  statements: string[];
  bindings: Binding[];
}

function camelCase(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((w, i) => (i === 0 ? w[0].toLowerCase() : w[0].toUpperCase()) + w.slice(1)).join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

/** Module specifier for importing `sourcePath` from a test file at `testPath`. */
export function importSpecifier(testPath: string, sourcePath: string): string {
  let relative = path.relative(path.dirname(testPath), sourcePath).replaceAll("\\", "/");
  relative = relative.replace(/\.(ts|tsx|js|jsx)$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function planImports(
  analysis: FileAnalysis,
  functions: FunctionInfo[],
  sourcePath: string,
  testPath: string,
): ImportPlan {
  const bindings: Binding[] = [];
  const used = new Set<string>();

  for (const fn of functions) {
    const named = fn.exportedAs.find((name) => name !== "default");
    if (named) {
      bindings.push({ binding: named, exportName: named, fn });
      used.add(named);
    }
  }

  for (const fn of functions) {
    if (fn.exportedAs.some((name) => name !== "default") || !fn.exportedAs.includes("default")) continue;
    let binding = fn.name !== "default" ? fn.name : camelCase(path.basename(sourcePath).replace(/\.[^.]+$/, ""));
    if (used.has(binding)) binding = `${binding}Default`;
    bindings.push({ binding, exportName: "default", fn });
    used.add(binding);
  }

  const specifier = JSON.stringify(importSpecifier(testPath, sourcePath));
  const defaultBinding = bindings.find((b) => b.exportName === "default")?.binding;
  const namedBindings = bindings.filter((b) => b.exportName !== "default").map((b) => b.binding);
  const statements: string[] = [];

  if (analysis.moduleSystem === "commonjs") {
    if (defaultBinding) statements.push(`const ${defaultBinding} = require(${specifier});`);
    if (namedBindings.length) statements.push(`const { ${namedBindings.join(", ")} } = require(${specifier});`);
  } else {
    const clauses = [defaultBinding, namedBindings.length ? `{ ${namedBindings.join(", ")} }` : undefined].filter(Boolean);
    if (clauses.length) statements.push(`import ${clauses.join(", ")} from ${specifier};`);
  }

  return { statements, bindings };
}
