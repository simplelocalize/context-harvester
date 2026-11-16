import { readContextFile } from "./contextFile.js";
import type { KeyChanges, SimpleLocalizeClient, TranslationKey } from "./simplelocalize.js";
import type { KeyRef } from "./types.js";
import { formatKey, keyId } from "./types.js";

export interface UploadOptions {
  contextPath: string;
  overwrite: boolean;
  /** Also upload the places in code of each key. */
  references: boolean;
  dryRun: boolean;
  concurrency?: number;
}

export interface UploadSummary {
  /** Keys whose code description changed. */
  updated: string[];
  unchanged: number;
  /** Keys that already have a different code description; replaced only with overwrite. */
  keptExisting: string[];
  notFound: string[];
  empty: number;
  /** Keys whose places in code changed. */
  referencesUpdated: string[];
}

interface KeyUpdate {
  ref: KeyRef;
  changes: KeyChanges;
}

/**
 * Writes contexts (as code descriptions) and places in code from the file to existing keys only, with one request per
 * changed key; missing keys are reported, never created.
 */
export async function upload(options: UploadOptions, client: SimpleLocalizeClient): Promise<UploadSummary> {
  const file = await readContextFile(options.contextPath);
  const keys = new Map((await client.listTranslationKeys()).map((key) => [keyId(key), key]));
  const summary: UploadSummary = { updated: [], unchanged: 0, keptExisting: [], notFound: [], empty: 0, referencesUpdated: [] };
  const updates: KeyUpdate[] = [];

  for (const entry of file.keys) {
    const context = entry.context.trim();
    if (!context) {
      summary.empty++;
    }
    const current = keys.get(keyId(entry));
    if (!current) {
      if (context) {
        summary.notFound.push(formatKey(entry));
      }
      continue;
    }
    const changes: KeyChanges = {};
    if (context) {
      const currentValue = current.codeDescription.trim();
      if (currentValue === context) {
        summary.unchanged++;
      } else if (currentValue && !options.overwrite) {
        summary.keptExisting.push(formatKey(entry));
      } else {
        changes.codeDescription = context;
      }
    }
    if (options.references && !hasSameReferences(entry.references ?? [], current)) {
      changes.codeReferences = entry.references ?? [];
    }
    if (Object.keys(changes).length > 0) {
      updates.push({ ref: entry, changes });
    }
  }

  const report = (update: KeyUpdate) => {
    if (update.changes.codeDescription !== undefined) summary.updated.push(formatKey(update.ref));
    if (update.changes.codeReferences !== undefined) summary.referencesUpdated.push(formatKey(update.ref));
  };

  if (options.dryRun) {
    updates.forEach(report);
    return summary;
  }

  let next = 0;
  const worker = async () => {
    while (next < updates.length) {
      const update = updates[next++];
      if (await client.updateKey(update.ref, update.changes) === "updated") {
        report(update);
      } else {
        summary.notFound.push(formatKey(update.ref));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, updates.length) }, worker));
  return summary;
}

/** SimpleLocalize keeps as many places as fit and the number of all of them, so compare the stored prefix and the count. */
function hasSameReferences(local: string[], current: TranslationKey): boolean {
  return current.codeReferencesCount === local.length && current.codeReferences.every((reference, index) => local[index] === reference);
}
