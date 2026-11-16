import type { ContextEntry, DescriptionProvider, KeyToDescribe } from "../types.js";
import { buildUserMessage, type RawDescription, SYSTEM_PROMPT, toEntries } from "./prompt.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["descriptions"],
  properties: {
    descriptions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "namespace", "context"],
        properties: {
          key: { type: "string" },
          namespace: { type: "string" },
          context: { type: "string" }
        }
      }
    }
  }
};

export interface OpenAiProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class OpenAiProvider implements DescriptionProvider {
  readonly name = "openai";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async describe(keys: KeyToDescribe[]): Promise<ContextEntry[]> {
    const baseUrl = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const response = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.model ?? DEFAULT_OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(keys) }
        ],
        response_format: { type: "json_schema", json_schema: { name: "descriptions", strict: true, schema: RESPONSE_SCHEMA } }
      })
    });
    if (!response.ok) {
      throw new Error(`OpenAI request failed with HTTP ${response.status}: ${await response.text().catch(() => "")}`);
    }
    const body = await response.json() as { choices?: { message?: { content?: string; refusal?: string } }[] };
    const message = body.choices?.[0]?.message;
    if (message?.refusal) {
      throw new Error(`The model declined to describe this batch: ${message.refusal}`);
    }
    let parsed: { descriptions?: RawDescription[] };
    try {
      parsed = JSON.parse(message?.content ?? "");
    } catch {
      throw new Error("The model returned a response that doesn't match the expected format");
    }
    return toEntries(keys, parsed.descriptions ?? []);
  }
}
