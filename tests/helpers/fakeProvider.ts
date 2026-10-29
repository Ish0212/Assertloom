import type { LLMProvider, StructuredRequest, StructuredResponse } from "../../src/ai/provider.js";

/** Returns a canned response and records every request, so tests never call a real model. */
export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(private readonly response: unknown) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    return { data: request.schema.parse(this.response), model: this.model, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}
