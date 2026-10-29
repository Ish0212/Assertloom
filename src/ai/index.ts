import { OpenAIProvider } from "./openai.js";
import { ProviderError, type LLMProvider } from "./provider.js";

export * from "./provider.js";
export { DEFAULT_OPENAI_MODEL, OpenAIProvider } from "./openai.js";

export const PROVIDERS = ["openai"] as const;

export function createProvider(name: string, model?: string): LLMProvider {
  switch (name) {
    case "openai":
      return new OpenAIProvider(model ?? process.env.ASSERTLOOM_MODEL);
    default:
      throw new ProviderError(`Unknown provider "${name}". Available: ${PROVIDERS.join(", ")}`);
  }
}
