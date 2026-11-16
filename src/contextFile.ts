import { readFile, writeFile } from "node:fs/promises";
import type { ContextEntry, ContextFile } from "./types.js";
import { keyId } from "./types.js";

export const DEFAULT_CONTEXT_PATH = "simplelocalize-context.json";

export async function readContextFile(path: string): Promise<ContextFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, keys: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const file = parsed as Partial<ContextFile>;
  if (file?.version !== 1 || !Array.isArray(file.keys)) {
    throw new Error(`${path} must be an object with "version": 1 and a "keys" array`);
  }
  const keys: ContextEntry[] = file.keys.map((entry, index) => {
    if (!entry || typeof entry.key !== "string" || !entry.key) {
      throw new Error(`${path}: entry #${index + 1} has no "key"`);
    }
    return {
      key: entry.key,
      namespace: typeof entry.namespace === "string" ? entry.namespace : "",
      context: typeof entry.context === "string" ? entry.context : "",
      references: Array.isArray(entry.references) ? entry.references.filter((r) => typeof r === "string") : undefined
    };
  });
  return { version: 1, keys };
}

/** Keys without namespace first, then sorted by namespace and key, so diffs stay small and stable. */
export function sortEntries(entries: ContextEntry[]): ContextEntry[] {
  return [...entries].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key));
}

export function serializeContextFile(file: ContextFile): string {
  const keys = sortEntries(file.keys).map((entry) => {
    const output: Record<string, unknown> = { key: entry.key };
    if (entry.namespace) {
      output.namespace = entry.namespace;
    }
    output.context = entry.context;
    if (entry.references && entry.references.length > 0) {
      output.references = entry.references;
    }
    return output;
  });
  return JSON.stringify({ version: 1, keys }, null, 2) + "\n";
}

export async function writeContextFile(path: string, file: ContextFile): Promise<void> {
  await writeFile(path, serializeContextFile(file), "utf8");
}

/** Adds new entries; existing ones are kept unless overwrite is set. */
export function mergeEntries(existing: ContextEntry[], added: ContextEntry[], overwrite: boolean): ContextEntry[] {
  const byId = new Map(existing.map((entry) => [keyId(entry), entry]));
  for (const entry of added) {
    if (overwrite || !byId.has(keyId(entry))) {
      byId.set(keyId(entry), entry);
    }
  }
  return sortEntries([...byId.values()]);
}
