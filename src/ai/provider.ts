import type { z } from "zod";
import { UserError } from "../errors.js";

export class ProviderError extends UserError {}

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxOutputTokens: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StructuredResponse<T> {
  data: T;
  model: string;
  usage: TokenUsage;
}

/** A model that returns JSON validated against a Zod schema. Implement this to add a provider. */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>>;
}
