import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider, createProvider, OpenAICompatibleProvider, ProviderError } from "../src/ai/index.js";
import { estimateCost, priceFor } from "../src/ai/pricing.js";

const Schema = z.object({ answer: z.string(), score: z.number() });
const request = { system: "SYSTEM", prompt: "PROMPT", schema: Schema, schemaName: "result", maxOutputTokens: 500 };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("AnthropicProvider", () => {
  it("requests schema-constrained JSON and returns the parsed result with usage", async () => {
    const { calls, fetchImpl } = fakeFetch(200, {
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"answer":"yes","score":2}' }],
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    const provider = new AnthropicProvider(undefined, "test-key", fetchImpl);

    const result = await provider.generateStructured(request);

    expect(result).toEqual({ data: { answer: "yes", score: 2 }, model: "claude-haiku-5-5", usage: { inputTokens: 120, outputTokens: 30 } });
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].init.headers).toMatchObject({ "x-api-key": "test-key", "anthropic-version": "2023-06-01" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 500, system: "SYSTEM", messages: [{ role: "user", content: "PROMPT" }] });
    expect(body.output_config.format).toMatchObject({
      type: "json_schema",
      schema: { type: "object", required: ["answer", "score"], additionalProperties: false },
    });
  });

  it("turns API errors, truncation, and schema mismatches into ProviderErrors", async () => {
    const failing = [
      fakeFetch(400, { error: { type: "invalid_request_error", message: "bad model" } }),
      fakeFetch(200, { stop_reason: "max_tokens", content: [{ type: "text", text: '{"answer":' }] }),
      fakeFetch(200, { stop_reason: "end_turn", content: [{ type: "text", text: '{"answer":1}' }] }),
    ];
    const messages = await Promise.all(
      failing.map(({ fetchImpl }) => new AnthropicProvider("claude-sonnet-5-5", "k", fetchImpl).generateStructured(request).catch((e: Error) => e)),
    );

    for (const error of messages) expect(error).toBeInstanceOf(ProviderError);
    expect((messages[0] as Error).message).toBe("Anthropic request failed (400): bad model");
    expect((messages[1] as Error).message).toContain("cut off");
    expect((messages[2] as Error).message).toContain("does not match the result schema");
  });

  it("needs an API key", () => {
    expect(() => new AnthropicProvider(undefined, "")).toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});

describe("OpenAICompatibleProvider", () => {
  let server: http.Server;
  let baseURL: string;
  const received: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        received.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(data) });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "1",
            object: "chat.completion",
            created: 0,
            model: "qwen3-coder",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"answer":"ok","score":1}' } }],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("calls Chat Completions with a JSON-schema response format", async () => {
    const provider = new OpenAICompatibleProvider("qwen3-coder", baseURL, "");

    const result = await provider.generateStructured(request);

    expect(result).toEqual({ data: { answer: "ok", score: 1 }, model: "qwen3-coder", usage: { inputTokens: 50, outputTokens: 10 } });
    expect(received[0]).toMatchObject({
      path: "/v1/chat/completions",
      auth: "Bearer not-needed",
      model: "qwen3-coder",
      max_tokens: 500,
      messages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "PROMPT" },
      ],
      response_format: { type: "json_schema", json_schema: { name: "result", strict: true } },
    });
  });

  it("requires a model and a server URL", () => {
    expect(() => createProvider("openai-compatible", { baseUrl: baseURL, model: "" })).toThrow(/needs a model/);
    expect(() => new OpenAICompatibleProvider("m", "")).toThrow(/needs a server URL/);
  });
});

describe("Claude pricing", () => {
  it("prices Claude models and dated snapshots", () => {
    expect(priceFor("claude-sonnet-5-5")).toEqual({ input: 2, output: 10 });
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ input: 1, output: 5 });
    expect(estimateCost("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6);
  });
});
