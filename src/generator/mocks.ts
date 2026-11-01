import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { classifySource, scanImports } from "../analyzer/dependencies.js";
import { parseSource } from "../analyzer/parser.js";
import { collectImportUsage, emptyShape } from "../analyzer/usage.js";
import { SUPPORTED_EXTENSIONS, type FileAnalysis, type ImportCategory, type ImportUsage, type SupportedExtension, type UsageShape } from "../types/index.js";

/** Built-ins that are deterministic and side-effect free, so they stay real. */
export const PURE_BUILTINS = new Set(["assert", "buffer", "path", "path/posix", "path/win32", "querystring", "string_decoder", "url", "util"]);

/** Utility packages without I/O. Mocking them would break the code under test, so they stay real. */
export const PURE_PACKAGES = new Set([
  "@babel/runtime", "big.js", "bignumber.js", "change-case", "classnames", "clsx", "date-fns", "dayjs", "decimal.js",
  "deepmerge", "fast-deep-equal", "immer", "joi", "lodash", "lodash-es", "ms", "qs", "ramda", "semver", "tslib",
  "validator", "yup", "zod",
]);

const MAX_LOCAL_DEPTH = 5;
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

export interface MockedModule {
  /** Specifier as written in the source. */
  source: string;
  /** Specifier used in the test file. */
  specifier: string;
  category: ImportCategory;
  /** The module is not installed or not found, so Jest must not try to resolve it. */
  virtual: boolean;
  reason: string;
}

export interface RealModule {
  source: string;
  reason: string;
}

export interface MockPlan {
  mocked: MockedModule[];
  real: RealModule[];
  globals: string[];
  /** jest.mock() calls and imports of the mocked modules; they go before the source import. */
  imports: string[];
  /** Shared mock objects, global mocks, and reset hooks; they go after all imports. */
  setup: string[];
  /** Description of the mocks for the model. */
  summary: string;
}

export interface MockOptions {
  analysis: FileAnalysis;
  sourcePath: string;
  testPath: string;
  extension: SupportedExtension;
  /** Names already used in the test file (the source function bindings). */
  reserved: Iterable<string>;
  /** Modules to mock even if Assertloom would keep them real. Matched by specifier or package name. */
  mock?: string[];
  /** Modules to keep real even if Assertloom would mock them. */
  keepReal?: string[];
}

interface Decision {
  mock: boolean;
  virtual: boolean;
  reason: string;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function resolveLocal(fromFile: string, specifier: string): Promise<string | undefined> {
  if (specifier.startsWith("#")) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base];
  const jsExtension = /\.[cm]?jsx?$/.exec(base);
  if (jsExtension) candidates.push(...TYPESCRIPT_EXTENSIONS.map((ext) => base.slice(0, -jsExtension[0].length) + ext));
  candidates.push(...SUPPORTED_EXTENSIONS.map((ext) => base + ext), ...SUPPORTED_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)));
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

