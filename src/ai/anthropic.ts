import type { ContextEntry, DescriptionProvider, KeyToDescribe } from "../types.js";
import { postJson, type PostJsonOptions } from "./http.js";
import { buildUserMessage, parseDescriptions, RESPONSE_SCHEMA, SYSTEM_PROMPT, toEntries } from "./prompt.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export interface AnthropicProviderOptions extends PostJsonOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  stop_details?: { category?: string | null } | null;
}

/** Calls the Claude Messages API directly with fetch, so the package has no runtime dependencies. */
export class AnthropicProvider implements DescriptionProvider {
  readonly name = "anthropic";

  constructor(private readonly options: AnthropicProviderOptions) {
  }

  async describe(keys: KeyToDescribe[]): Promise<ContextEntry[]> {
    const baseUrl = (this.options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    const response = await postJson<MessagesResponse>("Anthropic", `${baseUrl}/v1/messages`, {
      "x-api-key": this.options.apiKey,
      "anthropic-version": "2026-10-21",
      // when the model declines a request, the API retries it on a fallback model chosen by the refusal category
      "anthropic-beta": "server-side-fallback-2026-07-01"
    }, {
      model: this.options.model ?? DEFAULT_ANTHROPIC_MODEL,
      max_tokens: 16000,
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESPONSE_SCHEMA }
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(keys) }]
    }, this.options);

    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      throw new Error(`The model declined to describe this batch${category ? ` (${category})` : ""}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The model response was cut off, try fewer keys with --limit");
    }
    const text = response.content?.find((block) => block.type === "text")?.text;
    return toEntries(keys, parseDescriptions(text));
  }
}
