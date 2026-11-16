# Changelog

## 1.0.0

First release.

- `harvest`: finds keys without a description, searches the code for their usages (quoted keys, `namespace:key`,
  Android `R.string` / `@string`) and describes them with Anthropic or OpenAI into `simplelocalize-context.json`.
- `upload`: writes the reviewed descriptions to existing keys (code description by default, or `--field description`).
