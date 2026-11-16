import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ContextEntry, DescriptionProvider, KeyToDescribe } from "../types.js";
import { buildUserMessage, SYSTEM_PROMPT, toEntries } from "./prompt.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

const DescriptionsSchema = z.object({
  descriptions: z.array(z.object({
    key: z.string(),
    namespace: z.string(),
    context: z.string()
  }))
});

export class AnthropicProvider implements DescriptionProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly model: string = DEFAULT_ANTHROPIC_MODEL, client?: Anthropic) {
    // reads ANTHROPIC_API_KEY (or another credential source supported by the SDK) from the environment
    this.client = client ?? new Anthropic();
  }

  async describe(keys: KeyToDescribe[]): Promise<ContextEntry[]> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      // when the model declines a request, the API retries it on a fallback model chosen by the refusal category
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: betaZodOutputFormat(DescriptionsSchema)
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserMessage(keys) }]
    });
    if (response.stop_reason === "refusal") {
      throw new Error(`The model declined to describe this batch${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The model response was cut off, try a smaller --batch-size");
    }
    if (!response.parsed_output) {
      throw new Error("The model returned a response that doesn't match the expected format");
    }
    return toEntries(keys, response.parsed_output.descriptions);
  }
}
