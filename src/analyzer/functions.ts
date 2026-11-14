import traverse from "@babel/traverse";
import type {
  ArrowFunctionExpression,
  ClassDeclaration,
  ClassExpression,
  ClassMethod,
  Expression,
  File,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectMethod,
  Statement,
} from "@babel/types";
import type { ClassInfo, FunctionInfo, ParameterInfo } from "../types/index.js";
import type { ImportScan } from "./dependencies.js";
import { isMockableGlobal } from "./usage.js";

type FunctionNode = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression | ObjectMethod | ClassMethod;

interface ClassRecord {
  name: string;
  node: ClassDeclaration | ClassExpression;
  exportedAs: string[];
}

interface Candidate {
  name: string;
  node: FunctionNode;
  exportedAs: string[];
  /** Owning class, for methods and constructors; the class record holds the export names. */
  classRecord?: ClassRecord;
}

function slice(code: string, node: Node | null | undefined): string | undefined {
  if (!node || node.start == null || node.end == null) return undefined;
  return code.slice(node.start, node.end);
}

function typeText(code: string, annotation: Node | null | undefined): string | undefined {
  if (annotation?.type === "TSTypeAnnotation") return slice(code, annotation.typeAnnotation);
  return undefined;
}

function patternText(code: string, node: Node & { typeAnnotation?: Node | null }): string {
  const end = node.typeAnnotation?.start ?? node.end ?? 0;
  return code.slice(node.start ?? 0, end).replace(/\?$/, "").trim();
}

function parameterInfo(code: string, param: FunctionNode["params"][number]): ParameterInfo {
  switch (param.type) {
    case "TSParameterProperty":
      return parameterInfo(code, param.parameter as FunctionNode["params"][number]);
    case "Identifier":
      return { name: param.name, type: typeText(code, param.typeAnnotation), optional: !!param.optional, rest: false };
    case "AssignmentPattern": {
      const left = parameterInfo(code, param.left as FunctionNode["params"][number]);
      return { ...left, optional: true, defaultValue: slice(code, param.right) };
    }
    case "RestElement": {
      const type = typeText(code, param.typeAnnotation) ?? typeText(code, (param.argument as { typeAnnotation?: Node }).typeAnnotation);
      const name = param.argument.type === "Identifier" ? param.argument.name : patternText(code, param.argument);
      return { name, type, optional: true, rest: true };
    }
    default:
      return {
        name: patternText(code, param),
        type: typeText(code, (param as { typeAnnotation?: Node }).typeAnnotation),
        optional: !!(param as { optional?: boolean }).optional,
        rest: false,
      };
  }
}

function unwrap(node: Expression | null | undefined): Expression | null | undefined {
  while (
    node &&
    (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "ParenthesizedExpression")
  ) {
    node = node.expression;
  }
  return node;
}

function asFunction(node: Node | null | undefined): FunctionExpression | ArrowFunctionExpression | undefined {
  const inner = unwrap(node as Expression | null | undefined);
  return inner?.type === "FunctionExpression" || inner?.type === "ArrowFunctionExpression" ? inner : undefined;
}

function propertyName(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return undefined;
}

const isModuleExports = (node: Node) =>
  node.type === "MemberExpression" &&
  node.object.type === "Identifier" &&
  node.object.name === "module" &&
  propertyName(node.property) === "exports";

/** Whether any node under `node` passes `test`. */
function someNode(node: unknown, test: (node: Node) => boolean): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => someNode(child, test));
  if (typeof (node as Node).type === "string" && test(node as Node)) return true;
  return Object.entries(node).some(([key, value]) => !key.endsWith("Comments") && key !== "loc" && someNode(value, test));
}

/**
 * The factory of a UMD wrapper, `(function (root, factory) { ... module.exports = factory(); ... })(this, function () { ... })`,
 * whose return value is what the module exports.
 */
