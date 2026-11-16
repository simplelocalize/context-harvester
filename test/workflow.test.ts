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

function fakeClient(keys: TranslationKey[], updates: { key: string; field: string; value: string }[] = []) {
  return {
    listTranslationKeys: async () => keys,
    getDefaultLanguageKey: async () => "en",
    listTexts: async () => new Map([["\u0000checkout.pay", "Pay {amount}"]]),
    updateDescription: async (ref: { key: string; namespace: string }, field: string, value: string) => {
      if (!keys.some((k) => k.key === ref.key && k.namespace === ref.namespace)) return "not_found";
      updates.push({ key: ref.key, field, value });
      return "updated";
    }
  } as unknown as SimpleLocalizeClient;
}

const key = (key: string, extra: Partial<TranslationKey> = {}): TranslationKey => ({ key, namespace: "", description: "", codeDescription: "", ...extra });

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
    const updates: { key: string; field: string; value: string }[] = [];
    const client = fakeClient([
      key("new"),
      key("same", { codeDescription: "Already there" }),
      key("from-comment", { codeDescription: "Comment from strings.xml" }),
      key("empty")
    ], updates);

    const summary = await upload({ contextPath, field: "codeDescription", overwrite: false, dryRun: false }, client);

    expect(updates).toEqual([{ key: "new", field: "codeDescription", value: "Pay button" }]);
    expect(summary).toEqual({ updated: ["new"], unchanged: 1, keptExisting: ["from-comment"], notFound: ["deleted"], empty: 1 });

    const overwrite = await upload({ contextPath, field: "codeDescription", overwrite: true, dryRun: true }, client);
    expect(overwrite.updated).toEqual(["from-comment", "new"]);
    expect(updates).toHaveLength(1);
  });
});
