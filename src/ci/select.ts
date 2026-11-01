import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { UserError } from "../errors.js";
import { SUPPORTED_EXTENSIONS } from "../types/index.js";

export class SelectionError extends UserError {}

/**
 * Paths that are never worth generating tests for: dependencies, build output, tests themselves,
 * type declarations, minified and generated code.
 */
export const DEFAULT_EXCLUDES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/__generated__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.d.ts",
  "**/*.d.mts",
  "**/*.d.cts",
  "**/*.min.js",
  "**/*.generated.*",
];

export type ChangeStatus = "added" | "modified" | "renamed" | "copied" | "deleted" | "explicit";

export interface ChangedFile {
  /** Repository-relative path with forward slashes. */
  path: string;
  status: ChangeStatus;
  /** Previous path of a renamed or copied file. */
  from?: string;
}

export type SkipReason =
  | "deleted"
  | "unsupported"
  | "excluded"
  | "not-included"
  | "generated"
  | "not-a-file"
  | "outside-workspace"
  | "too-large"
  | "file-limit"
  | "budget"
  | "no-exported-functions"
  | "preview-exists"
  | "dry-run"
  | "not-processed";

export interface Candidate extends ChangedFile {
  /** Undefined when the file is eligible. */
  skip?: { reason: SkipReason; detail: string };
}

const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Arguments are passed as an array with no shell, so file names and refs are never interpreted.
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve(stdout);
    });
  });
}

/** Commit-ish values from event data or inputs. Rejects anything git could read as an option. */
export function checkRef(ref: string, name: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/~^@{}-]*$/.test(ref) || ref.includes("..")) {
    throw new SelectionError(`${name} "${ref.slice(0, 80)}" is not a valid commit SHA or ref.`);
  }
  return ref;
}

export async function repositoryRoot(cwd: string): Promise<string> {
  try {
    return path.resolve((await git(["rev-parse", "--show-toplevel"], cwd)).trim());
  } catch {
    throw new SelectionError(`${cwd} is not inside a git repository. Check out the repository first (actions/checkout).`);
  }
}

async function resolveCommit(ref: string, name: string, cwd: string): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd)).trim();
  } catch {
    const shallow = (await git(["rev-parse", "--is-shallow-repository"], cwd).catch(() => "")).trim() === "true";
    throw new SelectionError(
      `The ${name} commit ${ref} is not available in this checkout${shallow ? " (it is a shallow clone)" : ""}. ` +
        "Check out with full history (actions/checkout with `fetch-depth: 0`), or fetch the base commit before running Assertloom.",
    );
  }
}

/** Parses `git diff --name-status -z` output. Paths may contain spaces, quotes, newlines, or any other byte. */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    const kind = code[0];
    if (kind === "R" || kind === "C") {
      const from = fields[i++];
      const to = fields[i++];
      files.push({ path: to, status: kind === "R" ? "renamed" : "copied", from });
    } else {
      const file = fields[i++];
      const status: ChangeStatus = kind === "A" ? "added" : kind === "D" ? "deleted" : "modified";
      files.push({ path: file, status });
    }
  }
  return files;
}

/**
 * Files added, modified, renamed, or deleted on `head` since it branched from `base`
 * (`git diff base...head`), relative to the repository root.
 */
export async function changedFiles(options: { cwd: string; base: string; head?: string }): Promise<ChangedFile[]> {
  const base = await resolveCommit(checkRef(options.base, "Base"), "base", options.cwd);
  const head = await resolveCommit(checkRef(options.head ?? "HEAD", "Head"), "head", options.cwd);
  try {
    await git(["merge-base", base, head], options.cwd);
  } catch {
    throw new SelectionError(
      `No common ancestor of ${base.slice(0, 12)} and ${head.slice(0, 12)} is available. ` +
        "The checkout is probably shallow: use actions/checkout with `fetch-depth: 0`.",
    );
  }
  const output = await git(
    ["-c", "core.quotepath=off", "diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--"],
    options.cwd,
  );
  return parseNameStatus(output);
}

