# SimpleLocalize Context Harvester

Generate short context descriptions for your translation keys from your source code with AI, review them in your
repository, and upload them to [SimpleLocalize](https://simplelocalize.io).

Translators and AI translation work better when they know where a text is used: is it a button, a title or an error
message, which screen is it on, what is `{amount}`? Context Harvester finds where each key without a description is
used in your code and writes that down for you.

```bash
npx @simplelocalize/context-harvester          # describe keys, save to simplelocalize-context.json
npx @simplelocalize/context-harvester upload   # upload the reviewed file
```

## How it works

1. Loads translation keys from your SimpleLocalize project and picks the ones **without any description**.
2. Searches your code for their usages: quoted keys (`t("checkout.pay")`, `'web:checkout.pay'`) and Android resources
   (`R.string.welcome`, `@string/welcome`). Translation files, build output, `node_modules` and `.gitignore` entries are
   skipped.
3. Sends the key, its source text and a few lines of code around up to 3 usages to an AI model, in batches of 20 keys.
4. Saves the descriptions and all usages (`references`) to `simplelocalize-context.json`. Descriptions already in the
   file are never changed, so your edits are safe when you run it again; their references are refreshed on every run,
   without AI, so they follow your code.
5. You review and edit the file (for example in a pull request), then run `upload`.

`upload` only updates **existing** keys: it never creates or deletes keys, and by default it doesn't replace a
description a key already has. References are uploaded too (use `--no-references` to keep them in the file only).

## Quick start

1. Get the project API key from **Settings > Credentials** in SimpleLocalize.
2. Get an API key from [Anthropic](https://console.anthropic.com) or [OpenAI](https://platform.openai.com).
3. Run it in the root of your repository:

```bash
export SIMPLELOCALIZE_API_KEY=<project API key>
export ANTHROPIC_API_KEY=<your Anthropic key>     # or OPENAI_API_KEY

npx @simplelocalize/context-harvester --dry-run   # preview, writes nothing
npx @simplelocalize/context-harvester             # writes simplelocalize-context.json
# review the file, then:
npx @simplelocalize/context-harvester upload
```

If your repository has a `simplelocalize.yml` with `apiKey`, it is used automatically.

## Context file

```json
{
  "version": 1,
  "keys": [
    {
      "key": "checkout.pay",
      "namespace": "web",
      "context": "Primary button on the last checkout step that charges the saved card. {amount} is the order total with currency.",
      "references": ["src/checkout/PaymentStep.tsx:42"]
    }
  ]
}
```

| Field | Description |
|---|---|
| `key` | Translation key. |
| `namespace` | Namespace of the key, omitted when the key has none. |
| `context` | The description. Edit it freely; up to 500 characters. An empty `context` is skipped on upload. |
| `references` | Where the key is used in your code, as `path:line`. Refreshed on every run. |

The file is sorted by namespace and key, so diffs stay small. Commit it to your repository.

## Commands and options

```
context-harvester [harvest] [options]
context-harvester upload [options]
```

| Option | Commands | Default | Description |
|---|---|---|---|
| `--api-key` | both | `SIMPLELOCALIZE_API_KEY`, then `apiKey` from `simplelocalize.yml` | SimpleLocalize project API key |
| `-c`, `--context` | both | `simplelocalize-context.json` | Context file |
| `--dry-run` | both | off | Show what would change without writing or uploading anything |
| `--overwrite` | both | off | harvest: describe keys already in the file again; upload: replace existing code descriptions |
| `--search-dir` | harvest | `.` | Directory with your source code |
| `--exclude` | harvest | | Glob to skip, repeatable, e.g. `--exclude "**/*.test.ts" --exclude legacy` |
| `--namespace` | harvest | all | Only keys from this namespace |
| `--limit` | harvest | `200` | Max keys per run |
| `--model` | harvest | `claude-opus-5-5` / `gpt-5.4` | AI model |
| `--no-references` | upload | off | Don't upload references, keep them in the file only |

`SIMPLELOCALIZE_API_URL` changes the SimpleLocalize API URL (default `https://api.simplelocalize.io`).

### Where descriptions go

`upload` writes to the key's **code description**. It is visible to translators and used by SimpleLocalize AI
translation, but it is read-only in the editor, because the file in your repository is its source of truth: to change
it, edit the file and upload again. The translator description stays for translators and is never changed.

Keys that already have a description (written by a translator, or a comment imported from your translation files) are
not described again and are not overwritten on upload unless you pass `--overwrite`.

## AI providers and privacy

The provider is picked from the API key you set:

- **Anthropic** when `ANTHROPIC_API_KEY` is set (it wins when both keys are set): `claude-opus-5-5`.
- **OpenAI** when only `OPENAI_API_KEY` is set: `gpt-5.4`. `OPENAI_BASE_URL` points it to a compatible endpoint.

Both are called with structured JSON output and keys are sent in batches of 20. The package has no runtime
dependencies, so `npx` starts quickly.

The tool calls the provider directly with your key. The AI provider receives the key name, its source text and up to
3 snippets of about 13 lines of code around its usages; nothing else from your repository is read by the model.
Your code is not sent to SimpleLocalize: `upload` sends the descriptions and the references (file paths and line
numbers), or only the descriptions with `--no-references`. Use `--exclude` for paths that must not leave your machine.

## Running in CI

Generated descriptions should be reviewed before they reach translators, so run `harvest` on a schedule and open a
pull request with the changes, and run `upload` after it's merged:

```yaml
# .github/workflows/translation-context.yml
name: Translation context
on:
  schedule:
    - cron: "0 6 * * 1"
  push:
    branches: [main]
    paths: [simplelocalize-context.json]

jobs:
  harvest:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - run: npx @simplelocalize/context-harvester
        env:
          SIMPLELOCALIZE_API_KEY: ${{ secrets.SIMPLELOCALIZE_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - uses: peter-evans/create-pull-request@v7
        with:
          title: "Translation context for new keys"
          branch: translation-context
  upload:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx @simplelocalize/context-harvester upload
        env:
          SIMPLELOCALIZE_API_KEY: ${{ secrets.SIMPLELOCALIZE_API_KEY }}
```

## Limitations

- Keys built at runtime (`` t(`errors.${code}`) ``) or stored in variables can't be found; they are listed as
  "not found in code".
- A quoted key followed by `:` or `=` is treated as a definition (JSON, YAML, `.strings`), not a usage.
- Only the root `.gitignore` is read, without negations.

## Development

```bash
npm install
npm test          # unit tests
npm run build     # compiles to dist/
node dist/cli.js --help
```

## License

[MIT](LICENSE)
