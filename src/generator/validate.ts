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

function rootIdentifier(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return rootIdentifier(node.object);
  if (node.type === "CallExpression") return rootIdentifier(node.callee);
  return undefined;
}

/** Returns why a test body is unacceptable, or whether it needs an async callback. */
export function checkBody(body: string, extension: SupportedExtension): { error: string } | { async: boolean } {
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

  let hasExpect = false;
  let usesAwait = false;
  let problem: string | undefined;

  traverse(ast, {
    CallExpression(path) {
      const callee = path.node.callee;
      if (rootIdentifier(callee) === "expect") hasExpect = true;
      if (callee.type === "Identifier" && callee.name === "require") problem = "uses require()";
      if (rootIdentifier(callee) === "jest" || rootIdentifier(callee) === "vi") {
        const member = callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : "";
        if (FORBIDDEN_JEST_METHODS.has(member)) problem = `calls jest.${member}()`;
      }
      if (callee.type === "MemberExpression" && rootIdentifier(callee) === "process") problem = "calls a process method";
    },
    ImportExpression() {
      problem = "uses import()";
    },
    AwaitExpression(path) {
      if (path.getFunctionParent()?.parentPath?.isProgram()) usesAwait = true;
    },
    ForOfStatement(path) {
      if (path.node.await && path.getFunctionParent()?.parentPath?.isProgram()) usesAwait = true;
    },
    Identifier(path) {
      if ((path.node.name === "describe" || path.node.name === "it" || path.node.name === "test") && path.parentPath.isCallExpression({ callee: path.node })) {
        problem = `wraps the body in ${path.node.name}()`;
      }
    },
  });

  if (problem) return { error: problem };
  if (!hasExpect) return { error: "does not call expect()" };
  return { async: usesAwait };
}

export function validateGeneration(generation: Generation, bindings: Binding[], extension: SupportedExtension): ValidationResult {
  const byName = new Map(bindings.map((b) => [b.binding, b]));
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

      const check = checkBody(testCase.body, extension);
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
