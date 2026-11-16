import type { ContextEntry, DescriptionProvider, KeyToDescribe } from "../types.js";
import { postJson, type PostJsonOptions } from "./http.js";
import { buildUserMessage, parseDescriptions, RESPONSE_SCHEMA, SYSTEM_PROMPT, toEntries } from "./prompt.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";

export interface OpenAiProviderOptions extends PostJsonOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string; refusal?: string } }[];
}

export class OpenAiProvider implements DescriptionProvider {
  readonly name = "openai";

  constructor(private readonly options: OpenAiProviderOptions) {
  }

  async describe(keys: KeyToDescribe[]): Promise<ContextEntry[]> {
    const baseUrl = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const response = await postJson<ChatCompletionResponse>("OpenAI", `${baseUrl}/chat/completions`, {
      "Authorization": `Bearer ${this.options.apiKey}`
    }, {
      model: this.options.model ?? DEFAULT_OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(keys) }
      ],
      response_format: { type: "json_schema", json_schema: { name: "descriptions", strict: true, schema: RESPONSE_SCHEMA } }
    }, this.options);

    const message = response.choices?.[0]?.message;
    if (message?.refusal) {
      throw new Error(`The model declined to describe this batch: ${message.refusal}`);
    }
    return toEntries(keys, parseDescriptions(message?.content));
  }
}
