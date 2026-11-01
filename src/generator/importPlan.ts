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

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface " +
    "package private protected public await arguments eval undefined NaN Infinity").split(" "),
);

const isIdentifierName = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

function camelCase(text: string): string {
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words.map((w, i) => (i === 0 ? w[0].toLowerCase() : w[0].toUpperCase()) + w.slice(1)).join("");
  return /^[A-Za-z_$]/.test(joined) ? joined : `_${joined}`;
}

/** A local binding name for `name` that is a valid, unused, non-reserved identifier. */
function localName(name: string, used: Set<string>): string {
  let base = isIdentifierName(name) ? name : camelCase(name);
  if (RESERVED.has(base)) base = `_${base}`;
  let binding = base;
  for (let n = 2; used.has(binding); n++) binding = `${base}${n}`;
  used.add(binding);
  return binding;
}

const exportKey = (name: string) => (isIdentifierName(name) ? name : JSON.stringify(name));

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
    if (named) bindings.push({ binding: localName(named, used), exportName: named, fn });
  }

  for (const fn of functions) {
    if (fn.exportedAs.some((name) => name !== "default") || !fn.exportedAs.includes("default")) continue;
    const base = fn.name !== "default" ? fn.name : camelCase(path.basename(sourcePath).replace(/\.[^.]+$/, ""));
    bindings.push({ binding: localName(used.has(base) ? `${base}Default` : base, used), exportName: "default", fn });
  }

  const specifier = JSON.stringify(importSpecifier(testPath, sourcePath));
  const defaultBinding = bindings.find((b) => b.exportName === "default")?.binding;
  const named = bindings.filter((b) => b.exportName !== "default");
  const statements: string[] = [];

  if (analysis.moduleSystem === "commonjs") {
    const properties = named.map((b) => (b.binding === b.exportName ? b.binding : `${exportKey(b.exportName)}: ${b.binding}`));
    if (defaultBinding) statements.push(`const ${defaultBinding} = require(${specifier});`);
    if (properties.length) statements.push(`const { ${properties.join(", ")} } = require(${specifier});`);
  } else {
    const specifiers = named.map((b) => (b.binding === b.exportName ? b.binding : `${exportKey(b.exportName)} as ${b.binding}`));
    const clauses = [defaultBinding, specifiers.length ? `{ ${specifiers.join(", ")} }` : undefined].filter(Boolean);
    if (clauses.length) statements.push(`import ${clauses.join(", ")} from ${specifier};`);
  }

  return { statements, bindings };
}
