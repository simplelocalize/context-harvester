import { describe, expect, it } from "vitest";
import { SimpleLocalizeClient } from "../src/simplelocalize.js";
import { mockFetch } from "./helpers.js";

describe("SimpleLocalizeClient", () => {
  it("pages through translation keys with the project API key", async () => {
    const { fetchImpl, requests } = mockFetch((request) => {
      const page = request.url.searchParams.get("page");
      return page === "0"
        ? { body: { data: [{ key: "a", namespace: "", description: "", codeDescription: "" }], pageDetails: { hasNext: true } } }
        : { body: { data: [{ key: "b", namespace: "web", description: "Human note", codeDescription: "", codeReferences: ["src/B.tsx:3"], codeReferencesCount: 12 }], pageDetails: { hasNext: false } } };
    });
    const client = new SimpleLocalizeClient({ apiKey: "project-key", baseUrl: "https://api.test/", fetch: fetchImpl });

    const keys = await client.listTranslationKeys();

    expect(keys).toEqual([
      { key: "a", namespace: "", description: "", codeDescription: "", codeReferences: [], codeReferencesCount: 0 },
      { key: "b", namespace: "web", description: "Human note", codeDescription: "", codeReferences: ["src/B.tsx:3"], codeReferencesCount: 12 }
    ]);
    expect(requests.map((r) => `${r.url.pathname}?${r.url.searchParams}`)).toEqual([
      "/api/v1/translation-keys?page=0&size=2500",
      "/api/v1/translation-keys?page=1&size=2500"
    ]);
    expect(requests[0].headers["X-SimpleLocalize-Token"]).toBe("project-key");
  });

  it("reads the default language and its texts", async () => {
    const { fetchImpl, requests } = mockFetch((request) => request.url.pathname === "/api/v2/project"
      ? { body: { data: { languages: [{ key: "pl" }, { key: "en", isDefault: true }] } } }
      : { body: { data: [{ key: "a", namespace: "", text: "Pay" }] } });
    const client = new SimpleLocalizeClient({ apiKey: "k", baseUrl: "https://api.test", fetch: fetchImpl });

    expect(await client.getDefaultLanguageKey()).toBe("en");
    expect([...(await client.listTexts("en")).values()]).toEqual(["Pay"]);
    expect(requests[1].url.searchParams.get("language")).toBe("en");
    expect(requests[1].url.searchParams.get("baseOnly")).toBe("true");
  });

  it("updates code description and places in code of an existing key in one request and reports missing keys", async () => {
    const { fetchImpl, requests } = mockFetch((request) => request.url.searchParams.get("key") === "missing"
      ? { status: 400, body: { msg: "Translation key does not exists", status: 400 } }
      : { body: { msg: "OK" } });
    const client = new SimpleLocalizeClient({ apiKey: "k", baseUrl: "https://api.test", fetch: fetchImpl });

    expect(await client.updateKey({ key: "pay", namespace: "web" }, { codeDescription: "Pay button", codeReferences: ["src/Pay.tsx:4"] })).toBe("updated");
    expect(await client.updateKey({ key: "missing", namespace: "" }, { codeDescription: "x" })).toBe("not_found");

    expect(requests[0]).toMatchObject({ method: "PATCH", body: { codeDescription: "Pay button", codeReferences: ["src/Pay.tsx:4"] } });
    expect(`${requests[0].url.pathname}?${requests[0].url.searchParams}`).toBe("/api/v1/translation-keys?key=pay&namespace=web");
  });

  it("retries rate limited requests and explains rejected API keys", async () => {
    let calls = 0;
    const { fetchImpl } = mockFetch(() => ++calls === 1 ? { status: 429 } : { body: { data: { languages: [] } } });
    const client = new SimpleLocalizeClient({ apiKey: "k", baseUrl: "https://api.test", fetch: fetchImpl, retryDelayMs: 1 });
    expect(await client.getDefaultLanguageKey()).toBeUndefined();
    expect(calls).toBe(2);

    const unauthorized = new SimpleLocalizeClient({ apiKey: "bad", baseUrl: "https://api.test", fetch: mockFetch(() => ({ status: 403 })).fetchImpl });
    await expect(unauthorized.getDefaultLanguageKey()).rejects.toThrow("rejected the API key");
  });
});
