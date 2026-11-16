import path from "node:path";
import { mergeEntries, readContextFile, writeContextFile } from "./contextFile.js";
import { findUsages } from "./search.js";
import type { SimpleLocalizeClient } from "./simplelocalize.js";
import type { Candidate, ContextEntry, DescriptionProvider, KeyToDescribe } from "./types.js";
import { formatKey, keyId } from "./types.js";

const DEFAULT_BATCH_SIZE = 20;

export interface HarvestOptions {
  contextPath: string;
  searchDir: string;
  exclude: string[];
  namespace?: string;
  limit: number;
  /** Keys per AI request. */
  batchSize?: number;
  overwrite: boolean;
  dryRun: boolean;
}

export interface HarvestSummary {
  keysInProject: number;
  withDescription: number;
  alreadyInFile: number;
  candidates: number;
  notFoundInCode: string[];
  described: ContextEntry[];
  /** Keys already in the file whose references changed since the last run. */
  referencesUpdated: number;
  failedBatches: number;
  written: boolean;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export async function harvest(
  options: HarvestOptions,
  client: SimpleLocalizeClient,
  provider: DescriptionProvider,
  log: Logger
): Promise<HarvestSummary> {
  const file = await readContextFile(options.contextPath);
  const inFile = new Set(file.keys.map(keyId));

  log.info("Loading translation keys from SimpleLocalize...");
  const [keys, languageKey] = await Promise.all([client.listTranslationKeys(), client.getDefaultLanguageKey()]);
  const texts = languageKey ? await client.listTexts(languageKey) : new Map<string, string>();

  const withoutDescription = keys
    .filter((key) => !key.description.trim() && !key.codeDescription.trim())
    .filter((key) => options.namespace === undefined || key.namespace === options.namespace);
  const notInFile = withoutDescription.filter((key) => options.overwrite || !inFile.has(keyId(key)));
  const candidates: Candidate[] = notInFile.slice(0, options.limit).map((key) => ({
    key: key.key,
    namespace: key.namespace,
    text: texts.get(keyId(key)) ?? ""
  }));

  log.info(`Searching ${path.resolve(options.searchDir)} for ${candidates.length} keys without a description and ${file.keys.length} keys in ${options.contextPath}...`);
  const usages = await findUsages([...candidates, ...file.keys], {
    searchDir: options.searchDir,
    exclude: options.exclude,
    excludedFiles: [path.resolve(options.contextPath)]
  });
  const toDescribe: KeyToDescribe[] = [];
  const notFoundInCode: string[] = [];
  for (const candidate of candidates) {
    const found = usages.occurrences.get(keyId(candidate));
    if (found && found.length > 0) {
      toDescribe.push({ ...candidate, occurrences: found });
    } else {
      notFoundInCode.push(formatKey(candidate));
    }
  }

  const described: ContextEntry[] = [];
  let failedBatches = 0;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  for (let start = 0; start < toDescribe.length; start += batchSize) {
    const batch = toDescribe.slice(start, start + batchSize);
    log.info(`Describing keys ${start + 1}-${start + batch.length} of ${toDescribe.length} with ${provider.name}...`);
    try {
      const entries = await provider.describe(batch);
      described.push(...entries.map((entry) => ({ ...entry, references: usages.references.get(keyId(entry)) ?? entry.references })));
    } catch (error) {
      failedBatches++;
      log.warn(`Skipped ${batch.length} keys: ${(error as Error).message}`);
    }
  }

  // references of keys described before are refreshed on every run, without AI, so they follow code changes
  let referencesUpdated = 0;
  const refreshed = file.keys.map((entry) => {
    const references = usages.references.get(keyId(entry)) ?? [];
    if (sameList(references, entry.references ?? [])) {
      return entry;
    }
    referencesUpdated++;
    return { ...entry, references };
  });

  let written = false;
  if (!options.dryRun && (described.length > 0 || referencesUpdated > 0)) {
    await writeContextFile(options.contextPath, { version: 1, keys: mergeEntries(refreshed, described, options.overwrite) });
    written = true;
  }

  return {
    keysInProject: keys.length,
    withDescription: keys.length - keys.filter((key) => !key.description.trim() && !key.codeDescription.trim()).length,
    alreadyInFile: withoutDescription.length - notInFile.length,
    candidates: candidates.length,
    notFoundInCode,
    described,
    referencesUpdated,
    failedBatches,
    written
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
