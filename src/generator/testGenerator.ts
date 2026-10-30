import { readFile } from "node:fs/promises";
import path from "node:path";
import { GENERATION_SYSTEM_PROMPT, buildGenerationPrompt } from "../ai/prompts.js";
import type { LLMProvider, TokenUsage } from "../ai/provider.js";
import { redactSecrets } from "../ai/redact.js";
import { analyzeSource } from "../analyzer/index.js";
import { UserError } from "../errors.js";
import type { FileAnalysis, FunctionInfo, SourceFile } from "../types/index.js";
import { planImports } from "./importPlan.js";
import { GenerationSchema } from "./schema.js";
import { previewPathFor, renderTestFile } from "./testWriter.js";
import { validateGeneration, type RejectedCase, type ValidatedSuite } from "./validate.js";

export class GenerationError extends UserError {}

const MAX_SOURCE_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 32_000;

/** Built-ins that are deterministic and side-effect free, so tests don't need to mock them. */
const PURE_BUILTINS = new Set(["assert", "buffer", "path", "path/posix", "path/win32", "querystring", "string_decoder", "url", "util"]);

export interface SkippedFunction {
  fn: FunctionInfo;
  reason: string;
}

export interface GenerationResult {
  analysis: FileAnalysis;
  testPath: string;
  content: string;
  importStatements: string[];
  suites: ValidatedSuite[];
  /** The source as sent to the model, with secrets redacted. */
  promptSource: string;
  skipped: SkippedFunction[];
  rejected: RejectedCase[];
  model: string;
  usage: TokenUsage;
  redactions: number;
}

/** Exported functions Week 3 can test without mocks, and the ones it has to skip. */
export function selectTestable(analysis: FileAnalysis): { testable: FunctionInfo[]; skipped: SkippedFunction[] } {
  const testable: FunctionInfo[] = [];
  const skipped: SkippedFunction[] = [];

  for (const fn of analysis.functions) {
    if (!fn.exported) continue;
    const impure = fn.dependencies.filter((dep) => !PURE_BUILTINS.has(dep.replace(/^node:/, "")));
    if (impure.length) {
      skipped.push({ fn, reason: `uses ${impure.join(", ")} (needs mocking)` });
    } else {
      testable.push(fn);
    }
  }

  return { testable, skipped };
}

export async function generateTests(options: {
  source: SourceFile;
  provider: LLMProvider;
  testPath?: string;
}): Promise<GenerationResult> {
  const { source, provider } = options;
  const testPath = options.testPath ?? previewPathFor(source.absolutePath);
  const code = await readFile(source.absolutePath, "utf8");
  const analysis = analyzeSource(code, source);
  const { testable, skipped } = selectTestable(analysis);

  if (testable.length === 0) {
    const detail = skipped.length ? ` Skipped: ${skipped.map((s) => `${s.fn.name} ${s.reason}`).join("; ")}.` : "";
    throw new GenerationError(`No testable exported functions in ${analysis.file}.${detail}`);
  }
  if (code.length > MAX_SOURCE_CHARS) {
    throw new GenerationError(`${analysis.file} is ${code.length} characters; the limit for sending to a model is ${MAX_SOURCE_CHARS}.`);
  }

  const plan = planImports(analysis, testable, source.absolutePath, testPath);
  const redacted = redactSecrets(code);

  const response = await provider.generateStructured({
    system: GENERATION_SYSTEM_PROMPT,
    prompt: buildGenerationPrompt({ analysis, code: redacted.code, bindings: plan.bindings, testFileName: path.basename(testPath) }),
    schema: GenerationSchema,
    schemaName: "assertloom_tests",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  const { suites, rejected } = validateGeneration(response.data, plan.bindings, source.extension);
  if (suites.length === 0) {
    throw new GenerationError(`The model returned no usable test cases (${rejected.length} rejected).`);
  }

  const content = renderTestFile({
    sourceFile: analysis.file,
    importStatements: plan.statements,
    suites,
    extension: source.extension,
  });

  return {
    analysis,
    testPath,
    content,
    importStatements: plan.statements,
    suites,
    promptSource: redacted.code,
    skipped,
    rejected,
    model: response.model,
    usage: response.usage,
    redactions: redacted.redactions,
  };
}
