import { formatSignature } from "../analyzer/format.js";
import type { Binding } from "../generator/importPlan.js";
import type { FileAnalysis } from "../types/index.js";

export const GENERATION_SYSTEM_PROMPT = `You are Assertloom, a tool that writes Jest unit tests for JavaScript and TypeScript code.

For each target function you are given, return test cases. Each case has a short name (the \`it\` title), a category, and a body: the statements that go inside the test callback.

Rules:
- Call target functions only through the binding names listed. They are already imported; Assertloom writes the imports, describe blocks, and it() wrappers.
- Do not write import or require statements, describe/it/test wrappers, or jest.mock calls.
- Assert the behavior of the source as written. Work out expected values by reading the code; never guess. If you cannot be sure of an exact value, assert something you can verify (type, length, ordering, a relationship between outputs).
- Tests must be deterministic: no network, file system, real timers, Date.now(), or Math.random().
- Cover each function with normal cases (typical input) and edge cases (empty values, zero, negative numbers, boundaries, unicode where relevant). Add error cases only when the source throws or rejects, using toThrow / rejects.toThrow and matching the message when the source shows it.
- Write 3 to 6 cases per function. Each case should check one behavior with a few focused expect() calls.
- For async functions, use await, or await expect(...).rejects for rejections.
- Use toBeCloseTo for floating-point results and toEqual for objects and arrays.
- For generators, collect values with Array.from() or spread syntax.
- In TypeScript, arguments must match the declared parameter types. If an error case needs an invalid argument, cast it with \`as any\`.`;

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
