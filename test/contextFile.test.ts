import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeEntries, readContextFile, serializeContextFile, writeContextFile } from "../src/contextFile.js";
import { createRepo } from "./helpers.js";

describe("context file", () => {
  it("writes a stable, sorted file and omits empty namespaces and references", async () => {
    const output = serializeContextFile({
      version: 1,
      keys: [
        { key: "pay", namespace: "web", context: "Pay button", references: ["src/Pay.tsx:4"] },
        { key: "close", namespace: "", context: "Closes a dialog" }
      ]
    });

    expect(output).toBe(`{
  "version": 1,
  "keys": [
    {
      "key": "close",
      "context": "Closes a dialog"
    },
    {
      "key": "pay",
      "namespace": "web",
      "context": "Pay button",
      "references": [
        "src/Pay.tsx:4"
      ]
    }
  ]
}
`);
  });

  it("round-trips and treats a missing file as empty", async () => {
    const root = await createRepo({});
    const file = path.join(root, "context.json");

    expect(await readContextFile(file)).toEqual({ version: 1, keys: [] });
    await writeContextFile(file, { version: 1, keys: [{ key: "a", namespace: "", context: "A" }] });
    expect(await readContextFile(file)).toEqual({ version: 1, keys: [{ key: "a", namespace: "", context: "A", references: undefined }] });
    expect(await readFile(file, "utf8")).toMatch(/\n$/);
  });

  it("rejects invalid files", async () => {
    const root = await createRepo({ "broken.json": "{ not json", "wrong.json": "{ \"keys\": [] }" });

    await expect(readContextFile(path.join(root, "broken.json"))).rejects.toThrow("not valid JSON");
    await expect(readContextFile(path.join(root, "wrong.json"))).rejects.toThrow("\"version\": 1");
  });

  it("keeps existing entries unless overwrite is set", () => {
    const existing = [{ key: "a", namespace: "", context: "edited by a human" }];
    const added = [{ key: "a", namespace: "", context: "from AI" }, { key: "b", namespace: "", context: "B" }];

    expect(mergeEntries(existing, added, false).map((e) => e.context)).toEqual(["edited by a human", "B"]);
    expect(mergeEntries(existing, added, true).map((e) => e.context)).toEqual(["from AI", "B"]);
  });
});
