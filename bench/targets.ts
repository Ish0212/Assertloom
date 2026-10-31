/**
 * Benchmark targets: one source file from each of several independent open-source packages,
 * pinned to an exact published version so every run sees the same code.
 */
export interface Target {
  /** Exact npm version, e.g. `ms@2.1.3`. */
  package: string;
  /** File inside the package to generate tests for. */
  file: string;
  /** What makes this file a useful test case. */
  why: string;
}

export const TARGETS: Target[] = [
  { package: "ms@2.1.3", file: "index.js", why: "CommonJS, string parsing with many branches" },
  { package: "bytes@3.1.2", file: "index.js", why: "CommonJS, formatting and parsing with options" },
  { package: "escape-html@1.0.3", file: "index.js", why: "CommonJS, single function with a fast path" },
  { package: "content-type@1.0.5", file: "index.js", why: "CommonJS, parser that throws TypeErrors" },
  { package: "cookie@0.7.2", file: "index.js", why: "CommonJS, parse/serialize with validation errors" },
  { package: "camelcase@8.0.0", file: "index.js", why: "native ESM package (type: module)" },
  { package: "slugify@1.6.6", file: "slugify.js", why: "UMD wrapper instead of plain exports" },
  { package: "semver@7.6.3", file: "functions/inc.js", why: "imports local modules from the same package" },
  { package: "dotenv@16.4.7", file: "lib/main.js", why: "file system, os, and crypto side effects to mock" },
];
