export type TestFailureKind = "assertion" | "error" | "timeout";

export interface TestOutcome {
  /** describe() titles joined with " › ". */
  suite: string;
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
  failure?: { kind: TestFailureKind; message: string };
}

/** The run itself failed, as opposed to individual tests failing. */
export interface InfraFailure {
  kind: "timeout" | "crash" | "module-not-found" | "transform" | "suite-error";
  message: string;
}

/** Percentages (0–100), or null when the file has nothing of that kind to cover. */
export interface CoverageMetrics {
  lines: number | null;
  statements: number | null;
  functions: number | null;
  branches: number | null;
}

export interface RunResult {
  status: "passed" | "failed" | "error";
  tests: TestOutcome[];
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  infra?: InfraFailure;
  coverage?: CoverageMetrics;
  durationMs: number;
  /** Where the Jest binary and configuration came from. */
  setup: string;
}
