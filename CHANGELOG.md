# Changelog

## 1.0.0

First release.

- `harvest`: finds keys without a description, searches the code for their usages (quoted keys, `namespace:key`,
  Android `R.string` / `@string`) and describes them with Anthropic or OpenAI into `simplelocalize-context.json`.
- `harvest` saves all usages of each key as `references` and refreshes them for keys already in the file on every run.
- `upload`: writes the reviewed descriptions to the code description of existing keys, together with their
  references, in one request per key (`--no-references` to skip references).
- No runtime dependencies: Anthropic and OpenAI are called directly with structured JSON output.
