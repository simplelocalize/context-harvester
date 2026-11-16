import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CodeOccurrence, KeyRef } from "./types.js";
import { keyId } from "./types.js";

export const MAX_OCCURRENCES_PER_KEY = 3;
/** Upper bound of references kept per key; SimpleLocalize stores as many as fit and the number of the rest. */
export const MAX_REFERENCES_PER_KEY = 200;
const SNIPPET_CONTEXT_LINES = 6;
const MAX_SNIPPET_LENGTH = 1500;
const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const BINARY_CHECK_BYTES = 8000;
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "build", "dist", "target", "out", ".next", "vendor", "coverage", ".gradle", "Pods"]);
const TRANSLATION_FILE_EXTENSIONS = new Set(["strings", "stringsdict", "xcstrings", "xliff", "xlf", "po", "pot", "arb", "resx"]);
const ANDROID_REFERENCE = /(?:\bR\.string\.|@string\/)([A-Za-z0-9_.]+)/g;

export interface SearchOptions {
  searchDir: string;
  /** Glob patterns; with "/" matched against the relative path, otherwise against file and directory names. */
  exclude?: string[];
  /** Absolute paths of files to skip, e.g. the context file itself. */
  excludedFiles?: string[];
}

export interface KeyUsages {
  /** Code around the first usages, sent to the AI model. */
  occurrences: Map<string, CodeOccurrence[]>;
  /** All usages as "path:line", in file and line order. */
  references: Map<string, string[]>;
}

/**
 * Finds usages of translation keys in source code: quoted literals ("key", 'key', `key`, "namespace:key")
 * and Android resource references (R.string.key, @string/key). Each file is read once and matched against all keys.
 * Translation files and key definitions (a literal followed by ":" or "=") are not usages and are skipped.
 */
export async function findUsages(keys: KeyRef[], options: SearchOptions): Promise<KeyUsages> {
  const literalToIds = new Map<string, string[]>();
  const add = (literal: string, id: string) => literalToIds.set(literal, [...(literalToIds.get(literal) ?? []), id]);
  for (const ref of keys) {
    add(ref.key, keyId(ref));
    if (ref.namespace) {
      add(`${ref.namespace}:${ref.key}`, keyId(ref));
    }
  }
  const results: KeyUsages = { occurrences: new Map(), references: new Map() };
  if (literalToIds.size === 0) {
    return results;
  }
  const searchDir = path.resolve(options.searchDir);
  const matcher = await createExcludeMatcher(searchDir, options.exclude ?? []);
  const excludedFiles = new Set((options.excludedFiles ?? []).map((file) => path.resolve(file)));
  const maxLiteralLength = Math.max(...[...literalToIds.keys()].map((literal) => literal.length));

  for (const file of await listFiles(searchDir, matcher, excludedFiles)) {
    await scanFile(searchDir, file, literalToIds, maxLiteralLength, results);
  }
  // quoted literals and Android references are matched in two passes, so lines of one file may be out of order
  for (const references of results.references.values()) {
    references.sort(compareReferences);
  }
  return results;
}

async function listFiles(searchDir: string, isExcluded: (relativePath: string) => boolean, excludedFiles: Set<string>): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(searchDir, absolute));
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !isExcluded(relative)) {
          await walk(absolute);
        }
      } else if (entry.isFile() && !excludedFiles.has(absolute) && !isTranslationFile(relative) && !isExcluded(relative)) {
        files.push(absolute);
      }
    }
  };
  await walk(searchDir);
  return files.sort((a, b) => a.localeCompare(b));
}

async function scanFile(
  searchDir: string,
  file: string,
  literalToIds: Map<string, string[]>,
  maxLiteralLength: number,
  results: KeyUsages
): Promise<void> {
  let buffer: Buffer;
  try {
    if ((await stat(file)).size > MAX_FILE_SIZE_BYTES) {
      return;
    }
    buffer = await readFile(file);
  } catch {
    return;
  }
  if (buffer.subarray(0, BINARY_CHECK_BYTES).includes(0)) {
    return;
  }
  const content = buffer.toString("utf8");
  const relativePath = toPosix(path.relative(searchDir, file));
  let lineStarts: number[] | undefined;

  const record = (ids: string[], offset: number) => {
    lineStarts ??= computeLineStarts(content);
    const lineIndex = lineIndexOf(lineStarts, offset);
    const reference = `${relativePath}:${lineIndex + 1}`;
    let occurrence: CodeOccurrence | undefined;
    for (const id of ids) {
      const references = results.references.get(id) ?? [];
      if (references.includes(reference) || references.length >= MAX_REFERENCES_PER_KEY) {
        continue;
      }
      references.push(reference);
      results.references.set(id, references);
      const occurrences = results.occurrences.get(id) ?? [];
      if (occurrences.length < MAX_OCCURRENCES_PER_KEY) {
        occurrence ??= { file: relativePath, line: lineIndex + 1, code: buildSnippet(content, lineStarts, lineIndex, offset) };
        occurrences.push(occurrence);
        results.occurrences.set(id, occurrences);
      }
    }
  };

  for (let start = 0; start < content.length; start++) {
    const quote = content[start];
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      continue;
    }
    const end = findClosingQuote(content, start, quote, maxLiteralLength);
    if (end < 0) {
      continue;
    }
    const ids = literalToIds.get(content.substring(start + 1, end));
    if (ids && !isKeyDefinition(content, end + 1)) {
      record(ids, start);
    }
  }

  for (const match of content.matchAll(ANDROID_REFERENCE)) {
    const ids = literalToIds.get(match[1]);
    if (ids) {
      record(ids, match.index ?? 0);
    }
  }
}

