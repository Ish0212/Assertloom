import traverse from "@babel/traverse";
import type {
  ArrowFunctionExpression,
  Expression,
  File,
  FunctionDeclaration,
  FunctionExpression,
  Node,
  ObjectMethod,
  Statement,
} from "@babel/types";
import type { FunctionInfo, ParameterInfo } from "../types/index.js";
import type { ImportScan } from "./dependencies.js";
import { isMockableGlobal } from "./usage.js";

type FunctionNode = FunctionDeclaration | FunctionExpression | ArrowFunctionExpression | ObjectMethod;

interface Candidate {
  name: string;
  node: FunctionNode;
  exportedAs: string[];
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

function collectCandidates(body: Statement[]): Candidate[] {
  const candidates: Candidate[] = [];
  const byLocalName = new Map<string, Candidate>();

  const addCandidate = (name: string, node: FunctionNode, exportedAs: string[] = []) => {
    const candidate = { name, node, exportedAs };
    candidates.push(candidate);
    if (name !== "default") byLocalName.set(name, candidate);
    return candidate;
  };

  const addDeclaration = (stmt: Statement | null | undefined, exported: boolean) => {
    if (stmt?.type === "FunctionDeclaration" && stmt.id) {
      addCandidate(stmt.id.name, stmt, exported ? [stmt.id.name] : []);
    } else if (stmt?.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        const fn = asFunction(decl.init);
        if (fn && decl.id.type === "Identifier") addCandidate(decl.id.name, fn, exported ? [decl.id.name] : []);
      }
    }
  };

  const pendingExports: Array<{ local: string; exported: string }> = [];

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
        else if (prop.value.type === "Identifier") pendingExports.push({ local: prop.value.name, exported: key });
      }
    }
  };

  for (const stmt of body) {
    switch (stmt.type) {
      case "FunctionDeclaration":
      case "VariableDeclaration":
        addDeclaration(stmt, false);
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
        if (expr.type !== "AssignmentExpression" || expr.operator !== "=" || expr.left.type !== "MemberExpression") break;
        const { object, property } = expr.left;
        const isModuleExports =
          object.type === "Identifier" && object.name === "module" && propertyName(property) === "exports";

        if (isModuleExports) {
          const fn = asFunction(expr.right);
          if (fn) addCandidate(fn.type === "FunctionExpression" && fn.id ? fn.id.name : "default", fn, ["default"]);
          else if (expr.right.type === "Identifier") pendingExports.push({ local: expr.right.name, exported: "default" });
          else addCommonJsObject(expr.right);
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
        else if (expr.right.type === "Identifier") pendingExports.push({ local: expr.right.name, exported: key });
        break;
      }
    }
  }

  for (const { local, exported } of pendingExports) {
    const candidate = byLocalName.get(local);
    if (candidate && !candidate.exportedAs.includes(exported)) candidate.exportedAs.push(exported);
  }

  return candidates;
}

export function extractFunctions(ast: File, code: string, scan: ImportScan): FunctionInfo[] {
  const candidates = collectCandidates(ast.program.body);
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
        exported: candidate.exportedAs.length > 0,
        exportedAs: candidate.exportedAs,
        kind: node.type === "ArrowFunctionExpression" ? "arrow" : node.type === "FunctionDeclaration" ? "declaration" : "expression",
        async: node.async,
        generator: !!node.generator,
        parameters: node.params.map((p) => parameterInfo(code, p)),
        returnType: typeText(code, node.returnType),
        typeParameters: slice(code, node.typeParameters),
        throws,
        dependencies: [...dependencies].sort(),
        globals: [...globals].sort(),
        line: node.loc?.start.line ?? 0,
      });
    },
  });

  return results.sort((a, b) => a.line - b.line);
}
