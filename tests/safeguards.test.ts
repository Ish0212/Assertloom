import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Budget, estimateCost, formatUsd, priceFor, promptTokens, UNPRICED_TOKEN_LIMIT } from "../src/ai/pricing.js";
import { validateSourceFile } from "../src/cli/validateFile.js";
import { generateTests } from "../src/generator/index.js";
import { classifyTestFailure } from "../src/repair/index.js";
import { NETWORK_BLOCKED_MESSAGE, runJest } from "../src/runner/index.js";
import { FakeProvider } from "./helpers/fakeProvider.js";

const root = path.resolve(import.meta.dirname, "..");

describe("pricing", () => {
  it("prices known models and dated snapshots", () => {
    expect(priceFor("gpt-5.4-mini")).toEqual({ input: 0.75, output: 4.5 });
    expect(priceFor("gpt-5.4-mini-2026-03-17")).toEqual({ input: 0.75, output: 4.5 });
    expect(priceFor("my-local-model")).toBeUndefined();
  });

  it("estimates cost per million tokens", () => {
    expect(estimateCost("gpt-5.4-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(5.25);
    expect(estimateCost("unknown", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.00123)).toBe("$0.0012");
    expect(promptTokens("abc", "def")).toBe(2);
  });
});

describe("Budget", () => {
  it("refuses a call whose worst case would pass the limit", () => {
    const budget = new Budget("gpt-5.4-mini", 0.1);
    expect(budget.allows({ inputTokens: 10_000, outputTokens: 16_000 })).toBe(true);
    budget.add({ inputTokens: 10_000, outputTokens: 10_000 });
    expect(budget.spentUsd).toBeCloseTo(0.0525);
    expect(budget.allows({ inputTokens: 10_000, outputTokens: 16_000 })).toBe(false);
  });

  it("caps tokens for models without a known price", () => {
    const budget = new Budget("my-local-model", 1);
    expect(budget.spentUsd).toBeUndefined();
    expect(budget.allows({ inputTokens: UNPRICED_TOKEN_LIMIT, outputTokens: 0 })).toBe(true);
    expect(budget.allows({ inputTokens: UNPRICED_TOKEN_LIMIT, outputTokens: 1 })).toBe(false);
  });

  it("stops generation before an over-budget model call", async () => {
    const provider = new FakeProvider({ suites: [] });
    const source = await validateSourceFile(path.join(root, "examples", "math.ts"));
    const budget = new Budget(provider.model, 1);
    budget.add({ inputTokens: UNPRICED_TOKEN_LIMIT, outputTokens: 0 });

    await expect(generateTests({ source, provider, budget })).rejects.toThrow(/spending limit/);
    expect(provider.requests).toHaveLength(0);
  });
});

describe("network guard (real Jest)", { timeout: 120_000 }, () => {
  let dir: string;
  let sourcePath: string;
  let testPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "assertloom-network-"));
    sourcePath = path.join(dir, "client.cjs");
    testPath = path.join(dir, "client.test.cjs");
    await writeFile(sourcePath, "exports.fetchText = async (url) => (await fetch(url)).text();\n");
    await writeFile(
      testPath,
      `const http = require("node:http");
const dns = require("node:dns");
const { execFile } = require("node:child_process");
const { fetchText } = require("./client.cjs");

let server;
let url;
beforeAll(async () => {
  server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + server.address().port + "/";
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

test("fetch", async () => {
  expect(await fetchText(url)).toBe("ok");
});

test("http", async () => {
  await new Promise((resolve, reject) => http.get(url, (res) => res.resume().on("end", resolve)).on("error", reject));
});

test("dns", async () => {
  // Offline machines can fail the real lookup; only the guard's error counts.
  await dns.promises.lookup("example.com").catch((error) => {
    if (error.code === "ASSERTLOOM_NETWORK_BLOCKED") throw error;
  });
});

test("dns resolver", async () => {
  for (const query of [() => new dns.promises.Resolver().resolve4("example.com"), () => dns.promises.reverse("8.8.8.8")]) {
    await query().catch((error) => {
      if (error.code === "ASSERTLOOM_NETWORK_BLOCKED") throw error;
    });
  }
});

test("child process", async () => {
  const script = "fetch(" + JSON.stringify(url) + ").then(() => process.exit(0), () => process.exit(3))";
  await new Promise((resolve, reject) => execFile(process.execPath, ["-e", script], (error) => (error ? reject(new Error("child exited with " + error.code)) : resolve())));
});
`,
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("blocks connections from tests and their subprocesses by default", async () => {
    const run = await runJest({ testPath, sourcePath });

    expect(run.setup).toContain("network blocked");
    expect(run.infra).toBeUndefined();
    expect(run).toMatchObject({ status: "failed", passed: 0, failed: 5 });
    for (const name of ["fetch", "http", "dns", "dns resolver"]) {
      const test = run.tests.find((t) => t.name === name);
      expect(test?.failure?.message).toContain(NETWORK_BLOCKED_MESSAGE);
      expect(classifyTestFailure(test!)).toEqual({ category: "mock", repairable: false });
    }
    expect(run.tests.find((t) => t.name === "child process")?.failure?.message).toContain("child exited with 3");
  });

  it("allows connections with allowNetwork", async () => {
    const run = await runJest({ testPath, sourcePath, allowNetwork: true });

    expect(run.setup).toContain("network allowed");
    expect(run.infra).toBeUndefined();
    expect(run).toMatchObject({ status: "passed", passed: 5 });
  });
});
