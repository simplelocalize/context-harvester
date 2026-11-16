import { readFile } from "node:fs/promises";

export const DEFAULT_API_URL = "https://api.simplelocalize.io";

/**
 * Reads apiKey from simplelocalize.yml (the SimpleLocalize CLI config) without a YAML dependency;
 * only a top-level `apiKey: value` line is supported, environment variable references are ignored.
 */
export async function readApiKeyFromCliConfig(path = "simplelocalize.yml"): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const match = content.match(/^apiKey:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/m);
  const value = match?.[1];
  return value && !value.startsWith("$") ? value : undefined;
}
