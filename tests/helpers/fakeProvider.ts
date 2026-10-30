import type { LLMProvider, StructuredRequest, StructuredResponse } from "../../src/ai/provider.js";

type Responder = (request: StructuredRequest<unknown>) => unknown;

/** Returns canned responses and records every request, so tests never call a real model. */
export class FakeProvider implements LLMProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly requests: StructuredRequest<unknown>[] = [];
  private readonly respond: Responder;

  constructor(response: unknown | Responder) {
    this.respond = typeof response === "function" ? (response as Responder) : () => response;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    const data = request.schema.parse(this.respond(request as StructuredRequest<unknown>));
    return { data, model: this.model, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}
