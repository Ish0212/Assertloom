import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ProviderError, type LLMProvider, type StructuredRequest, type StructuredResponse } from "./provider.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  private readonly client: OpenAI;

  constructor(
    readonly model: string = DEFAULT_OPENAI_MODEL,
    apiKey: string | undefined = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) {
      throw new ProviderError(
        "OPENAI_API_KEY is not set. Create a key at https://platform.openai.com/api-keys and set it as an environment variable.",
      );
    }
    // Retries would bill a request the spending limit only approved once.
    this.client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 0 });
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    let response;
    try {
      response = await this.client.responses.parse({
        model: this.model,
        input: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        text: { format: zodTextFormat(request.schema, request.schemaName) },
        max_output_tokens: request.maxOutputTokens,
        store: false,
      });
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        throw new ProviderError(`OpenAI request failed (${error.status ?? "no status"}): ${error.message}`);
      }
      throw new ProviderError(`OpenAI request failed: ${(error as Error).message}`);
    }

    if (response.status === "incomplete") {
      throw new ProviderError(`OpenAI response was cut off (${response.incomplete_details?.reason ?? "unknown reason"}).`);
    }
    if (response.output_parsed == null) {
      throw new ProviderError("OpenAI returned no structured output (the model may have refused the request).");
    }

    const parsed = request.schema.safeParse(response.output_parsed);
    if (!parsed.success) {
      throw new ProviderError(`OpenAI returned output that does not match the ${request.schemaName} schema: ${parsed.error.message}`);
    }

    return {
      data: parsed.data,
      model: response.model,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }
}
