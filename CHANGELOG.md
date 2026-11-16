# Changelog

## 1.0.1

- `harvest` saves all usages of each key as `references` and refreshes them for keys already in the file on every
  run, without AI.
- `upload` sends the code description and the references of a key in one request (`--no-references` to skip
  references). Descriptions always go to the code description; translator descriptions are never changed.
- No runtime dependencies: Anthropic and OpenAI are called directly with structured JSON output, so `npx` starts
  quickly.
- Removed `--field`, `--batch-size`, `--provider` and `--base-url`. The AI provider is picked from
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, and `SIMPLELOCALIZE_API_URL` changes the API URL.

## 1.0.0

First release.

- `harvest`: finds keys without a description, searches the code for their usages (quoted keys, `namespace:key`,
  Android `R.string` / `@string`) and describes them with Anthropic or OpenAI into `simplelocalize-context.json`.
- `upload`: writes the reviewed descriptions to existing keys (code description by default, or `--field description`).
