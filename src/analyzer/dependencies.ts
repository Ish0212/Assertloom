import { builtinModules } from "node:module";
import traverse, { type NodePath } from "@babel/traverse";
import type { CallExpression, File, Node } from "@babel/types";
import type { DependencySummary, ImportCategory, ImportInfo, ImportSpecifierInfo } from "../types/index.js";

export interface ImportScan {
  imports: ImportInfo[];
  /** Top-level runtime bindings created by imports, keyed by local name. */
  bindings: Map<string, string>;
  /** `require()` and `import()` call nodes, mapped to the module they load. */
  callSites: Map<Node, string>;
  usesCommonJsExports: boolean;
}

export function classifySource(source: string): { category: ImportCategory; packageName?: string } {
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("#")) {
    return { category: "local" };
  }
  if (source.startsWith("node:") || builtinModules.includes(source)) {
    return { category: "builtin" };
  }
  const segments = source.split("/");
  const packageName = source.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  return { category: "external", packageName };
}

function stringValue(node: Node | null | undefined): string | undefined {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined;
  return undefined;
}

function moduleName(node: Node): string {
  return node.type === "StringLiteral" ? node.value : node.type === "Identifier" ? node.name : "";
}

function isRequireCall(path: NodePath<CallExpression>): boolean {
  const callee = path.node.callee;
  return callee.type === "Identifier" && callee.name === "require" && !path.scope.hasBinding("require");
}

function isCommonJsExportTarget(node: Node): boolean {
  if (node.type !== "MemberExpression") return false;
  if (node.object.type === "Identifier") {
    return (
      node.object.name === "exports" ||
      (node.object.name === "module" && node.property.type === "Identifier" && node.property.name === "exports")
    );
  }
  return isCommonJsExportTarget(node.object);
}

export function scanImports(ast: File): ImportScan {
  const imports: ImportInfo[] = [];
  const bindings = new Map<string, string>();
  const callSites = new Map<Node, string>();
  let usesCommonJsExports = false;

  const add = (source: string, info: Omit<ImportInfo, "source" | "category" | "packageName">) => {
    imports.push({ source, ...classifySource(source), ...info });
  };

  traverse(ast, {
    ImportDeclaration(path) {
      const node = path.node;
      const source = node.source.value;
      const typeOnly =
        node.importKind === "type" ||
        (node.specifiers.length > 0 && node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type"));

      const specifiers: ImportSpecifierInfo[] = node.specifiers.map((s) => {
        if (s.type === "ImportDefaultSpecifier") return { kind: "default", imported: "default", local: s.local.name };
        if (s.type === "ImportNamespaceSpecifier") return { kind: "namespace", imported: "*", local: s.local.name };
        return { kind: "named", imported: moduleName(s.imported), local: s.local.name };
      });

      if (!typeOnly) {
        for (const s of node.specifiers) {
          if (s.type === "ImportSpecifier" && s.importKind === "type") continue;
          bindings.set(s.local.name, source);
        }
      }

      add(source, { kind: "import", typeOnly, specifiers, line: node.loc?.start.line ?? 0 });
    },

    ExportNamedDeclaration(path) {
      const node = path.node;
      if (!node.source) return;
      const specifiers: ImportSpecifierInfo[] = node.specifiers.map((s) =>
        s.type === "ExportNamespaceSpecifier"
          ? { kind: "namespace", imported: "*", local: moduleName(s.exported) }
          : { kind: "named", imported: moduleName(s.type === "ExportSpecifier" ? s.local : s.exported), local: moduleName(s.exported) },
      );
      add(node.source.value, {
        kind: "re-export",
        typeOnly: node.exportKind === "type",
        specifiers,
        line: node.loc?.start.line ?? 0,
      });
    },

    ExportAllDeclaration(path) {
      const node = path.node;
      add(node.source.value, {
        kind: "re-export",
        typeOnly: node.exportKind === "type",
        specifiers: [{ kind: "namespace", imported: "*", local: "*" }],
        line: node.loc?.start.line ?? 0,
      });
    },

    ImportExpression(path) {
      const source = stringValue(path.node.source);
      if (!source) return;
      callSites.set(path.node, source);
      add(source, { kind: "dynamic-import", typeOnly: false, specifiers: [], line: path.node.loc?.start.line ?? 0 });
    },

    CallExpression(path) {
      if (!isRequireCall(path)) return;
      const source = stringValue(path.node.arguments[0]);
      if (!source) return;
      callSites.set(path.node, source);

      const specifiers: ImportSpecifierInfo[] = [];
      const declarator = path.parentPath;
      if (declarator.isVariableDeclarator() && declarator.node.init === path.node) {
        const id = declarator.node.id;
        if (id.type === "Identifier") {
          specifiers.push({ kind: "namespace", imported: "*", local: id.name });
        } else if (id.type === "ObjectPattern") {
          for (const prop of id.properties) {
            if (prop.type === "ObjectProperty" && prop.value.type === "Identifier") {
              specifiers.push({ kind: "named", imported: moduleName(prop.key), local: prop.value.name });
            }
          }
        }
        if (path.scope.getProgramParent() === path.scope) {
          for (const s of specifiers) bindings.set(s.local, source);
        }
      }

      add(source, { kind: "require", typeOnly: false, specifiers, line: path.node.loc?.start.line ?? 0 });
    },

    AssignmentExpression(path) {
      if (isCommonJsExportTarget(path.node.left)) usesCommonJsExports = true;
    },

    // `const client = new PrismaClient()` makes `client` a stand-in for "@prisma/client".
    VariableDeclarator(path) {
      const { id, init } = path.node;
      if (id.type !== "Identifier" || !init || path.scope !== path.scope.getProgramParent()) return;
      if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") return;

      const programScope = path.scope;
      path.traverse({
        Identifier(idPath) {
          if (bindings.has(id.name) || !idPath.isReferencedIdentifier()) return;
          const source = bindings.get(idPath.node.name);
          if (source && idPath.scope.getBinding(idPath.node.name) === programScope.getBinding(idPath.node.name)) {
            bindings.set(id.name, source);
          }
        },
      });
    },
  });

  imports.sort((a, b) => a.line - b.line);
  return { imports, bindings, callSites, usesCommonJsExports };
}

export function summarizeDependencies(imports: ImportInfo[]): DependencySummary {
  const local = new Set<string>();
  const external = new Set<string>();
  const builtin = new Set<string>();

  for (const entry of imports) {
    if (entry.typeOnly) continue;
    if (entry.category === "local") local.add(entry.source);
    else if (entry.category === "builtin") builtin.add(entry.source.replace(/^node:/, ""));
    else if (entry.packageName) external.add(entry.packageName);
  }

  return { local: [...local].sort(), external: [...external].sort(), builtin: [...builtin].sort() };
}