function compareReferences(a: string, b: string): number {
  const [fileA, lineA] = splitReference(a);
  const [fileB, lineB] = splitReference(b);
  return fileA.localeCompare(fileB) || lineA - lineB;
}

function splitReference(reference: string): [string, number] {
  const separator = reference.lastIndexOf(":");
  return [reference.slice(0, separator), Number(reference.slice(separator + 1))];
}

function findClosingQuote(content: string, start: number, quote: string, maxLiteralLength: number): number {
  const limit = Math.min(content.length, start + maxLiteralLength + 2);
  for (let i = start + 1; i < limit; i++) {
    const char = content[i];
    if (char === quote) {
      return i === start + 1 ? -1 : i;
    }
    if (char === "\n") {
      return -1;
    }
  }
  return -1;
}

/** A literal followed by ":" or "=" defines the key (JSON/YAML/JS objects, .strings files) rather than using it. */
function isKeyDefinition(content: string, index: number): boolean {
  for (let i = index; i < content.length; i++) {
    const char = content[i];
    if (char === " " || char === "\t") {
      continue;
    }
    return char === ":" || (char === "=" && content[i + 1] !== "=");
  }
  return false;
}

function buildSnippet(content: string, lineStarts: number[], lineIndex: number, matchOffset: number): string {
  for (let radius = SNIPPET_CONTEXT_LINES; radius >= 0; radius--) {
    const fromLine = Math.max(0, lineIndex - radius);
    const toLine = Math.min(lineStarts.length - 1, lineIndex + radius);
    const snippet = content.substring(lineStarts[fromLine], lineEnd(content, lineStarts, toLine)).replace(/[\r\n]+$/, "");
    if (snippet.length <= MAX_SNIPPET_LENGTH) {
      return snippet;
    }
  }
  const from = Math.max(lineStarts[lineIndex], matchOffset - MAX_SNIPPET_LENGTH / 2);
  const to = Math.min(lineEnd(content, lineStarts, lineIndex), from + MAX_SNIPPET_LENGTH);
  return content.substring(from, to).replace(/[\r\n]+$/, "");
}

const lineEnd = (content: string, lineStarts: number[], lineIndex: number) =>
  lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n" && i + 1 < content.length) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function lineIndexOf(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/** Translation files contain keys too, but they are not usages; Android string resources live in res/values* directories. */
function isTranslationFile(relativePath: string): boolean {
  const extension = path.extname(relativePath).slice(1).toLowerCase();
  if (TRANSLATION_FILE_EXTENSIONS.has(extension)) {
    return true;
  }
  return extension === "xml" && path.basename(path.dirname(relativePath)).startsWith("values");
}

async function createExcludeMatcher(searchDir: string, patterns: string[]): Promise<(relativePath: string) => boolean> {
  const all = [...patterns, ...(await readGitIgnore(searchDir))];
  const nameMatchers: RegExp[] = [];
  const pathMatchers: RegExp[] = [];
  for (const raw of all) {
    let pattern = raw.trim().replace(/^\.\//, "");
    const anchored = pattern.startsWith("/");
    pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pattern) {
      continue;
    }
    (anchored || pattern.includes("/") ? pathMatchers : nameMatchers).push(globToRegExp(pattern));
  }
  return (relativePath) => {
    const name = path.posix.basename(relativePath);
    return nameMatchers.some((m) => m.test(name)) || pathMatchers.some((m) => m.test(relativePath));
  };
}

/** Simple .gitignore support: root file only, negations are ignored. */
async function readGitIgnore(searchDir: string): Promise<string[]> {
  try {
    const content = await readFile(path.join(searchDir, ".gitignore"), "utf8");
    return content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
  } catch {
    return [];
  }
}

export function globToRegExp(glob: string): RegExp {
  let regex = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        const followedBySlash = glob[i + 2] === "/";
        regex += followedBySlash ? "(?:.*/)?" : ".*";
        i += followedBySlash ? 2 : 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`);
}

const toPosix = (value: string) => value.split(path.sep).join("/");