/** Splits a multi-line or comma-separated input into trimmed, non-empty entries. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Like `splitList`, but newline-only, so file names may contain commas. */
export function splitLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Converts a glob to a regular expression: `**` matches any number of directories, `*` anything but `/`,
 * `?` one character, and `{a,b}` alternatives. Patterns without a `/` match the file name at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes("/") ? glob.replace(/^\.\//, "").replace(/^\//, "") : `**/${glob}`;
  let re = "";
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(file));
}

const toPosix = (p: string) => p.split(path.sep).join("/");

/** `@generated` near the top of a file marks it as machine-written (a common convention). */
function looksGenerated(head: string): boolean {
  return /@generated\b|\bDO NOT EDIT\b|^\/\/ Generated by Assertloom\./m.test(head.slice(0, 600));
}

export interface ClassifyOptions {
  root: string;
  include: string[];
  exclude: string[];
  useDefaultExcludes: boolean;
}

/** Decides for each changed file whether Assertloom should generate tests for it, and why not. */
export async function classify(files: ChangedFile[], options: ClassifyOptions): Promise<Candidate[]> {
  const include = options.include.map(globToRegExp);
  const exclude = [...(options.useDefaultExcludes ? DEFAULT_EXCLUDES : []), ...options.exclude].map(globToRegExp);
  const realRoot = await realpath(options.root);
  const seen = new Set<string>();
  const result: Candidate[] = [];

  for (const file of files) {
    const rel = toPosix(file.path);
    const key = `${file.status === "deleted" ? "D" : ""}${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate: Candidate = { ...file, path: rel };
    candidate.skip = await skipReason(candidate, { include, exclude, root: options.root, realRoot });
    result.push(candidate);
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function skipReason(
  file: ChangedFile,
  ctx: { include: RegExp[]; exclude: RegExp[]; root: string; realRoot: string },
): Promise<Candidate["skip"]> {
  if (file.status === "deleted") return { reason: "deleted", detail: "deleted in this change" };

  const absolute = path.resolve(ctx.root, file.path);
  const inside = path.relative(ctx.root, absolute);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { reason: "outside-workspace", detail: "path is outside the repository" };
  }

  const extension = path.extname(file.path).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    return { reason: "unsupported", detail: `unsupported file type "${extension || "(none)"}"` };
  }
  if (matchesAny(file.path, ctx.exclude)) return { reason: "excluded", detail: "matches an exclude pattern" };
  if (ctx.include.length && !matchesAny(file.path, ctx.include)) return { reason: "not-included", detail: "matches no include pattern" };

  let stats;
  try {
    stats = await lstat(absolute);
  } catch {
    return { reason: "not-a-file", detail: "not found in the checkout" };
  }
  // A symlink could point outside the repository; its target would be sent to the model.
  if (stats.isSymbolicLink()) return { reason: "not-a-file", detail: "symbolic link" };
  if (!stats.isFile()) return { reason: "not-a-file", detail: "not a regular file" };
  const real = await realpath(absolute);
  const realInside = path.relative(ctx.realRoot, real);
  if (realInside.startsWith("..") || path.isAbsolute(realInside)) {
    return { reason: "outside-workspace", detail: "resolves outside the repository" };
  }
  if (stats.size > MAX_FILE_SIZE_BYTES) return { reason: "too-large", detail: `${Math.round(stats.size / 1024)} KB; the limit is 1 MB` };

  const head = (await readFile(absolute, "utf8")).slice(0, 600);
  if (looksGenerated(head)) return { reason: "generated", detail: "marked as generated" };
  return undefined;
}

/** Explicit file inputs, for manual runs outside a pull request. */
export function explicitFiles(paths: string[], root: string, cwd: string): ChangedFile[] {
  return paths.map((p) => {
    const relative = path.relative(root, path.resolve(cwd, p));
    return { path: relative.startsWith("..") || path.isAbsolute(relative) ? p : toPosix(relative), status: "explicit" as const };
  });
}
