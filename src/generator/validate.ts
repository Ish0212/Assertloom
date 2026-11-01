import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import type { Node } from "@babel/types";
import { pluginsFor } from "../analyzer/parser.js";
import type { SupportedExtension } from "../types/index.js";
import type { Binding } from "./importPlan.js";
import type { GeneratedTestCase, Generation } from "./schema.js";

export const MAX_CASES_PER_FUNCTION = 12;
const MAX_BODY_LENGTH = 4000;
const MAX_NAME_LENGTH = 200;

/** Module-level mocking is Assertloom's job; these would also load real modules or bypass the mocks. */
/** Read-only process calls; anything else (exit, kill, chdir, ...) could affect the test run itself. */
const SAFE_PROCESS_METHODS = new Set(["cwd", "hrtime", "memoryUsage", "uptime", "nextTick", "emitWarning"]);

const FORBIDDEN_JEST_METHODS = new Set([
  "mock", "doMock", "unmock", "dontMock", "requireActual", "requireMock", "createMockFromModule",
  "enableAutomock", "disableAutomock", "resetModules", "isolateModules", "isolateModulesAsync",
]);

export interface AcceptedCase extends GeneratedTestCase {
  async: boolean;
  /** Set when the repair loop gives up on a case; rendered as `it.skip` with this reason. */
  skipReason?: string;
}

export interface ValidatedSuite {
  binding: Binding;
  cases: AcceptedCase[];
}

export interface RejectedCase {
  functionName: string;
  name: string;
  reason: string;
}

export interface ValidationResult {
  suites: ValidatedSuite[];
  rejected: RejectedCase[];
}

/** Read-only process properties tests may inspect. */
const SAFE_PROCESS_PROPERTIES = new Set(["env", "platform", "arch", "version", "versions", "argv", "pid", "execPath", "release", "features"]);

const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

function rootIdentifier(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return rootIdentifier(node.object);
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") return rootIdentifier(node.callee);
  return undefined;
}

const isMember = (node: Node | null | undefined): node is Node & { object: Node; property: Node; computed: boolean } =>
  node?.type === "MemberExpression" || node?.type === "OptionalMemberExpression";

/** The property name of `a.b` or `a["b"]`, or undefined when it is computed at runtime. */
function memberName(node: { property: Node; computed: boolean }): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "StringLiteral") return node.property.value;
  return undefined;
}

const propertyIs = (node: { property: Node; computed: boolean }, name: string) => memberName(node) === name;

