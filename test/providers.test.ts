import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/ai/anthropic.js";
import { createProvider } from "../src/ai/index.js";
import { OpenAiProvider } from "../src/ai/openai.js";
import { MAX_CONTEXT_LENGTH, toEntries } from "../src/ai/prompt.js";
import type { KeyToDescribe } from "../src/types.js";
import { mockFetch } from "./helpers.js";

const keys: KeyToDescribe[] = [
  { key: "checkout.pay", namespace: "web", text: "Pay {amount}", occurrences: [{ file: "src/Pay.tsx", line: 4, code: "<button>{t('checkout.pay')}</button>" }] }
];

describe("toEntries", () => {
  it("keeps requested keys only, drops empty notes and enforces the length limit", () => {
    const entries = toEntries(keys, [
      { key: "checkout.pay", namespace: "web", context: `  Primary   button\n${"x".repeat(600)}` },
      { key: "checkout.pay", namespace: "web", context: "duplicate" },
      { key: "invented", namespace: "", context: "Not asked for" },
      { key: "checkout.pay", namespace: "", context: "Wrong namespace" }
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0].context.startsWith("Primary button x")).toBe(true);
    expect(entries[0].context.length).toBe(MAX_CONTEXT_LENGTH);
    expect(entries[0].references).toEqual(["src/Pay.tsx:4"]);
  });
});

describe("AnthropicProvider", () => {
  const answer = (descriptions: unknown) => ({
    body: {
      stop_reason: "end_turn",
      stop_details: null,
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify({ descriptions }) }]
    }
  });

  it("asks for structured output with refusal fallbacks and returns parsed descriptions", async () => {
    const { fetchImpl, requests } = mockFetch(() => answer([{ key: "checkout.pay", namespace: "web", context: "Pay button" }]));

    const entries = await new AnthropicProvider({ apiKey: "sk-ant-test", fetch: fetchImpl }).describe(keys);

    expect(entries.map((e) => e.context)).toEqual(["Pay button"]);
    expect(requests[0].url.toString()).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0].headers).toMatchObject({
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2026-10-21",
      "anthropic-beta": "server-side-fallback-2026-07-01"
    });
    const body = requests[0].body as Record<string, any>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.effort).toBe("medium");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(body.messages)).toContain("src/Pay.tsx");
  });

  it("fails the batch on refusal", async () => {
    const { fetchImpl } = mockFetch(() => ({ body: { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] } }));

    await expect(new AnthropicProvider({ apiKey: "k", fetch: fetchImpl }).describe(keys)).rejects.toThrow("declined to describe this batch (cyber)");
  });

  it("retries rate limited requests", async () => {
    let calls = 0;
    const { fetchImpl } = mockFetch(() => ++calls === 1
      ? { status: 429, body: { error: { type: "rate_limit_error" } } }
      : answer([{ key: "checkout.pay", namespace: "web", context: "Pay button" }]));

    const entries = await new AnthropicProvider({ apiKey: "k", fetch: fetchImpl, retryDelayMs: 0 }).describe(keys);

    expect(calls).toBe(2);
    expect(entries).toHaveLength(1);
  });
});

describe("OpenAiProvider", () => {
  it("requests a strict JSON schema and parses the answer", async () => {
    const { fetchImpl, requests } = mockFetch(() => ({
      body: { choices: [{ message: { content: JSON.stringify({ descriptions: [{ key: "checkout.pay", namespace: "web", context: "Pay button" }] }) } }] }
    }));

    const entries = await new OpenAiProvider({ apiKey: "sk-test", fetch: fetchImpl }).describe(keys);

    expect(entries.map((e) => e.context)).toEqual(["Pay button"]);
    expect(requests[0].url.toString()).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].headers.Authorization).toBe("Bearer sk-test");
    expect((requests[0].body as { response_format: { type: string } }).response_format.type).toBe("json_schema");
  });
});

describe("createProvider", () => {
  it("picks the provider from the available key", () => {
    expect(createProvider(undefined, { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }).name).toBe("anthropic");
    expect(createProvider(undefined, { OPENAI_API_KEY: "o" }).name).toBe("openai");
    expect(() => createProvider(undefined, {})).toThrow("No AI provider configured");
  });
});
