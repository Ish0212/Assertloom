import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CoverageMetrics } from "./types.js";

interface Metric {
  total: number;
  pct: number | string;
}

type CoverageSummary = Record<string, Record<"lines" | "statements" | "functions" | "branches", Metric>>;

function percent(metric: Metric | undefined): number | null {
  if (!metric || metric.total === 0 || typeof metric.pct !== "number") return null;
  return metric.pct;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return normalize(a) === normalize(b);
}

/** Reads coverage for one source file from Jest's `coverage-summary.json`. */
export async function readCoverage(summaryPath: string, sourcePath: string): Promise<CoverageMetrics | undefined> {
  let summary: CoverageSummary;
  try {
    summary = JSON.parse(await readFile(summaryPath, "utf8")) as CoverageSummary;
  } catch {
    return undefined;
  }

  const key = Object.keys(summary).find((file) => file !== "total" && samePath(file, sourcePath));
  if (!key) return undefined;

  const entry = summary[key];
  return {
    lines: percent(entry.lines),
    statements: percent(entry.statements),
    functions: percent(entry.functions),
    branches: percent(entry.branches),
  };
}