function umdFactory(expression: Expression): FunctionExpression | ArrowFunctionExpression | undefined {
  let call = unwrap(expression);
  if (call?.type === "UnaryExpression") call = unwrap(call.argument);
  if (call?.type !== "CallExpression") return undefined;
  const wrapper = asFunction(call.callee);
  const index = call.arguments.findIndex((arg) => asFunction(arg));
  const param = wrapper?.params[index];
  if (!wrapper || index < 0 || param?.type !== "Identifier") return undefined;

  const exportsFactory = someNode(
    wrapper.body,
    (node) =>
      node.type === "AssignmentExpression" &&
      isModuleExports(node.left) &&
      node.right.type === "CallExpression" &&
      node.right.callee.type === "Identifier" &&
      node.right.callee.name === param.name,
  );
  const factory = asFunction(call.arguments[index]);
  return exportsFactory && factory?.body.type === "BlockStatement" ? factory : undefined;
}

/** `returnExports` treats `return x` as `module.exports = x` (the body of a UMD factory). */
function collectCandidates(body: Statement[], returnExports = false): { candidates: Candidate[]; classes: ClassRecord[] } {
  const candidates: Candidate[] = [];
  const classes: ClassRecord[] = [];
  const byLocalName = new Map<string, Candidate>();
  const byLocalClass = new Map<string, ClassRecord>();

  const addCandidate = (name: string, node: FunctionNode, exportedAs: string[] = [], classRecord?: ClassRecord) => {
    const existing = candidates.find((c) => c.node === node);
    if (existing) {
      for (const e of exportedAs) if (!existing.exportedAs.includes(e)) existing.exportedAs.push(e);
      return existing;
    }
    const candidate = { name, node, exportedAs, classRecord };
    candidates.push(candidate);
    if (!classRecord && name !== "default") byLocalName.set(name, candidate);
    return candidate;
  };

  /**
   * Registers a class and its testable methods: the constructor and public
   * instance/static methods. Getters, setters, and #private or TS-private /
   * TS-protected methods are skipped — tests outside the class cannot call them.
   */
  const addClass = (name: string, node: ClassDeclaration | ClassExpression, exportedAs: string[] = []) => {
    const existing = classes.find((c) => c.node === node);
    const record = existing ?? { name, node, exportedAs: [...exportedAs] };
    if (!existing) {
      classes.push(record);
      if (name !== "default") byLocalClass.set(name, record);
    } else {
      for (const e of exportedAs) if (!record.exportedAs.includes(e)) record.exportedAs.push(e);
    }
    for (const member of node.body.body) {
      if (member.type !== "ClassMethod") continue;
      if (member.kind !== "constructor" && member.kind !== "method") continue;
      if (member.accessibility === "private" || member.accessibility === "protected") continue;
      if (member.computed && member.key.type !== "StringLiteral") continue;
      const methodName = member.kind === "constructor" ? record.name : propertyName(member.key);
      if (!methodName) continue;
      addCandidate(methodName, member, [], record);
    }
    return record;
  };

  const addDeclaration = (stmt: Statement | null | undefined, exported: boolean) => {
    if (stmt?.type === "FunctionDeclaration" && stmt.id) {
      addCandidate(stmt.id.name, stmt, exported ? [stmt.id.name] : []);
    } else if (stmt?.type === "ClassDeclaration") {
      addClass(stmt.id?.name ?? "default", stmt, exported ? [stmt.id?.name ?? "default"] : []);
    } else if (stmt?.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        const fn = asFunction(decl.init);
        if (fn && decl.id.type === "Identifier") addCandidate(decl.id.name, fn, exported ? [decl.id.name] : []);
        if (decl.init?.type === "ClassExpression" && decl.id.type === "Identifier") {
          addClass(decl.id.name, decl.init, exported ? [decl.id.name] : []);
        }
      }
    }
  };

  const pendingExports: Array<{ local: string; exported: string }> = [];
  /** Top-level `const name = { ... }` objects, for `module.exports = name` and `exports.x = name.x`. */
  const objects = new Map<string, Expression>();
  const pendingObjects: string[] = [];
  const pendingMembers: Array<{ object: string; property: string; exported: string }> = [];

  const addCommonJsObject = (node: Expression) => {
    if (node.type !== "ObjectExpression") return;
    for (const prop of node.properties) {
      if (prop.type === "ObjectMethod" && prop.kind === "method") {
        const key = propertyName(prop.key);
        if (key) addCandidate(key, prop, [key]);
      } else if (prop.type === "ObjectProperty") {
        const key = propertyName(prop.key);
        if (!key) continue;
        const fn = asFunction(prop.value);
        if (fn) addCandidate(key, fn, [key]);
        else if (prop.value.type === "ClassExpression") addClass(key, prop.value, [key]);
        else if (prop.value.type === "Identifier") pendingExports.push({ local: prop.value.name, exported: key });
      }
    }
  };

  const exportModule = (value: Expression) => {
    const fn = asFunction(value);
    if (fn) addCandidate(fn.type === "FunctionExpression" && fn.id ? fn.id.name : "default", fn, ["default"]);
    else if (value.type === "ClassExpression") addClass(value.id?.name ?? "default", value, ["default"]);
    else if (value.type === "Identifier") {
      pendingExports.push({ local: value.name, exported: "default" });
      pendingObjects.push(value.name);
    } else addCommonJsObject(value);
  };

  for (const stmt of body) {
    switch (stmt.type) {
      case "ReturnStatement":
        if (returnExports && stmt.argument) exportModule(stmt.argument);
        break;

      case "FunctionDeclaration":
        addDeclaration(stmt, false);
        break;

      case "ClassDeclaration":
        addClass(stmt.id?.name ?? "default", stmt, []);
        break;

      case "VariableDeclaration":
        addDeclaration(stmt, false);
        for (const decl of stmt.declarations) {
          if (decl.id.type === "Identifier" && decl.init?.type === "ObjectExpression") objects.set(decl.id.name, decl.init);
        }
        break;

      case "ExportNamedDeclaration":
        if (stmt.declaration) {
          addDeclaration(stmt.declaration, stmt.exportKind !== "type");
        } else if (!stmt.source && stmt.exportKind !== "type") {
          for (const spec of stmt.specifiers) {
            if (spec.type !== "ExportSpecifier" || spec.exportKind === "type") continue;
            const local = propertyName(spec.local);
            const exported = propertyName(spec.exported);
            if (local && exported) pendingExports.push({ local, exported });
          }
        }
        break;

      case "ExportDefaultDeclaration": {
        const decl = stmt.declaration;
        if (decl.type === "FunctionDeclaration") {
          addCandidate(decl.id?.name ?? "default", decl, ["default"]);
        } else if (decl.type === "ClassDeclaration" || decl.type === "ClassExpression") {
          addClass(decl.id?.name ?? "default", decl, ["default"]);
        } else if (decl.type === "Identifier") {
          pendingExports.push({ local: decl.name, exported: "default" });
        } else {
          const fn = asFunction(decl);
          if (fn) addCandidate(fn.type === "FunctionExpression" && fn.id ? fn.id.name : "default", fn, ["default"]);
        }
        break;
      }

      case "ExpressionStatement": {
        const expr = stmt.expression;
        const factory = umdFactory(expr);
        if (factory?.body.type === "BlockStatement") {
          const inner = collectCandidates(factory.body.body, true);
          for (const c of inner.candidates) addCandidate(c.name, c.node, c.exportedAs, c.classRecord);
          for (const cls of inner.classes) {
            if (!classes.some((c) => c.node === cls.node)) {
              classes.push(cls);
              if (cls.name !== "default") byLocalClass.set(cls.name, cls);
            }
          }
          break;
        }
        if (expr.type !== "AssignmentExpression" || expr.operator !== "=" || expr.left.type !== "MemberExpression") break;
        const { object, property } = expr.left;

        if (isModuleExports(expr.left)) {
          exportModule(expr.right);
          break;
        }

        const isExportsObject =
          (object.type === "Identifier" && object.name === "exports") ||
          (object.type === "MemberExpression" &&
            object.object.type === "Identifier" &&
            object.object.name === "module" &&
            propertyName(object.property) === "exports");
        const key = !expr.left.computed ? propertyName(property) : undefined;
        if (!isExportsObject || !key) break;

        const fn = asFunction(expr.right);
        if (fn) addCandidate(key, fn, [key]);
        else if (expr.right.type === "ClassExpression") addClass(key, expr.right, [key]);
        else if (expr.right.type === "Identifier") pendingExports.push({ local: expr.right.name, exported: key });
        else if (expr.right.type === "MemberExpression" && expr.right.object.type === "Identifier" && !expr.right.computed) {
          const member = propertyName(expr.right.property);
          if (member) pendingMembers.push({ object: expr.right.object.name, property: member, exported: key });
        }
        break;
      }
    }
  }

  for (const name of pendingObjects) {
    const object = objects.get(name);
    if (object) addCommonJsObject(object);
  }
  for (const { object, property, exported } of pendingMembers) {
    const node = objects.get(object);
    if (node?.type !== "ObjectExpression") continue;
    for (const prop of node.properties) {
      if (prop.type !== "ObjectProperty" || propertyName(prop.key) !== property) continue;
      const fn = asFunction(prop.value);
      if (fn) addCandidate(exported, fn, [exported]);
      else if (prop.value.type === "ClassExpression") addClass(exported, prop.value, [exported]);
      else if (prop.value.type === "Identifier") pendingExports.push({ local: prop.value.name, exported });
    }
  }

  for (const { local, exported } of pendingExports) {
    const candidate = byLocalName.get(local);
    if (candidate && !candidate.exportedAs.includes(exported)) candidate.exportedAs.push(exported);
    const cls = byLocalClass.get(local);
    if (cls && !cls.exportedAs.includes(exported)) cls.exportedAs.push(exported);
  }

  return { candidates, classes };
}

