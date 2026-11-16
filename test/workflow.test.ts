import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeContextFile } from "../src/contextFile.js";
import { harvest, type Logger } from "../src/harvest.js";
import type { SimpleLocalizeClient, TranslationKey } from "../src/simplelocalize.js";
import type { DescriptionProvider, KeyToDescribe } from "../src/types.js";
import { upload } from "../src/upload.js";
import { createRepo } from "./helpers.js";

const silent: Logger = { info: () => undefined, warn: () => undefined };

function fakeClient(keys: TranslationKey[], updates: { key: string; field: string; value: unknown }[] = [], requests: string[] = []) {
  return {
    listTranslationKeys: async () => keys,
    getDefaultLanguageKey: async () => "en",
    listTexts: async () => new Map([["\u0000checkout.pay", "Pay {amount}"]]),
    updateKey: async (ref: { key: string; namespace: string }, changes: Record<string, unknown>) => {
      if (!keys.some((k) => k.key === ref.key && k.namespace === ref.namespace)) return "not_found";
      requests.push(ref.key);
      for (const [field, value] of Object.entries(changes)) {
        updates.push({ key: ref.key, field, value });
      }
      return "updated";
    }
  } as unknown as SimpleLocalizeClient;
}

const key = (key: string, extra: Partial<TranslationKey> = {}): TranslationKey => ({
  key,
  namespace: "",
  description: "",
  codeDescription: "",
  codeReferences: [],
  codeReferencesCount: 0,
  ...extra
});

describe("harvest", () => {
  it("describes keys without a description that are used in code and saves them with references", async () => {
    const root = await createRepo({ "src/Pay.tsx": "<button>{t('checkout.pay', { amount })}</button>" });
    const contextPath = path.join(root, "simplelocalize-context.json");
    const seen: KeyToDescribe[] = [];
    const provider: DescriptionProvider = {
      name: "fake",
      describe: async (batch) => {
        seen.push(...batch);
        return batch.map((k) => ({ key: k.key, namespace: k.namespace, context: `Button, ${k.text}`, references: [`${k.occurrences[0].file}:${k.occurrences[0].line}`] }));
      }
    };
    const client = fakeClient([key("checkout.pay"), key("described", { description: "Human note" }), key("unused.key")]);

    const summary = await harvest({ contextPath, searchDir: root, exclude: [], limit: 200, batchSize: 20, overwrite: false, dryRun: false }, client, provider, silent);

    expect(seen.map((k) => k.key)).toEqual(["checkout.pay"]);
    expect(seen[0].text).toBe("Pay {amount}");
    expect(summary.notFoundInCode).toEqual(["unused.key"]);
    expect(summary.withDescription).toBe(1);
    expect(JSON.parse(await readFile(contextPath, "utf8"))).toEqual({
      version: 1,
      keys: [{ key: "checkout.pay", context: "Button, Pay {amount}", references: ["src/Pay.tsx:1"] }]
    });
  });

  it("skips keys already in the file, writes nothing in dry run and survives a failed batch", async () => {
    const root = await createRepo({ "src/a.ts": "t('a'); t('b'); t('c')" });
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, { version: 1, keys: [{ key: "a", namespace: "", context: "Reviewed by a human" }] });
    let calls = 0;
    const provider: DescriptionProvider = {
      name: "fake",
      describe: async (batch) => {
        if (++calls === 1) throw new Error("rate limited");
        return batch.map((k) => ({ key: k.key, namespace: k.namespace, context: "Generated" }));
      }
    };
    const client = fakeClient([key("a"), key("b"), key("c")]);

    const dryRun = await harvest({ contextPath, searchDir: root, exclude: [], limit: 200, batchSize: 1, overwrite: false, dryRun: true }, client, provider, silent);

    expect(dryRun.alreadyInFile).toBe(1);
    expect(dryRun.failedBatches).toBe(1);
    expect(dryRun.described.map((e) => e.key)).toEqual(["c"]);
    expect(dryRun.written).toBe(false);
    expect(JSON.parse(await readFile(contextPath, "utf8")).keys).toEqual([{ key: "a", context: "Reviewed by a human" }]);
  });
});

