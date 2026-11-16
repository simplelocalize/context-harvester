export interface KeyRef {
  key: string;
  namespace: string;
}

export interface ContextEntry extends KeyRef {
  /** Short note for translators and AI translation describing where and how the text is used. */
  context: string;
  /** Places in the source code where the key is used, as "path:line". */
  references?: string[];
}

export interface ContextFile {
  version: 1;
  keys: ContextEntry[];
}

export interface CodeOccurrence {
  /** Path relative to the search directory, with forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** A few lines of code around the usage. */
  code: string;
}

export interface Candidate extends KeyRef {
  /** Source text in the project's default language, empty when missing. */
  text: string;
}

export interface KeyToDescribe extends Candidate {
  occurrences: CodeOccurrence[];
}

export interface DescriptionProvider {
  readonly name: string;
  describe(keys: KeyToDescribe[]): Promise<ContextEntry[]>;
}

export const keyId = (ref: KeyRef): string => `${ref.namespace ?? ""}\u0000${ref.key}`;

export const formatKey = (ref: KeyRef): string => (ref.namespace ? `${ref.namespace}:${ref.key}` : ref.key);
