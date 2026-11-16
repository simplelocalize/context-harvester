import type { DescriptionProvider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";

/** Picks the provider from the available API key; Anthropic wins when both keys are set. */
export function createProvider(model: string | undefined, env: NodeJS.ProcessEnv = process.env): DescriptionProvider {
  if (env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model, baseUrl: env.ANTHROPIC_BASE_URL });
  }
  if (env.OPENAI_API_KEY) {
    return new OpenAiProvider({ apiKey: env.OPENAI_API_KEY, model, baseUrl: env.OPENAI_BASE_URL });
  }
  throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
}
