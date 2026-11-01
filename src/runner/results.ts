import type { InfraFailure, TestFailureKind, TestOutcome } from "./types.js";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_FRAMES = 3;

interface JestAssertionResult {
  ancestorTitles: string[];
  title: string;
  status: string;
  duration?: number | null;
  failureMessages?: string[];
}

interface JestTestFileResult {
  status: string;
  message?: string;
  assertionResults: JestAssertionResult[];
  testExecError?: { message?: string } | null;
}

export interface JestJsonReport {
  testResults: JestTestFileResult[];
  runExecError?: { message?: string } | null;
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Removes colors, keeps the first few stack frames, and caps the length. */
export function cleanMessage(text: string): string {
  let frames = 0;
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .filter((line) => !line.includes("node_modules"))
    .filter((line) => !/^\s+at /.test(line) || ++frames <= MAX_STACK_FRAMES);
  const cleaned = lines.join("\n").trim();
  return cleaned.length > MAX_MESSAGE_LENGTH ? `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}\n…(truncated)` : cleaned;
}

export function classifyTestFailure(message: string): TestFailureKind {
  const text = stripAnsi(message);
  if (/Exceeded timeout of \d+ ?ms|Test timed out in \d+ ?ms/.test(text)) return "timeout";
  if (/expect\(.*?\)\.|Expected:|Received:|Expected value|Received value|^AssertionError:/m.test(text)) return "assertion";
  return "error";
}

export function classifySuiteFailure(message: string): InfraFailure {
  const text = cleanMessage(message);
  if (/Cannot find module|Failed to (?:resolve|load) (?:import|url)|Cannot find package/.test(text)) return { kind: "module-not-found", message: text };
  if (/Jest encountered an unexpected token|SyntaxError|Must use import to load ES Module|Cannot use import statement/.test(text)) {
    return { kind: "transform", message: text };
  }
  return { kind: "suite-error", message: text };
}

export function parseJestReport(report: JestJsonReport): { tests: TestOutcome[]; infra?: InfraFailure } {
  if (report.runExecError?.message) return { tests: [], infra: classifySuiteFailure(report.runExecError.message) };

  const tests: TestOutcome[] = [];
  for (const file of report.testResults) {
    const suiteError = file.testExecError?.message ?? (file.assertionResults.length === 0 && file.status === "failed" ? file.message : undefined);
    if (suiteError) return { tests, infra: classifySuiteFailure(suiteError) };

    for (const result of file.assertionResults) {
      const status = result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "skipped";
      const outcome: TestOutcome = {
        suite: result.ancestorTitles.join(" › "),
        name: result.title,
        status,
        durationMs: result.duration ?? undefined,
      };
      if (status === "failed") {
        const message = (result.failureMessages ?? []).join("\n");
        outcome.failure = { kind: classifyTestFailure(message), message: cleanMessage(message) };
      }
      tests.push(outcome);
    }
  }

  return { tests };
}
