import type { InfraFailure, TestOutcome } from "../runner/index.js";

export type FailureCategory = "assertion" | "runtime" | "timeout" | "mock" | "import" | "configuration";

export interface FailureClassification {
  category: FailureCategory;
  /** Whether rewriting the test body can plausibly fix it. */
  repairable: boolean;
}

/**
 * Errors from real sockets: the code reached a dependency that is not mocked. Problems with
 * Assertloom's mocks themselves (unconfigured return values, wrong call arguments) are test bugs.
 */
const MOCK_SIGNALS = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|getaddrinfo|socket hang up/;

/** Sorts a failing test into the four repair categories (plus runtime errors and timeouts). */
export function classifyTestFailure(outcome: TestOutcome): FailureClassification {
  const failure = outcome.failure;
  if (!failure) return { category: "runtime", repairable: true };
  if (MOCK_SIGNALS.test(failure.message)) return { category: "mock", repairable: false };
  if (/Cannot find module/.test(failure.message)) return { category: "import", repairable: false };
  if (failure.kind === "assertion") return { category: "assertion", repairable: true };
  if (failure.kind === "timeout") return { category: "timeout", repairable: true };
  return { category: "runtime", repairable: true };
}

/** A failure that stopped the whole file from running. No test-body edit can fix these. */
export function classifyInfraFailure(infra: InfraFailure): FailureClassification {
  return { category: infra.kind === "module-not-found" ? "import" : "configuration", repairable: false };
}