/** Returns why a test body is unacceptable, or whether it needs an async callback. */
export function checkBody(
  body: string,
  extension: SupportedExtension,
  /** Names the target functions are imported as; they are real code, never mocks. */
  targets: ReadonlySet<string> = new Set(),
): { error: string } | { async: boolean } {
  if (body.length > MAX_BODY_LENGTH) return { error: `body is longer than ${MAX_BODY_LENGTH} characters` };

  let ast;
  try {
    ast = parse(`async function __assertloomCase() {\n${body}\n}`, {
      sourceType: "module",
      plugins: pluginsFor(extension),
    });
  } catch (error) {
    return { error: `syntax error: ${(error as Error).message.replace(/\s*\(\d+:\d+\)$/, "")}` };
  }

  const [wrapper, ...extra] = ast.program.body;
  if (extra.length || wrapper?.type !== "FunctionDeclaration") return { error: "has unbalanced braces" };

  let hasExpect = false;
  let usesAwait = false;
  let problem: string | undefined;

  traverse(ast, {
    "CallExpression|OptionalCallExpression"(path) {
      const node = path.node as Node & { callee: Node; arguments: Node[] };
      const callee = node.callee;
      if (rootIdentifier(callee) === "expect") hasExpect = true;
      const method = isMember(callee) ? memberName(callee) : undefined;
      if (isMember(callee) && method?.startsWith("mock")) {
        let stubbed = callee.object;
        if ((stubbed.type === "CallExpression" || stubbed.type === "OptionalCallExpression") && rootIdentifier(stubbed.callee) === "jest") {
          stubbed = stubbed.arguments[0] as typeof stubbed;
        }
        if (stubbed?.type === "Identifier" && targets.has(stubbed.name)) {
          problem ??= `calls ${method}() on \`${stubbed.name}\`, a real function under test (only dependencies are mocked)`;
        }
      }
      if (rootIdentifier(callee) === "jest" && isMember(callee) && propertyIs(callee, "spyOn")) {
        const [, spied] = node.arguments;
        if (spied?.type === "StringLiteral" && targets.has(spied.value)) {
          problem ??= `spies on \`${spied.value}\`, a function under test; calls inside the source file bypass spies`;
        }
      }
    },
    ImportExpression() {
      problem ??= "uses import()";
    },
    AwaitExpression(path) {
      if (path.getFunctionParent()?.parentPath?.isProgram()) usesAwait = true;
    },
    ForOfStatement(path) {
      if (path.node.await && path.getFunctionParent()?.parentPath?.isProgram()) usesAwait = true;
    },
    Identifier(path) {
      const { name } = path.node;
      const global = path.isReferencedIdentifier() && !path.scope.getBinding(name);
      const parent = path.parent;
      const member = isMember(parent) && parent.object === path.node ? memberName(parent) : null;
      const called = isMember(parent) && (path.parentPath.parent as { callee?: Node }).callee === parent;

      if (global && name === "require") {
        const call = path.parent as { callee?: Node; arguments?: Node[] };
        const arg = call.callee === path.node ? call.arguments?.[0] : undefined;
        problem ??= arg?.type === "StringLiteral" ? `uses require("${arg.value}")` : "uses require";
      }
      if (global && (name === "eval" || name === "Function")) problem ??= `uses ${name}`;
      if (global && name === "process") {
        if (member === null) problem ??= "uses process directly";
        else if (!SAFE_PROCESS_PROPERTIES.has(member ?? "") && !SAFE_PROCESS_METHODS.has(member ?? "")) {
          problem ??= called ? `calls process.${member ?? "[…]"}()` : `uses process.${member ?? "[…]"}`;
        }
      }
      if (global && (name === "jest" || name === "vi")) {
        if (member === null) problem ??= `uses ${name} directly`;
        else if (member === undefined || FORBIDDEN_JEST_METHODS.has(member)) problem ??= `calls jest.${member ?? "[…]"}()`;
      }
      if (global && GLOBAL_OBJECTS.has(name) && (member === null || member === undefined || member === "process" || member === "require")) {
        problem ??= `uses ${name}${member ? `.${member}` : ""}`;
      }
      if ((name === "exports" || (name === "module" && path.parentPath.isMemberExpression({ object: path.node }))) && path.isReferencedIdentifier() && !path.scope.hasBinding(name)) {
        problem ??= `uses ${name === "module" ? "module.exports" : "exports"}, which is the test file's own module`;
      }
      if ((path.node.name === "describe" || path.node.name === "it" || path.node.name === "test") && path.parentPath.isCallExpression({ callee: path.node })) {
        problem ??= `wraps the body in ${path.node.name}()`;
      }
    },
  });

  if (problem) return { error: problem };
  if (!hasExpect) return { error: "does not call expect()" };
  return { async: usesAwait };
}

export function validateGeneration(generation: Generation, bindings: Binding[], extension: SupportedExtension): ValidationResult {
  const byName = new Map(bindings.map((b) => [b.binding, b]));
  const targets = new Set(byName.keys());
  const suites = new Map<string, ValidatedSuite>();
  const rejected: RejectedCase[] = [];

  for (const suite of generation.suites) {
    const binding = byName.get(suite.functionName);
    if (!binding) {
      for (const c of suite.cases) rejected.push({ functionName: suite.functionName, name: c.name, reason: "not a target function" });
      continue;
    }

    const target = suites.get(binding.binding) ?? { binding, cases: [] };
    suites.set(binding.binding, target);

    for (const testCase of suite.cases) {
      const reject = (reason: string) => rejected.push({ functionName: suite.functionName, name: testCase.name, reason });
      const name = testCase.name.trim();

      if (!name) {
        reject("has an empty name");
        continue;
      }
      if (name.length > MAX_NAME_LENGTH) {
        reject(`name is longer than ${MAX_NAME_LENGTH} characters`);
        continue;
      }
      if (target.cases.length >= MAX_CASES_PER_FUNCTION) {
        reject(`exceeds ${MAX_CASES_PER_FUNCTION} cases for this function`);
        continue;
      }

      const check = checkBody(testCase.body, extension, targets);
      if ("error" in check) {
        reject(check.error);
        continue;
      }

      let uniqueName = name;
      for (let n = 2; target.cases.some((c) => c.name === uniqueName); n++) uniqueName = `${name} (${n})`;
      target.cases.push({ ...testCase, name: uniqueName, body: testCase.body.trim(), async: check.async });
    }
  }

  return {
    suites: bindings.map((b) => suites.get(b.binding)).filter((s): s is ValidatedSuite => !!s && s.cases.length > 0),
    rejected,
  };
}
