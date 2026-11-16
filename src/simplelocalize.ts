import type { KeyRef } from "./types.js";
import { keyId } from "./types.js";

export interface TranslationKey extends KeyRef {
  description: string;
  codeDescription: string;
}

export type DescriptionField = "codeDescription" | "description";

export type UpdateResult = "updated" | "not_found";

export interface SimpleLocalizeClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  /** Delay before retrying 429/5xx responses, in milliseconds. */
  retryDelayMs?: number;
}

const PAGE_SIZE = 2500;
const MAX_PAGES = 400;
const MAX_ATTEMPTS = 4;
const CLIENT_NAME = "context-harvester";

interface PagedResponse<T> {
  data?: T[];
  pageDetails?: { hasNext?: boolean };
}

export class SimpleLocalizeApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

/** Uses only public SimpleLocalize REST API endpoints authenticated with the project API key. */
export class SimpleLocalizeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(private readonly options: SimpleLocalizeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  async getDefaultLanguageKey(): Promise<string | undefined> {
    const body = await this.request<{ data?: { languages?: { key: string; isDefault?: boolean }[] } }>("GET", "/api/v2/project");
    const languages = body.data?.languages ?? [];
    return (languages.find((language) => language.isDefault) ?? languages[0])?.key;
  }

  async listTranslationKeys(): Promise<TranslationKey[]> {
    const items = await this.paged<{ key: string; namespace?: string; description?: string; codeDescription?: string }>(
      "/api/v1/translation-keys",
      {}
    );
    return items.map((item) => ({
      key: item.key,
      namespace: item.namespace ?? "",
      description: item.description ?? "",
      codeDescription: item.codeDescription ?? ""
    }));
  }

  /** Base (non-customer) translations of one language, by key id. */
  async listTexts(languageKey: string): Promise<Map<string, string>> {
    const items = await this.paged<{ key: string; namespace?: string; text?: string }>("/api/v2/translations", {
      language: languageKey,
      baseOnly: "true"
    });
    const texts = new Map<string, string>();
    for (const item of items) {
      if (item.text) {
        texts.set(keyId({ key: item.key, namespace: item.namespace ?? "" }), item.text);
      }
    }
    return texts;
  }

  /** Updates one description field of an existing key. Never creates keys. */
  async updateDescription(ref: KeyRef, field: DescriptionField, value: string): Promise<UpdateResult> {
    const query = new URLSearchParams({ key: ref.key, namespace: ref.namespace ?? "" });
    const path = field === "description" ? "/api/v1/translation-keys/description" : "/api/v1/translation-keys";
    try {
      await this.request("PATCH", `${path}?${query}`, { [field]: value });
      return "updated";
    } catch (error) {
      if (error instanceof SimpleLocalizeApiError && (error.status === 404 || (error.status === 400 && /does not exist/i.test(error.body)))) {
        return "not_found";
      }
      throw error;
    }
  }

  private async paged<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...params, page: String(page), size: String(PAGE_SIZE) });
      const body = await this.request<PagedResponse<T>>("GET", `${path}?${query}`);
      const data = Array.isArray(body.data) ? body.data : [];
      items.push(...data);
      const hasNext = body.pageDetails?.hasNext ?? data.length === PAGE_SIZE;
      if (!hasNext || data.length === 0) {
        break;
      }
    }
    return items;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-SimpleLocalize-Token": this.options.apiKey,
          "X-SimpleLocalize-Client": CLIENT_NAME,
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const text = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      const message = response.status === 401 || response.status === 403
        ? "SimpleLocalize rejected the API key. Use the project API key from Settings > Credentials."
        : `SimpleLocalize API ${method} ${path.split("?")[0]} failed with HTTP ${response.status}: ${extractMessage(text)}`;
      throw new SimpleLocalizeApiError(message, response.status, text);
    }
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    return parsed?.msg ?? parsed?.message ?? body;
  } catch {
    return body;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
