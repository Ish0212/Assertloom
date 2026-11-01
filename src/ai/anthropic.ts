import { zodTextFormat } from "openai/helpers/zod";
import { ProviderError, type LLMProvider, type StructuredRequest, type StructuredResponse } from "./provider.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 120_000;

interface MessagesResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** Claude through the Messages API, with JSON output constrained to the request schema. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;

  constructor(
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
    apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) {
      throw new ProviderError(
        "ANTHROPIC_API_KEY is not set. Create a key at https://platform.claude.com/settings/keys and set it as an environment variable.",
      );
    }
    this.apiKey = apiKey;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    // The strict schema OpenAI accepts (every property required, no additional properties) also suits Claude.
    const { schema } = zodTextFormat(request.schema, request.schemaName);

    let response: Response;
    try {
      response = await this.fetchImpl(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
          output_config: { format: { type: "json_schema", schema } },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ProviderError(`Anthropic request failed: ${(error as Error).message}`);
    }

    const body = (await response.json().catch(() => ({}))) as MessagesResponse;
    if (!response.ok) {
      throw new ProviderError(`Anthropic request failed (${response.status}): ${body.error?.message ?? response.statusText}`);
    }
    if (body.stop_reason === "max_tokens") throw new ProviderError("Anthropic response was cut off (max_tokens).");
    if (body.stop_reason === "refusal") throw new ProviderError("Claude declined the request.");

    const text = body.content?.find((block) => block.type === "text")?.text;
    let json: unknown;
    try {
      json = JSON.parse(text ?? "");
    } catch {
      throw new ProviderError("Anthropic returned no structured output.");
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(`Anthropic returned output that does not match the ${request.schemaName} schema: ${parsed.error.message}`);
    }

    return {
      data: parsed.data,
      model: body.model ?? this.model,
      usage: { inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 },
    };
  }
}