describe("harvest references", () => {
  it("saves all places in code of described keys and refreshes places of keys already in the file without AI", async () => {
    const root = await createRepo({
      "src/a.ts": "t('new.key')\nt('reviewed')",
      "src/b.ts": "t('new.key')\n\nt('reviewed')",
      "src/c.ts": "t('new.key')\nt('new.key')"
    });
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, {
      version: 1,
      keys: [
        { key: "reviewed", namespace: "", context: "Edited by a human", references: ["src/old.ts:7"] },
        { key: "removed", namespace: "", context: "No longer in code", references: ["src/old.ts:1"] }
      ]
    });
    const seen: KeyToDescribe[] = [];
    const provider: DescriptionProvider = {
      name: "fake",
      describe: async (batch) => {
        seen.push(...batch);
        return batch.map((k) => ({ key: k.key, namespace: k.namespace, context: "Generated" }));
      }
    };
    const client = fakeClient([key("new.key"), key("reviewed"), key("removed")]);

    const summary = await harvest({ contextPath, searchDir: root, exclude: [], limit: 200, batchSize: 20, overwrite: false, dryRun: false }, client, provider, silent);

    expect(seen.map((k) => k.key)).toEqual(["new.key"]);
    expect(seen[0].occurrences).toHaveLength(3);
    expect(summary.referencesUpdated).toBe(2);
    expect(JSON.parse(await readFile(contextPath, "utf8")).keys).toEqual([
      { key: "new.key", context: "Generated", references: ["src/a.ts:1", "src/b.ts:1", "src/c.ts:1", "src/c.ts:2"] },
      { key: "removed", context: "No longer in code" },
      { key: "reviewed", context: "Edited by a human", references: ["src/a.ts:2", "src/b.ts:3"] }
    ]);
  });

  it("writes the file when only places in code changed", async () => {
    const root = await createRepo({ "src/a.ts": "\nt('a')" });
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, { version: 1, keys: [{ key: "a", namespace: "", context: "Title", references: ["src/a.ts:1"] }] });
    const provider: DescriptionProvider = { name: "fake", describe: async () => { throw new Error("AI should not be called"); } };

    const summary = await harvest({ contextPath, searchDir: root, exclude: [], limit: 200, batchSize: 20, overwrite: false, dryRun: false }, fakeClient([key("a", { codeDescription: "Title" })]), provider, silent);

    expect(summary.written).toBe(true);
    expect(JSON.parse(await readFile(contextPath, "utf8")).keys).toEqual([{ key: "a", context: "Title", references: ["src/a.ts:2"] }]);
  });
});

describe("upload", () => {
  it("updates existing keys only, keeps other descriptions and skips unchanged entries", async () => {
    const root = await createRepo({});
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, {
      version: 1,
      keys: [
        { key: "new", namespace: "", context: "Pay button" },
        { key: "same", namespace: "", context: "Already there" },
        { key: "from-comment", namespace: "", context: "Generated" },
        { key: "deleted", namespace: "", context: "Old key" },
        { key: "empty", namespace: "", context: "" }
      ]
    });
    const updates: { key: string; field: string; value: unknown }[] = [];
    const client = fakeClient([
      key("new"),
      key("same", { codeDescription: "Already there" }),
      key("from-comment", { codeDescription: "Comment from strings.xml" }),
      key("empty")
    ], updates);

    const summary = await upload({ contextPath, overwrite: false, references: false, dryRun: false }, client);

    expect(updates).toEqual([{ key: "new", field: "codeDescription", value: "Pay button" }]);
    expect(summary).toEqual({
      updated: ["new"],
      unchanged: 1,
      keptExisting: ["from-comment"],
      notFound: ["deleted"],
      empty: 1,
      referencesUpdated: []
    });

    const overwrite = await upload({ contextPath, overwrite: true, references: false, dryRun: true }, client);
    expect(overwrite.updated).toEqual(["from-comment", "new"]);
    expect(updates).toHaveLength(1);
  });

  it("uploads changed places in code, also for keys whose description is kept, and skips unchanged ones", async () => {
    const root = await createRepo({});
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, {
      version: 1,
      keys: [
        { key: "moved", namespace: "", context: "Pay button", references: ["src/Pay.tsx:10"] },
        { key: "same", namespace: "", context: "Title", references: ["src/A.tsx:1", "src/B.tsx:2"] },
        { key: "truncated", namespace: "", context: "Save", references: ["src/A.tsx:1", "src/B.tsx:2", "src/C.tsx:3"] },
        { key: "gone", namespace: "", context: "Removed from code" }
      ]
    });
    const updates: { key: string; field: string; value: unknown }[] = [];
    const client = fakeClient([
      key("moved", { codeDescription: "Pay button", codeReferences: ["src/Pay.tsx:4"], codeReferencesCount: 1 }),
      key("same", { codeDescription: "Human note", codeReferences: ["src/A.tsx:1", "src/B.tsx:2"], codeReferencesCount: 2 }),
      key("truncated", { codeDescription: "Save", codeReferences: ["src/A.tsx:1"], codeReferencesCount: 3 }),
      key("gone", { codeDescription: "Removed from code", codeReferences: ["src/Old.tsx:1"], codeReferencesCount: 1 })
    ], updates);

    const summary = await upload({ contextPath, overwrite: false, references: true, dryRun: false }, client);

    expect(updates.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "gone", field: "codeReferences", value: [] },
      { key: "moved", field: "codeReferences", value: ["src/Pay.tsx:10"] }
    ]);
    expect(summary.referencesUpdated.sort()).toEqual(["gone", "moved"]);
    expect(summary.keptExisting).toEqual(["same"]);
    expect(summary.updated).toEqual([]);
  });

  it("sends a new description and changed places in code of one key in a single request", async () => {
    const root = await createRepo({});
    const contextPath = path.join(root, "simplelocalize-context.json");
    await writeContextFile(contextPath, { version: 1, keys: [{ key: "pay", namespace: "", context: "Pay button", references: ["src/Pay.tsx:4"] }] });
    const updates: { key: string; field: string; value: unknown }[] = [];
    const requests: string[] = [];

    const summary = await upload({ contextPath, overwrite: false, references: true, dryRun: false }, fakeClient([key("pay")], updates, requests));

    expect(requests).toEqual(["pay"]);
    expect(updates).toEqual([
      { key: "pay", field: "codeDescription", value: "Pay button" },
      { key: "pay", field: "codeReferences", value: ["src/Pay.tsx:4"] }
    ]);
    expect(summary.updated).toEqual(["pay"]);
    expect(summary.referencesUpdated).toEqual(["pay"]);
  });
});
