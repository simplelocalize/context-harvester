import type { DescriptionProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";

export type ProviderName = "anthropic" | "openai";

/** Picks the provider explicitly or from the available API key; Anthropic wins when both keys are set. */
export function createProvider(name: ProviderName | undefined, model: string | undefined, env: NodeJS.ProcessEnv = process.env): DescriptionProvider {
  const resolved = name ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.OPENAI_API_KEY ? "openai" : undefined);
  if (resolved === "anthropic") {
    return new AnthropicProvider(model);
  }
  if (resolved === "openai") {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY, model, baseUrl: env.OPENAI_BASE_URL });
  }
  throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass --provider.");
}
