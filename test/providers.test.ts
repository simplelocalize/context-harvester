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
  it("asks for structured output with refusal fallbacks and returns parsed descriptions", async () => {
    let params: Record<string, unknown> = {};
    const client = {
      beta: {
        messages: {
          parse: async (request: Record<string, unknown>) => {
            params = request;
            return { stop_reason: "end_turn", stop_details: null, parsed_output: { descriptions: [{ key: "checkout.pay", namespace: "web", context: "Pay button" }] } };
          }
        }
      }
    };

    const entries = await new AnthropicProvider(undefined, client as never).describe(keys);

    expect(entries.map((e) => e.context)).toEqual(["Pay button"]);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect((params.output_config as { effort: string }).effort).toBe("medium");
    expect(JSON.stringify(params.messages)).toContain("src/Pay.tsx");
  });

  it("fails the batch on refusal", async () => {
    const client = { beta: { messages: { parse: async () => ({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null }) } } };

    await expect(new AnthropicProvider(undefined, client as never).describe(keys)).rejects.toThrow("declined");
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
    expect(createProvider(undefined, undefined, { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }).name).toBe("anthropic");
    expect(createProvider(undefined, undefined, { OPENAI_API_KEY: "o" }).name).toBe("openai");
    expect(() => createProvider(undefined, undefined, {})).toThrow("No AI provider configured");
  });
});
