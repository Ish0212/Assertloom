import traverse, { type NodePath } from "@babel/traverse";
import type { File, Node } from "@babel/types";
import type { ImportUsage, UsageShape } from "../types/index.js";

/** Globals Assertloom replaces with mocks when the source uses them. */
export const MOCKABLE_GLOBALS = ["fetch"] as const;

const MAX_DEPTH = 6;

export function emptyShape(): UsageShape {
  return { called: false, constructed: false, instanceOf: false, members: {}, resultNames: [], createdAtLoad: false };
}

/** True for a reference to a mockable global that the code does not declare itself. */
export function isMockableGlobal(path: NodePath): boolean {
  if (!path.isReferencedIdentifier() || path.node.type !== "Identifier") return false;
  const name = path.node.name;
  return (MOCKABLE_GLOBALS as readonly string[]).includes(name) && !path.scope.hasBinding(name, { noGlobals: true });
}

function memberName(node: Node): string | undefined {
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return undefined;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.property.type === "StringLiteral") return node.property.value;
  return undefined;
}

const TRANSPARENT = new Set(["TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "ParenthesizedExpression"]);

/** Records how the expression at `path`, whose value is described by `shape`, is used. */
function follow(path: NodePath, shape: UsageShape, depth: number): void {
  if (depth > MAX_DEPTH) return;
  let current = path;
  let cur = shape;

  for (;;) {
    const parent = current.parentPath;
    if (!parent) return;
    const node = parent.node;

    if (TRANSPARENT.has(node.type)) {
      current = parent;
      continue;
    }

    if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && node.object === current.node) {
      const name = memberName(node);
      if (!name) return;
      cur = cur.members[name] ??= emptyShape();
      current = parent;
      continue;
    }

    const isCall = (node.type === "CallExpression" || node.type === "OptionalCallExpression") && node.callee === current.node;
    const isNew = node.type === "NewExpression" && node.callee === current.node;
    if (isCall || isNew) {
      if (isCall) cur.called = true;
      else cur.constructed = true;

      let resultPath: NodePath = parent;
      if (resultPath.parentPath?.isAwaitExpression()) resultPath = resultPath.parentPath;
      const declarator = resultPath.parentPath;
      if (declarator?.isVariableDeclarator() && declarator.node.init === resultPath.node && declarator.node.id.type === "Identifier") {
        const name = declarator.node.id.name;
        const result = (cur.result ??= emptyShape());
        if (!cur.resultNames.includes(name)) cur.resultNames.push(name);
        if (declarator.scope.block.type === "Program") cur.createdAtLoad = true;
        for (const ref of declarator.scope.getBinding(name)?.referencePaths ?? []) follow(ref, result, depth + 1);
        return;
      }

      const next = resultPath.parentPath?.node;
      if (next && (next.type === "MemberExpression" || next.type === "OptionalMemberExpression") && next.object === resultPath.node) {
        cur = cur.result ??= emptyShape();
        current = resultPath;
        continue;
      }
      return;
    }

    if (node.type === "BinaryExpression" && node.operator === "instanceof" && node.right === current.node) {
      cur.instanceOf = true;
    }
    return;
  }
}

function stringValue(node: Node | undefined): string | undefined {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined;
  return undefined;
}

function propertyKey(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return undefined;
}

/**
 * Finds every runtime binding created by `import` or `require()` and records how the code uses it
 * (calls, `new`, member access, stored results), plus references to mockable globals.
 */
export function collectImportUsage(ast: File): { importUsage: ImportUsage[]; globals: string[] } {
  const importUsage: ImportUsage[] = [];
  const globals = new Set<string>();

  const track = (entry: Omit<ImportUsage, "shape">, binding: { referencePaths: NodePath[] } | undefined) => {
    const shape = emptyShape();
    for (const ref of binding?.referencePaths ?? []) follow(ref, shape, 0);
    importUsage.push({ ...entry, shape });
  };

  traverse(ast, {
    ImportDeclaration(path) {
      if (path.node.importKind === "type" || path.node.importKind === "typeof") return;
      const source = path.node.source.value;
      for (const s of path.node.specifiers) {
        if (s.type === "ImportSpecifier" && (s.importKind === "type" || s.importKind === "typeof")) continue;
        const imported =
          s.type === "ImportDefaultSpecifier" ? "default" : s.type === "ImportNamespaceSpecifier" ? "*" : propertyKey(s.imported) ?? "";
        track({ source, local: s.local.name, imported, style: "esm" }, path.scope.getBinding(s.local.name));
      }
    },

    CallExpression(path) {
      const callee = path.node.callee;
      if (callee.type !== "Identifier" || callee.name !== "require" || path.scope.hasBinding("require")) return;
      const source = stringValue(path.node.arguments[0] as Node | undefined);
      if (!source) return;

      const declarator = path.parentPath;
      if (declarator.isVariableDeclarator() && declarator.node.init === path.node) {
        const id = declarator.node.id;
        if (id.type === "Identifier") {
          track({ source, local: id.name, imported: "*", style: "commonjs" }, declarator.scope.getBinding(id.name));
        } else if (id.type === "ObjectPattern") {
          for (const prop of id.properties) {
            if (prop.type !== "ObjectProperty" || prop.value.type !== "Identifier") continue;
            const imported = propertyKey(prop.key);
            if (imported) track({ source, local: prop.value.name, imported, style: "commonjs" }, declarator.scope.getBinding(prop.value.name));
          }
        }
        return;
      }

      // `require("x").get(...)`: follow the call itself.
      const shape = emptyShape();
      follow(path, shape, 0);
      importUsage.push({ source, local: "", imported: "*", style: "commonjs", shape });
    },

    Identifier(path) {
      if (isMockableGlobal(path)) globals.add(path.node.name);
    },
  });

  return { importUsage, globals: [...globals].sort() };
}