export function extractFunctions(ast: File, code: string, scan: ImportScan): { functions: FunctionInfo[]; classes: ClassInfo[] } {
  const { candidates, classes } = collectCandidates(ast.program.body);
  const byNode = new Map<Node, Candidate>(candidates.map((c) => [c.node, c]));
  const results: FunctionInfo[] = [];

  traverse(ast, {
    Function(path) {
      const candidate = byNode.get(path.node);
      if (!candidate) return;

      const node = candidate.node;
      const programScope = path.scope.getProgramParent();
      const dependencies = new Set<string>();
      const globals = new Set<string>();
      let throws = false;

      path.traverse({
        "Identifier|JSXIdentifier"(idPath) {
          if (isMockableGlobal(idPath)) globals.add((idPath.node as { name: string }).name);
          if (!idPath.isReferencedIdentifier()) return;
          const name = (idPath.node as { name: string }).name;
          const source = scan.bindings.get(name);
          if (source && idPath.scope.getBinding(name) === programScope.getBinding(name)) dependencies.add(source);
        },
        "CallExpression|ImportExpression"(callPath) {
          const source = scan.callSites.get(callPath.node);
          if (source) dependencies.add(source);
        },
        ThrowStatement(throwPath) {
          if (throwPath.getFunctionParent()?.node === node) throws = true;
        },
      });

      results.push({
        name: candidate.name,
        exported: candidate.classRecord ? candidate.classRecord.exportedAs.length > 0 : candidate.exportedAs.length > 0,
        exportedAs: candidate.classRecord ? [...candidate.classRecord.exportedAs] : candidate.exportedAs,
        kind:
          node.type === "ClassMethod"
            ? node.kind === "constructor"
              ? "constructor"
              : "method"
            : node.type === "ArrowFunctionExpression"
              ? "arrow"
              : node.type === "FunctionDeclaration"
                ? "declaration"
                : "expression",
        className: candidate.classRecord?.name,
        static: node.type === "ClassMethod" ? node.static : undefined,
        async: node.async,
        generator: !!node.generator,
        parameters: node.params.filter((p) => !(p.type === "Identifier" && p.name === "this")).map((p) => parameterInfo(code, p)),
        returnType: typeText(code, node.returnType),
        typeParameters: slice(code, node.typeParameters),
        throws,
        dependencies: [...dependencies].sort(),
        globals: [...globals].sort(),
        line: node.loc?.start.line ?? 0,
      });
    },
  });

  return {
    functions: results.sort((a, b) => a.line - b.line),
    classes: classes
      .map((c) => ({
        name: c.name,
        exported: c.exportedAs.length > 0,
        exportedAs: c.exportedAs,
        superClass: slice(code, c.node.superClass),
        typeParameters: slice(code, c.node.typeParameters),
        line: c.node.loc?.start.line ?? 0,
      }))
      .sort((a, b) => a.line - b.line),
  };
}
