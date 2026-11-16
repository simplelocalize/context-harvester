import { readContextFile } from "./contextFile.js";
import type { DescriptionField, SimpleLocalizeClient } from "./simplelocalize.js";
import type { ContextEntry } from "./types.js";
import { formatKey, keyId } from "./types.js";

export interface UploadOptions {
  contextPath: string;
  field: DescriptionField;
  overwrite: boolean;
  dryRun: boolean;
  concurrency?: number;
}

export interface UploadSummary {
  updated: string[];
  unchanged: number;
  /** Keys that already have a different description in this field; replaced only with overwrite. */
  keptExisting: string[];
  notFound: string[];
  empty: number;
}

/** Writes contexts from the file to existing keys only; missing keys are reported, never created. */
export async function upload(options: UploadOptions, client: SimpleLocalizeClient): Promise<UploadSummary> {
  const file = await readContextFile(options.contextPath);
  const keys = new Map((await client.listTranslationKeys()).map((key) => [keyId(key), key]));
  const summary: UploadSummary = { updated: [], unchanged: 0, keptExisting: [], notFound: [], empty: 0 };
  const toUpdate: ContextEntry[] = [];

  for (const entry of file.keys) {
    const context = entry.context.trim();
    if (!context) {
      summary.empty++;
      continue;
    }
    const current = keys.get(keyId(entry));
    if (!current) {
      summary.notFound.push(formatKey(entry));
      continue;
    }
    const currentValue = current[options.field].trim();
    if (currentValue === context) {
      summary.unchanged++;
    } else if (currentValue && !options.overwrite) {
      summary.keptExisting.push(formatKey(entry));
    } else {
      toUpdate.push({ ...entry, context });
    }
  }

  if (options.dryRun) {
    summary.updated = toUpdate.map(formatKey);
    return summary;
  }

  let next = 0;
  const worker = async () => {
    while (next < toUpdate.length) {
      const entry = toUpdate[next++];
      const result = await client.updateDescription(entry, options.field, entry.context);
      (result === "updated" ? summary.updated : summary.notFound).push(formatKey(entry));
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, toUpdate.length) }, worker));
  return summary;
}
