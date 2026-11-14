import path from "node:path";
import type { FileAnalysis, FunctionInfo } from "../types/index.js";

export interface Binding {
  /** Name the test code uses to call the function. For a class method, `Class.method`; for a constructor, the class itself. */
  binding: string;
  /** Exported name in the source module, or `"default"`. For a method, the class's export name. */
  exportName: string;
  fn: FunctionInfo;
  /** Local import name of the owning class, for class methods and constructors. */
  classBinding?: string;
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
  /** Distinct { local import name, export name } pairs for the import statement. */
  const imports: Array<{ local: string; exportName: string }> = [];
  const addImport = (local: string, exportName: string) => {
    if (!imports.some((i) => i.exportName === exportName)) imports.push({ local, exportName });
  };

  const standalone = functions.filter((fn) => !fn.className);
  const methods = functions.filter((fn) => fn.className);

  for (const fn of standalone) {
    const named = fn.exportedAs.find((name) => name !== "default");
    if (named) {
      const binding = localName(named, used);
      bindings.push({ binding, exportName: named, fn });
      addImport(binding, named);
    }
  }

  for (const fn of standalone) {
    if (fn.exportedAs.some((name) => name !== "default") || !fn.exportedAs.includes("default")) continue;
    const base = fn.name !== "default" ? fn.name : camelCase(path.basename(sourcePath).replace(/\.[^.]+$/, ""));
    const binding = localName(used.has(base) ? `${base}Default` : base, used);
    bindings.push({ binding, exportName: "default", fn });
    addImport(binding, "default");
  }

  // One import per class; one binding per method, named `Class.method`
  // (the constructor's binding is the class itself, since tests construct it).
  const classOrder: string[] = [];
  for (const fn of methods) if (fn.className && !classOrder.includes(fn.className)) classOrder.push(fn.className);
  for (const className of classOrder) {
    const members = methods.filter((fn) => fn.className === className);
    const exportedAs = members[0].exportedAs;
    const named = exportedAs.find((name) => name !== "default");
    let classBinding: string;
    let exportName: string;
    if (named) {
      classBinding = localName(named, used);
      exportName = named;
    } else {
      const base = className !== "default" ? className : camelCase(path.basename(sourcePath).replace(/\.[^.]+$/, ""));
      classBinding = localName(used.has(base) ? `${base}Default` : base, used);
      exportName = "default";
    }
    addImport(classBinding, exportName);
    for (const fn of members) {
      bindings.push({
        binding: fn.kind === "constructor" ? classBinding : `${classBinding}.${fn.name}`,
        exportName,
        fn,
        classBinding,
      });
    }
  }

  const specifier = JSON.stringify(importSpecifier(testPath, sourcePath));
  const defaultImport = imports.find((i) => i.exportName === "default")?.local;
  const namedImports = imports.filter((i) => i.exportName !== "default");
  const statements: string[] = [];

  if (analysis.moduleSystem === "commonjs") {
    const properties = namedImports.map((i) => (i.local === i.exportName ? i.local : `${exportKey(i.exportName)}: ${i.local}`));
    if (defaultImport) statements.push(`const ${defaultImport} = require(${specifier});`);
    if (properties.length) statements.push(`const { ${properties.join(", ")} } = require(${specifier});`);
  } else {
    const specifiers = namedImports.map((i) => (i.local === i.exportName ? i.local : `${exportKey(i.exportName)} as ${i.local}`));
    const clauses = [defaultImport, specifiers.length ? `{ ${specifiers.join(", ")} }` : undefined].filter(Boolean);
    if (clauses.length) statements.push(`import ${clauses.join(", ")} from ${specifier};`);
  }

  return { statements, bindings };
}
