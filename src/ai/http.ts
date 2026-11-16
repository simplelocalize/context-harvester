const MAX_ATTEMPTS = 3;

export interface PostJsonOptions {
  fetch?: typeof fetch;
  /** Delay before retrying 429/5xx responses, in milliseconds. */
  retryDelayMs?: number;
}

/** POSTs JSON to an AI provider and retries rate limited (429) and server (5xx) errors. */
export async function postJson<T>(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: PostJsonOptions = {}
): Promise<T> {
  const fetchImpl = options.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok) {
      return await response.json() as T;
    }
    const text = await response.text().catch(() => "");
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, (options.retryDelayMs ?? 2000) * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(`${providerName} request failed with HTTP ${response.status}: ${text}`);
  }
}
