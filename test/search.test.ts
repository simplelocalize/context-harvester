import { describe, expect, it } from "vitest";
import { findOccurrences, globToRegExp } from "../src/search.js";
import { keyId } from "../src/types.js";
import { createRepo } from "./helpers.js";

describe("findOccurrences", () => {
  it("finds quoted usages with line numbers and code around them", async () => {
    const root = await createRepo({
      "src/Checkout.tsx": "import { t } from 'i18n';\n\nexport const Pay = () => (\n  <button>{t(\"checkout.pay\")}</button>\n);\n"
    });

    const result = await findOccurrences([{ key: "checkout.pay", namespace: "" }], { searchDir: root });

    const occurrences = result.get(keyId({ key: "checkout.pay", namespace: "" }));
    expect(occurrences).toHaveLength(1);
    expect(occurrences![0].file).toBe("src/Checkout.tsx");
    expect(occurrences![0].line).toBe(4);
    expect(occurrences![0].code).toContain("<button>{t(\"checkout.pay\")}</button>");
    expect(occurrences![0].code).toContain("import { t } from 'i18n';");
  });

  it("skips key definitions, translation files, build output and excluded paths", async () => {
    const root = await createRepo({
      "messages/en.json": "{ \"checkout.pay\": \"Pay\" }",
      "src/messages.js": "export default { 'checkout.pay': 'Pay' };",
      "ios/en.lproj/Localizable.strings": "\"checkout.pay\" = \"Pay\";",
      "android/res/values/strings.xml": "<string name=\"checkout.pay\">Pay</string>",
      "node_modules/lib/index.js": "t('checkout.pay')",
      "dist/app.js": "t('checkout.pay')",
      "generated/keys.ts": "t('checkout.pay')",
      "src/legacy/old.ts": "t('checkout.pay')",
      ".gitignore": "generated/\n",
      "src/app.ts": "if (key === 'checkout.pay') { t('checkout.pay') }"
    });

    const result = await findOccurrences([{ key: "checkout.pay", namespace: "" }], { searchDir: root, exclude: ["src/legacy/**"] });

    const occurrences = result.get(keyId({ key: "checkout.pay", namespace: "" }))!;
    expect(occurrences.map((o) => o.file)).toEqual(["src/app.ts"]);
  });

  it("matches namespace:key literals and Android resource references", async () => {
    const root = await createRepo({
      "src/i18n.ts": "t('web:checkout.title')",
      "app/src/main/java/Main.kt": "val title = getString(R.string.welcome_title)",
      "app/src/main/res/layout/main.xml": "<TextView android:text=\"@string/welcome_title\" />"
    });

    const result = await findOccurrences([
      { key: "checkout.title", namespace: "web" },
      { key: "welcome_title", namespace: "" }
    ], { searchDir: root });

    expect(result.get(keyId({ key: "checkout.title", namespace: "web" }))!.map((o) => o.file)).toEqual(["src/i18n.ts"]);
    expect(result.get(keyId({ key: "welcome_title", namespace: "" }))!.map((o) => o.file).sort())
      .toEqual(["app/src/main/java/Main.kt", "app/src/main/res/layout/main.xml"]);
  });

  it("keeps at most 3 usages per key and ignores binary files", async () => {
    const root = await createRepo({
      "a.ts": "t('k')\nt('k')",
      "b.ts": "t('k')",
      "c.ts": "t('k')",
      "image.bin": Buffer.from([0x74, 0x28, 0x27, 0x6b, 0x27, 0x29, 0x00])
    });

    const result = await findOccurrences([{ key: "k", namespace: "" }], { searchDir: root });

    expect(result.get(keyId({ key: "k", namespace: "" }))!.map((o) => `${o.file}:${o.line}`)).toEqual(["a.ts:1", "a.ts:2", "b.ts:1"]);
  });
});

describe("globToRegExp", () => {
  it("supports *, ** and ?", () => {
    expect(globToRegExp("*.test.ts").test("app.test.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/c.ts")).toBe(false);
    expect(globToRegExp("file?.js").test("file1.js")).toBe(true);
  });
});
