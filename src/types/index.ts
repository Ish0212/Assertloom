export const SUPPORTED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export type SourceLanguage = "typescript" | "javascript";

export interface SourceFile {
  /** Path as the user typed it, normalized for display. */
  inputPath: string;
  absolutePath: string;
  extension: SupportedExtension;
  language: SourceLanguage;
  sizeBytes: number;
}

export interface ParameterInfo {
  /** Identifier name, or the source text of a destructuring pattern such as `{ id, name }`. */
  name: string;
  type?: string;
  optional: boolean;
  rest: boolean;
  defaultValue?: string;
}

export interface FunctionInfo {
  /** Local name, or `"default"` for an anonymous default export. */
  name: string;
  exported: boolean;
  /** Names this function is exported under; `"default"` for a default export. */
  exportedAs: string[];
  kind: "declaration" | "arrow" | "expression";
  async: boolean;
  generator: boolean;
  parameters: ParameterInfo[];
  returnType?: string;
  typeParameters?: string;
  throws: boolean;
  /** Import sources referenced inside the function body. */
  dependencies: string[];
  /** Mockable globals referenced inside the function body, such as `fetch`. */
  globals: string[];
  line: number;
}

/** How the source uses an imported value. Assertloom builds mocks from this. */
export interface UsageShape {
  called: boolean;
  constructed: boolean;
  /** Used on the right-hand side of `instanceof`. */
  instanceOf: boolean;
  /** Properties read from the value. */
  members: Record<string, UsageShape>;
  /** How the value returned by a call or `new` is used, when it is kept. */
  result?: UsageShape;
  /** Variables the result is stored in, e.g. `pool` for `const pool = new Pool()`. */
  resultNames: string[];
  /** The result is stored in a top-level variable, so it is created when the module loads. */
  createdAtLoad: boolean;
}

export interface ImportUsage {
  source: string;
  local: string;
  /** `"default"`, `"*"` (namespace or whole CommonJS module), or an export name. */
  imported: string;
  style: "esm" | "commonjs";
  shape: UsageShape;
}

export type ImportCategory = "local" | "external" | "builtin";

export interface ImportSpecifierInfo {
  kind: "default" | "named" | "namespace";
  /** Exported name in the source module; `"default"` or `"*"` for default/namespace imports. */
  imported: string;
  local: string;
}

export interface ImportInfo {
  source: string;
  kind: "import" | "require" | "dynamic-import" | "re-export";
  category: ImportCategory;
  /** Package name for external imports, e.g. `@prisma/client` for `@prisma/client/runtime`. */
  packageName?: string;
  typeOnly: boolean;
  specifiers: ImportSpecifierInfo[];
  line: number;
}

export interface DependencySummary {
  local: string[];
  external: string[];
  builtin: string[];
}

export interface FileAnalysis {
  file: string;
  language: SourceLanguage;
  moduleSystem: "esm" | "commonjs" | "mixed" | "none";
  functions: FunctionInfo[];
  imports: ImportInfo[];
  /** One entry per imported binding, with how the source uses it. */
  importUsage: ImportUsage[];
  /** Mockable globals the file references, such as `fetch`. */
  globals: string[];
  dependencies: DependencySummary;
}