function isInstalled(fromFile: string, specifier: string): boolean {
  try {
    createRequire(fromFile).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** Why a local file has side effects (its first impure dependency), or undefined if it has none. */
async function localImpurity(file: string, visited: Set<string>, depth: number): Promise<string | undefined> {
  if (visited.has(file)) return undefined;
  visited.add(file);
  const extension = path.extname(file);
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) return undefined;
  if (depth > MAX_LOCAL_DEPTH) return "deeply nested local modules";

  let ast;
  try {
    ast = parseSource(await readFile(file, "utf8"), extension as SupportedExtension);
  } catch {
    return `${path.basename(file)}, which could not be parsed`;
  }

  const { globals } = collectImportUsage(ast);
  if (globals.length) return `global ${globals[0]}`;

  for (const entry of scanImports(ast).imports) {
    if (entry.typeOnly) continue;
    const decision = await decide(entry.source, entry.category, entry.packageName, file, visited, depth + 1);
    if (decision.mock) return entry.category === "local" ? `${entry.source} (${decision.reason})` : entry.source;
  }
  return undefined;
}

async function decide(
  source: string,
  category: ImportCategory,
  packageName: string | undefined,
  fromFile: string,
  visited: Set<string>,
  depth: number,
): Promise<Decision> {
  if (category === "builtin") {
    return PURE_BUILTINS.has(source.replace(/^node:/, ""))
      ? { mock: false, virtual: false, reason: "pure Node built-in" }
      : { mock: true, virtual: false, reason: "Node built-in with side effects" };
  }

  if (category === "external") {
    if (packageName && PURE_PACKAGES.has(packageName)) return { mock: false, virtual: false, reason: "utility library without I/O" };
    const installed = isInstalled(fromFile, source);
    return { mock: true, virtual: !installed, reason: installed ? "external package" : "external package, not installed" };
  }

  const file = await resolveLocal(fromFile, source);
  if (!file) return { mock: true, virtual: true, reason: "local module not found" };
  const impurity = await localImpurity(file, visited, depth);
  return impurity
    ? { mock: true, virtual: false, reason: `depends on ${impurity}` }
    : { mock: false, virtual: false, reason: "local module without side effects" };
}

function matches(list: string[] | undefined, source: string, packageName: string | undefined): boolean {
  return !!list?.some((entry) => entry === source || entry === packageName || entry.replace(/^node:/, "") === source.replace(/^node:/, ""));
}

function specifierFromTest(source: string, sourcePath: string, testPath: string): string {
  if (!source.startsWith(".")) return source;
  const relative = path.relative(path.dirname(testPath), path.resolve(path.dirname(sourcePath), source)).replaceAll("\\", "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function mergeShapes(a: UsageShape | undefined, b: UsageShape): UsageShape {
  const merged: UsageShape = a
    ? { ...a, members: { ...a.members }, resultNames: [...a.resultNames] }
    : { ...emptyShape(), members: {}, resultNames: [] };
  merged.called ||= b.called;
  merged.constructed ||= b.constructed;
  merged.instanceOf ||= b.instanceOf;
  merged.createdAtLoad ||= b.createdAtLoad;
  for (const name of b.resultNames) if (!merged.resultNames.includes(name)) merged.resultNames.push(name);
  for (const [key, value] of Object.entries(b.members)) merged.members[key] = mergeShapes(merged.members[key], value);
  if (b.result) merged.result = mergeShapes(merged.result, b.result);
  return merged;
}

/**
 * Constructors, and calls made while the module loads (`const client = createClient()`), return one
 * shared mock object, because tests cannot configure them before they run. Other calls are plain
 * jest.fn() mocks whose return values tests set themselves.
 */
function sharesInstance(shape: UsageShape): boolean {
  return !!shape.result && (shape.constructed || shape.createdAtLoad);
}

const isCallable = (shape: UsageShape) => shape.called || shape.constructed || shape.instanceOf;

function propertyKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

class FactoryWriter {
  readonly locals: string[] = [];
  private count = 0;

  members(shape: UsageShape): string[] {
    return Object.entries(shape.members).map(([key, value]) => `${propertyKey(key)}: ${this.value(value)}`);
  }

  /** A member that is only read (never called) is still a jest.fn(), the safest stand-in for an unknown value. */
  value(shape: UsageShape): string {
    const members = this.members(shape);
    const withMembers = (base: string) => (members.length ? `Object.assign(${base}, { ${members.join(", ")} })` : base);

    if (sharesInstance(shape)) {
      const name = `instance${++this.count}`;
      this.locals.push(`const ${name} = ${this.object(shape.result!)};`);
      return withMembers(`function () { return ${name}; }`);
    }
    if (shape.instanceOf && !shape.called && !shape.constructed) return withMembers("class {}");
    if (shape.called || shape.constructed || members.length === 0) return withMembers("jest.fn()");
    return `{ ${members.join(", ")} }`;
  }

  object(shape: UsageShape): string {
    const members = this.members(shape);
    return members.length ? `{ ${members.join(", ")} }` : "{}";
  }
}

interface ModuleModel {
  defaultShape?: UsageShape;
  moduleShape: UsageShape;
  hasEsm: boolean;
  /** The module value itself is a function (`const got = require("got"); got()`). */
  callableRoot: boolean;
}

function modelModule(usages: ImportUsage[]): ModuleModel {
  let defaultShape: UsageShape | undefined;
  let moduleShape = emptyShape();
  for (const usage of usages) {
    if (usage.imported === "default" && usage.style === "esm") defaultShape = mergeShapes(defaultShape, usage.shape);
    else if (usage.imported === "*") moduleShape = mergeShapes(moduleShape, usage.shape);
    else moduleShape.members[usage.imported] = mergeShapes(moduleShape.members[usage.imported], usage.shape);
  }
  return { defaultShape, moduleShape, hasEsm: usages.some((u) => u.style === "esm"), callableRoot: !defaultShape && isCallable(moduleShape) };
}

function factoryFor(model: ModuleModel): string {
  const writer = new FactoryWriter();
  let value: string;
  if (model.callableRoot) {
    value = writer.value(model.moduleShape);
  } else {
    const members = [
      ...(model.hasEsm ? ["__esModule: true"] : []),
      ...(model.defaultShape ? [`default: ${writer.value(model.defaultShape)}`] : []),
      ...writer.members(model.moduleShape),
    ];
    value = members.length ? `{ ${members.join(", ")} }` : "{}";
  }
  if (writer.locals.length === 0) return `() => (${value})`;
  return `() => {\n  ${writer.locals.join("\n  ")}\n  return ${value};\n}`;
}

function shapeFor(model: ModuleModel, usage: ImportUsage): UsageShape | undefined {
  if (usage.imported === "default" && usage.style === "esm") return model.defaultShape;
  if (usage.imported === "*") return model.moduleShape;
  return model.moduleShape.members[usage.imported];
}

class NameAllocator {
  private readonly used: Set<string>;
  constructor(reserved: Iterable<string>) {
    this.used = new Set(reserved);
  }
  has(name: string): boolean {
    return this.used.has(name);
  }
  claim(preferred: string): string {
    let name = preferred;
    for (let n = 2; this.used.has(name); n++) name = `${preferred}Mock${n === 2 ? "" : n}`;
    this.used.add(name);
    return name;
  }
}

interface Description {
  handles: Array<{ name: string; init: string }>;
  lines: string[];
  fns: string[];
}

function describeShape(shape: UsageShape, expr: string, names: NameAllocator, out: Description, isRoot: boolean): void {
  if (sharesInstance(shape)) {
    const lastSegment = expr.split(/[.()\s]/).filter(Boolean).pop() ?? "mock";
    const name = names.claim(shape.resultNames.find((n) => !names.has(n)) ?? `${lastSegment[0].toLowerCase()}${lastSegment.slice(1)}Instance`);
    const init = shape.constructed ? `new ${expr}()` : `${expr}()`;
    out.handles.push({ name, init });
    out.lines.push(`\`${init}\` returns one shared mock object, available in tests as \`${name}\``);
    describeShape(shape.result!, name, names, out, false);
  } else if (shape.called || shape.constructed || (!isRoot && Object.keys(shape.members).length === 0)) {
    out.fns.push(expr);
  }
  for (const [key, member] of Object.entries(shape.members)) {
    const access = /^[A-Za-z_$][\w$]*$/.test(key) ? `${expr}.${key}` : `${expr}[${JSON.stringify(key)}]`;
    describeShape(member, access, names, out, false);
  }
}

function importStatement(usage: ImportUsage, specifier: string, model: ModuleModel, commonjs: boolean): string {
  const spec = JSON.stringify(specifier);
  const local = usage.local;
  if (commonjs) {
    if (usage.imported === "default" && usage.style === "esm") return `const ${local} = require(${spec}).default;`;
    if (usage.imported === "*") return `const ${local} = require(${spec});`;
    return `const { ${usage.imported === local ? local : `${propertyKey(usage.imported)}: ${local}`} } = require(${spec});`;
  }
  if (usage.imported === "default" && usage.style === "esm") return `import ${local} from ${spec};`;
  if (usage.imported === "*") return model.callableRoot ? `import ${local} from ${spec};` : `import * as ${local} from ${spec};`;
  return `import { ${usage.imported === local ? local : `${JSON.stringify(usage.imported)} as ${local}`} } from ${spec};`;
}

/**
 * Decides which imports to mock and writes the mocks. Assertloom writes every jest.mock() factory
 * itself from how the source uses each import; the model only configures return values in tests.
 */
export async function planMocks(options: MockOptions): Promise<MockPlan> {
  const { analysis, sourcePath, testPath } = options;
  const commonjs = analysis.moduleSystem === "commonjs";
  const typescript = analysis.language === "typescript";
  const names = new NameAllocator(options.reserved);

  const mocked: MockedModule[] = [];
  const real: RealModule[] = [];
  const seen = new Set<string>();
  for (const entry of analysis.imports) {
    if (entry.typeOnly || (entry.kind !== "import" && entry.kind !== "require") || seen.has(entry.source)) continue;
    seen.add(entry.source);

    let decision: Decision;
    if (matches(options.keepReal, entry.source, entry.packageName)) {
      decision = { mock: false, virtual: false, reason: "kept real with --keep-real" };
    } else {
      decision = await decide(entry.source, entry.category, entry.packageName, sourcePath, new Set([sourcePath]), 1);
      if (!decision.mock && matches(options.mock, entry.source, entry.packageName)) {
        const missing = entry.category === "external" ? !isInstalled(sourcePath, entry.source) : entry.category === "local" && !(await resolveLocal(sourcePath, entry.source));
        decision = { mock: true, virtual: missing, reason: "mocked with --mock" };
      }
    }

    if (decision.mock) {
      mocked.push({
        source: entry.source,
        specifier: specifierFromTest(entry.source, sourcePath, testPath),
        category: classifySource(entry.source).category,
        virtual: decision.virtual,
        reason: decision.reason,
      });
    } else {
      real.push({ source: entry.source, reason: decision.reason });
    }
  }

  const mockCalls: string[] = [];
  const imports: string[] = [];
  const handles: string[] = [];
  const summary: string[] = [];

  for (const module of mocked) {
    const usages = analysis.importUsage.filter((u) => u.source === module.source);
    const model = modelModule(usages);
    const virtual = module.virtual ? ", { virtual: true }" : "";
    mockCalls.push(`jest.mock(${JSON.stringify(module.specifier)}, ${factoryFor(model)}${virtual});`);

    const visible = usages.filter((u) => u.local && !names.has(u.local));
    const locals = [...new Map(visible.map((u) => [u.local, u])).values()];
    for (const usage of locals) {
      names.claim(usage.local);
      imports.push(importStatement(usage, module.specifier, model, commonjs));
    }

    const description: Description = { handles: [], lines: [], fns: [] };
    for (const usage of locals) {
      const shape = shapeFor(model, usage);
      if (shape) describeShape(shape, usage.local, names, description, usage.imported === "*" || usage.imported === "default");
    }
    handles.push(...description.handles.map((h) => `const ${h.name} = ${h.init};`));

    const detail = module.virtual ? `${module.reason}; virtual mock` : module.reason;
    summary.push(`- ${JSON.stringify(module.source)} (${detail}). Imported in the test file as: ${locals.map((u) => `\`${u.local}\``).join(", ") || "(nothing)"}`);
    for (const line of description.lines) summary.push(`  - ${line}`);
    if (description.fns.length) summary.push(`  - jest.fn() mocks: ${[...new Set(description.fns)].map((f) => `\`${f}\``).join(", ")}`);
  }

  // Pure built-ins such as `path` are also imported into the test, so expected values can be built portably.
  const helpers: string[] = [];
  for (const module of real) {
    if (classifySource(module.source).category !== "builtin") continue;
    const usages = analysis.importUsage.filter((u) => u.source === module.source && u.local && !names.has(u.local));
    const model = modelModule(usages);
    for (const usage of [...new Map(usages.map((u) => [u.local, u])).values()]) {
      names.claim(usage.local);
      imports.push(importStatement(usage, module.source, model, commonjs));
      helpers.push(`\`${usage.local}\` (${module.source})`);
    }
  }
  if (helpers.length) summary.push(`- Not mocked, and also imported in the test file for building expected values: ${helpers.join(", ")}`);
  const otherReal = real.filter((r) => classifySource(r.source).category !== "builtin");
  if (otherReal.length) summary.push(`- Not mocked (real code runs): ${otherReal.map((r) => JSON.stringify(r.source)).join(", ")}`);

  const globals = analysis.globals;
  const globalLines: string[] = [];
  for (const name of globals) {
    const original = names.claim(`original${name[0].toUpperCase()}${name.slice(1)}`);
    globalLines.push(
      `const ${original} = globalThis.${name};`,
      `globalThis.${name} = jest.fn()${typescript ? ` as unknown as typeof ${name}` : ""};`,
      `afterAll(() => {\n  globalThis.${name} = ${original};\n});`,
    );
    summary.push(`- global \`${name}\` is a jest.fn() mock for every test.`);
  }

  const setup = [handles.join("\n"), globalLines.join("\n")].filter(Boolean);
  if (mocked.length > 0 || globals.length > 0) {
    setup.push("beforeEach(() => {\n  jest.resetAllMocks();\n});", "afterEach(() => {\n  jest.restoreAllMocks();\n});");
  }

  return {
    mocked,
    real,
    globals,
    imports: [...mockCalls, ...(mockCalls.length ? [""] : []), ...imports],
    setup,
    summary: summary.join("\n"),
  };
}
