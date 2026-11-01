import type { TokenUsage } from "./provider.js";

/**
 * Standard prices in USD per 1M tokens, checked on 2026-10-31 at https://platform.openai.com/docs/pricing and
 * https://platform.claude.com/docs/en/about-claude/pricing. Claude Haiku 5.5 is priced for prompts up to 100K tokens.
 */
export const PRICES_CHECKED = "2026-10-31";
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/** Prices for a model name, including dated snapshots such as `gpt-5.4-mini-2026-03-17` or `claude-haiku-4-5-20251001`. */
export function priceFor(model: string): { input: number; output: number } | undefined {
  if (PRICES[model]) return PRICES[model];
  const snapshot = /^(.*)-(?:\d{4}-\d{2}-\d{2}|\d{8})$/.exec(model);
  return snapshot ? PRICES[snapshot[1]] : undefined;
}

export function estimateCost(model: string, usage: TokenUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

export function formatUsd(amount: number): string {
  return amount >= 0.01 ? `$${amount.toFixed(2)}` : `$${amount.toFixed(4)}`;
}

/** Without known prices, spending is capped by tokens instead. */
export const UNPRICED_TOKEN_LIMIT = 500_000;

/**
 * A hard spending limit for one command. Each model call is checked against its worst case
 * (full prompt plus the maximum output) before it is made. Share one instance to share the limit
 * across several files.
 */
export class Budget {
  readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    readonly model: string,
    readonly maxUsd: number,
    /** Token cap used when the model has no known price. */
    readonly maxTokens: number = UNPRICED_TOKEN_LIMIT,
  ) {}

  get priced(): boolean {
    return priceFor(this.model) !== undefined;
  }

  get spentUsd(): number | undefined {
    return estimateCost(this.model, this.usage);
  }

  /** The limit that applies to this model, for messages. */
  describeLimit(): string {
    return this.priced ? formatUsd(this.maxUsd) : `${this.maxTokens.toLocaleString("en-US")} tokens (no known price for ${this.model})`;
  }

  allows(worstCase: TokenUsage): boolean {
    const projected = { inputTokens: this.usage.inputTokens + worstCase.inputTokens, outputTokens: this.usage.outputTokens + worstCase.outputTokens };
    const cost = estimateCost(this.model, projected);
    if (cost === undefined) return projected.inputTokens + projected.outputTokens <= this.maxTokens;
    return cost <= this.maxUsd;
  }

  add(usage: TokenUsage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
  }
}

/** Rough upper bound on tokens for a prompt: about 3 characters per token for code. */
export function promptTokens(...parts: string[]): number {
  return Math.ceil(parts.reduce((n, p) => n + p.length, 0) / 3);
}
