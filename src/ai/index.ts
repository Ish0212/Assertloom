import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICompatibleProvider } from "./openaiCompatible.js";
import { ProviderError, type LLMProvider } from "./provider.js";

export * from "./provider.js";
export { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.js";
export { DEFAULT_OPENAI_MODEL, OpenAIProvider } from "./openai.js";
export { OpenAICompatibleProvider } from "./openaiCompatible.js";

export const PROVIDERS = ["openai", "anthropic", "openai-compatible"] as const;

export interface ProviderOptions {
  model?: string;
  /** Server URL for `openai-compatible`. */
  baseUrl?: string;
}

export function createProvider(name: string, options: ProviderOptions = {}): LLMProvider {
  const model = options.model ?? process.env.ASSERTLOOM_MODEL;
  switch (name) {
    case "openai":
      return new OpenAIProvider(model);
    case "anthropic":
      return new AnthropicProvider(model);
    case "openai-compatible":
      return new OpenAICompatibleProvider(model ?? "", options.baseUrl ?? process.env.ASSERTLOOM_BASE_URL ?? "");
    default:
      throw new ProviderError(`Unknown provider "${name}". Available: ${PROVIDERS.join(", ")}`);
  }
}
