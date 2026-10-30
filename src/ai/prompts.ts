import { formatSignature } from "../analyzer/format.js";
import type { Binding } from "../generator/importPlan.js";
import type { FileAnalysis } from "../types/index.js";

const BODY_RULES = `- Call target functions only through the binding names listed. They are already imported; Assertloom writes the imports, describe blocks, and it() wrappers.
- Do not write import or require statements, describe/it/test wrappers, or jest.mock calls.
- Assert the behavior of the source as written. Work out expected values by reading the code; never guess. If you cannot be sure of an exact value, assert something you can verify (type, length, ordering, a relationship between outputs).
- Tests must be deterministic: no network, file system, real timers, Date.now(), or Math.random().
- For async functions, use await, or await expect(...).rejects for rejections.
- Use toBeCloseTo for floating-point results and toEqual for objects and arrays.
- For generators, collect values with Array.from() or spread syntax.
- In TypeScript, arguments must match the declared parameter types. If an error case needs an invalid argument, cast it with \`as any\`.`;

export const GENERATION_SYSTEM_PROMPT = `You are Assertloom, a tool that writes Jest unit tests for JavaScript and TypeScript code.

For each target function you are given, return test cases. Each case has a short name (the \`it\` title), a category, and a body: the statements that go inside the test callback.

Rules:
${BODY_RULES}
- Cover each function with normal cases (typical input) and edge cases (empty values, zero, negative numbers, boundaries, unicode where relevant). Add error cases only when the source throws or rejects, using toThrow / rejects.toThrow and matching the message when the source shows it.
- Write 3 to 6 cases per function. Each case should check one behavior with a few focused expect() calls.`;

export const REPAIR_SYSTEM_PROMPT = `You are Assertloom, a tool that repairs failing Jest tests it generated. You cannot change the source code; only the tests.

For each failing test you are given, return exactly one repair with one of these actions:
- fix: the test is wrong (a miscalculated expected value, a wrong assumption about behavior, a missing await). Return a corrected body that keeps testing the same behavior, with expected values derived from the source.
- skip: the test's expectation matches what the function clearly intends (its name, documentation, or error messages), but the source does something else. This is likely a bug in the source; do not rewrite the test to match buggy behavior. Explain the suspected bug in the reason.
- remove: the test cannot be made deterministic or tests something outside the function.

Prefer fix. Use the failure message: "Expected"/"Received" lines show what the code actually returned.

Body rules for fix:
${BODY_RULES}`;

export interface GenerationPromptInput {
  analysis: FileAnalysis;
  code: string;
  bindings: Binding[];
  testFileName: string;
}

export function buildGenerationPrompt({ analysis, code, bindings, testFileName }: GenerationPromptInput): string {
  const language = analysis.language === "typescript" ? "typescript" : "javascript";

  const targets = bindings
    .map(({ binding, fn }) => {
      const notes = [
        binding !== fn.name ? `declared as \`${fn.name}\` in the source` : "",
        fn.throws ? "throws in its own body" : "",
        `defined at line ${fn.line}`,
      ].filter(Boolean);
      return `- \`${binding}\`: \`${formatSignature(fn, binding)}\` (${notes.join("; ")})`;
    })
    .join("\n");

  return `Write Jest tests for the target functions in \`${analysis.file}\`.

Test file: \`${testFileName}\` (${language}, Jest globals available)

Target functions (use these binding names exactly):
${targets}

Source of \`${analysis.file}\`:
\`\`\`${language}
${code}
\`\`\``;
}

export const MAX_FAILURE_MESSAGE_CHARS = 1200;

export interface RepairTarget {
  binding: Binding;
  testName: string;
  body: string;
  failureCategory: string;
  message: string;
}

export function buildRepairPrompt(input: { analysis: FileAnalysis; code: string; targets: RepairTarget[]; attempt: number }): string {
  const language = input.analysis.language === "typescript" ? "typescript" : "javascript";

  const failures = input.targets
    .map((t, i) => {
      const message =
        t.message.length > MAX_FAILURE_MESSAGE_CHARS ? `${t.message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}\n…(truncated)` : t.message;
      return `### ${i + 1}. \`${t.binding.binding}\` › ${JSON.stringify(t.testName)}
Signature: \`${formatSignature(t.binding.fn, t.binding.binding)}\`
Failure (${t.failureCategory}):
\`\`\`
${message}
\`\`\`
Current body:
\`\`\`${language}
${t.body}
\`\`\``;
    })
    .join("\n\n");

  return `Repair attempt ${input.attempt}: ${input.targets.length} generated test${input.targets.length === 1 ? "" : "s"} in the tests for \`${input.analysis.file}\` failed.

${failures}

Source of \`${input.analysis.file}\` (read-only):
\`\`\`${language}
${input.code}
\`\`\``;
}
