import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JestSetup } from "./project.js";

const require = createRequire(import.meta.url);

export interface RunFiles {
  testPath: string;
  sourcePath: string;
  coverageDir: string;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches exactly this test file by its full path, on any OS path separator. */
export function testRegexFor(testPath: string): string {
  return `^${testPath.split(/[\\/]/).map(escapeRegex).join("[\\\\/]")}$`;
}

function coverageGlob(rootDir: string, sourcePath: string): string {
  return path.relative(rootDir, sourcePath).replaceAll("\\", "/");
}

export function defaultJestConfig(root: string, files: RunFiles): Record<string, unknown> {
  const babelOptions = {
    babelrc: false,
    configFile: false,
    presets: [require.resolve("@babel/preset-typescript"), [require.resolve("@babel/preset-react"), { runtime: "automatic" }]],
    plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
  };

  return {
    rootDir: root,
    roots: [...new Set([path.dirname(files.testPath), path.dirname(files.sourcePath)])],
    testEnvironment: "node",
    testRegex: testRegexFor(files.testPath),
    transform: { "\\.[cm]?[jt]sx?$": [require.resolve("babel-jest"), babelOptions] },
    moduleFileExtensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "json", "node"],
    moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
    collectCoverageFrom: [coverageGlob(root, files.sourcePath)],
    coverageProvider: "v8",
    coverageReporters: ["json-summary"],
    coverageDirectory: files.coverageDir,
  };
}

/** Loads the project's own config at run time and overrides only test selection and coverage. */
function wrapperModule(baseConfigExpression: string, baseDir: string, files: RunFiles): string {
  const overrides = {
    testRegex: testRegexFor(files.testPath),
    coverageProvider: "v8",
    coverageReporters: ["json-summary"],
    coverageDirectory: files.coverageDir,
  };

  return `import path from "node:path";

const baseDir = ${JSON.stringify(baseDir)};
const sourcePath = ${JSON.stringify(files.sourcePath)};
const testPath = ${JSON.stringify(files.testPath)};

const ignores = (pattern, rootDir) => {
  try {
    // Jest rewrites "/" in these patterns to the OS separator, so check both spellings of the path.
    const regex = new RegExp(pattern.replaceAll("<rootDir>", rootDir));
    return regex.test(testPath) || regex.test(testPath.split(path.sep).join("/"));
  } catch {
    return false;
  }
};

export default async () => {
  let config = ${baseConfigExpression};
  if (typeof config === "function") config = await config();
  config = { ...config };
  if (config.projects) throw new Error("Assertloom: Jest \`projects\` configurations are not supported yet.");
  delete config.testMatch;
  const rootDir = config.rootDir ? path.resolve(baseDir, config.rootDir) : baseDir;
  if (Array.isArray(config.roots)) config.roots = [...config.roots, path.dirname(testPath)];
  if (Array.isArray(config.testPathIgnorePatterns)) {
    config.testPathIgnorePatterns = config.testPathIgnorePatterns.filter((p) => !ignores(p, rootDir));
  }
  return {
    ...config,
    rootDir,
    ...${JSON.stringify(overrides)},
    collectCoverageFrom: [path.relative(rootDir, sourcePath).split(path.sep).join("/")],
  };
};
`;
}

/** Writes the Jest config for one run into `runDir` and returns its path. */
export async function writeRunConfig(setup: JestSetup, files: RunFiles, runDir: string): Promise<string> {
  if (setup.config.kind === "default") {
    const file = path.join(runDir, "jest.config.json");
    await writeFile(file, JSON.stringify(defaultJestConfig(setup.root, files), null, 2));
    return file;
  }

  const baseDir = setup.config.kind === "file" ? path.dirname(setup.config.path) : setup.root;
  let baseConfigExpression: string;
  if (setup.config.kind === "package-json") {
    baseConfigExpression = JSON.stringify(setup.config.config);
  } else if (setup.config.path.endsWith(".json")) {
    baseConfigExpression = JSON.stringify(JSON.parse(await readFile(setup.config.path, "utf8")));
  } else {
    baseConfigExpression = `(await import(${JSON.stringify(pathToFileURL(setup.config.path).href)})).default`;
  }

  const file = path.join(runDir, "jest.config.mjs");
  await writeFile(file, wrapperModule(baseConfigExpression, baseDir, files));
  return file;
}
