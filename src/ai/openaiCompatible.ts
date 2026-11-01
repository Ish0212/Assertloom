import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { ProviderError, type LLMProvider, type StructuredRequest, type StructuredResponse } from "./provider.js";

/**
 * Any server that speaks the OpenAI Chat Completions API with JSON-schema response formats:
 * Ollama, LM Studio, vLLM, llama.cpp, OpenRouter, and others.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name = "openai-compatible";
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    readonly baseURL: string,
    apiKey: string | undefined = process.env.ASSERTLOOM_API_KEY,
  ) {
    if (!model) throw new ProviderError("--provider openai-compatible needs a model: pass --model or set ASSERTLOOM_MODEL.");
    if (!baseURL) {
      throw new ProviderError("--provider openai-compatible needs a server URL: pass --base-url or set ASSERTLOOM_BASE_URL (for example http://localhost:11434/v1).");
    }
    // Local servers usually ignore the key, but the SDK requires one.
    this.client = new OpenAI({ apiKey: apiKey || "not-needed", baseURL, timeout: 300_000, maxRetries: 0 });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    let completion;
    try {
      completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        response_format: zodResponseFormat(request.schema, request.schemaName),
        max_tokens: request.maxOutputTokens,
      });
    } catch (error) {
      const status = error instanceof OpenAI.APIError ? ` (${error.status ?? "no status"})` : "";
      throw new ProviderError(`Request to ${this.baseURL} failed${status}: ${(error as Error).message}`);
    }

    const choice = completion.choices[0];
    if (choice?.finish_reason === "length") throw new ProviderError("The model's response was cut off (max_tokens).");
    let json: unknown;
    try {
      json = JSON.parse(choice?.message.content ?? "");
    } catch {
      throw new ProviderError(`${this.model} returned no JSON output. Check that the server supports JSON-schema response formats.`);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`${this.model} returned output that does not match the ${request.schemaName} schema: ${parsed.error.message}`);
    }

    return {
      data: parsed.data,
      model: completion.model || this.model,
      usage: { inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 },
    };
  }
}
