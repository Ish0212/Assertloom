import { readFile } from "node:fs/promises";
import path from "node:path";
import { GENERATION_SYSTEM_PROMPT, buildGenerationPrompt } from "../ai/prompts.js";
import { formatUsd, promptTokens, type Budget } from "../ai/pricing.js";
import type { LLMProvider, TokenUsage } from "../ai/provider.js";
import { redactSecrets } from "../ai/redact.js";
import { analyzeSource } from "../analyzer/index.js";
import { UserError } from "../errors.js";
import type { FileAnalysis, SourceFile } from "../types/index.js";
import { planImports } from "./importPlan.js";
import { planMocks, type MockPlan } from "./mocks.js";
import { GenerationSchema } from "./schema.js";
import { previewPathFor, renderTestFile } from "./testWriter.js";
import { validateGeneration, type RejectedCase, type ValidatedSuite } from "./validate.js";

export class GenerationError extends UserError {}

/** The next model call could exceed the spending limit, so it was not made. */
export class BudgetExceededError extends GenerationError {}

const MAX_SOURCE_CHARS = 60_000;
const MAX_OUTPUT_TOKENS = 32_000;

export interface GenerationResult {
  analysis: FileAnalysis;
  testPath: string;
  content: string;
  /** Mocks, imports, and setup that precede the describe blocks. */
  preamble: string[];
  mocks: MockPlan;
  suites: ValidatedSuite[];
  /** The source as sent to the model, with secrets redacted. */
  promptSource: string;
  rejected: RejectedCase[];
  model: string;
  usage: TokenUsage;
  redactions: number;
}

export async function generateTests(options: {
  source: SourceFile;
  provider: LLMProvider;
  testPath?: string;
  /** Modules to mock even if Assertloom would keep them real. */
  mock?: string[];
  /** Modules to keep real even if Assertloom would mock them. */
  keepReal?: string[];
  budget?: Budget;
}): Promise<GenerationResult> {
  const { source, provider } = options;
  const testPath = options.testPath ?? previewPathFor(source.absolutePath);
  const code = await readFile(source.absolutePath, "utf8");
  const analysis = analyzeSource(code, source);
  const targets = analysis.functions.filter((fn) => fn.exported);

  if (targets.length === 0) throw new GenerationError(`No exported functions in ${analysis.file}.`);
  if (code.length > MAX_SOURCE_CHARS) {
    throw new GenerationError(`${analysis.file} is ${code.length} characters; the limit for sending to a model is ${MAX_SOURCE_CHARS}.`);
  }

  const plan = planImports(analysis, targets, source.absolutePath, testPath);
  const mocks = await planMocks({
    analysis,
    sourcePath: source.absolutePath,
    testPath,
    extension: source.extension,
    reserved: plan.bindings.map((b) => b.binding),
    mock: options.mock,
    keepReal: options.keepReal,
  });
  const redacted = redactSecrets(code);
  const prompt = buildGenerationPrompt({
    analysis,
    code: redacted.code,
    bindings: plan.bindings,
    testFileName: path.basename(testPath),
    mockSummary: mocks.summary,
  });

  const { budget } = options;
  if (budget && !budget.allows({ inputTokens: promptTokens(GENERATION_SYSTEM_PROMPT, prompt), outputTokens: MAX_OUTPUT_TOKENS })) {
    throw new BudgetExceededError(
      budget.priced
        ? `Generating tests for ${analysis.file} could exceed the spending limit of ${formatUsd(budget.maxUsd)}; raise it with --max-cost.`
        : `Generating tests for ${analysis.file} could exceed the spending limit of ${budget.describeLimit()}.`,
    );
  }

  const response = await provider.generateStructured({
    system: GENERATION_SYSTEM_PROMPT,
    prompt,
    schema: GenerationSchema,
    schemaName: "assertloom_tests",
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  budget?.add(response.usage);

  const { suites, rejected } = validateGeneration(response.data, plan.bindings, source.extension);
  if (suites.length === 0) {
    throw new GenerationError(`The model returned no usable test cases (${rejected.length} rejected).`);
  }

  const preamble = [...mocks.imports, ...plan.statements];
  if (mocks.setup.length) preamble.push("", mocks.setup.join("\n\n"));

  const content = renderTestFile({ sourceFile: analysis.file, preamble, suites, extension: source.extension });

  return {
    analysis,
    testPath,
    content,
    preamble,
    mocks,
    suites,
    promptSource: redacted.code,
    rejected,
    model: response.model,
    usage: response.usage,
    redactions: redacted.redactions,
  };
}
