#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createProvider } from "./ai/index.js";
import { DEFAULT_API_URL, readApiKeyFromCliConfig } from "./config.js";
import { DEFAULT_CONTEXT_PATH } from "./contextFile.js";
import { harvest, type Logger } from "./harvest.js";
import { SimpleLocalizeClient } from "./simplelocalize.js";
import { upload } from "./upload.js";

const HELP = `context-harvester - generate translation key context from your source code with AI

Usage:
  context-harvester [harvest] [options]   find keys without a description, describe them with AI and save to the context file
  context-harvester upload [options]      upload the reviewed context file to SimpleLocalize

Common options:
  --api-key <key>         SimpleLocalize project API key (default: SIMPLELOCALIZE_API_KEY or apiKey from simplelocalize.yml)
  -c, --context <path>    context file (default: ${DEFAULT_CONTEXT_PATH})
  --dry-run               show what would change without writing anything
  --overwrite             harvest: describe keys already in the file again; upload: replace existing code descriptions
  -h, --help              show this help
  -v, --version           show version

Harvest options:
  --search-dir <dir>      directory with your source code (default: .)
  --exclude <glob>        skip files or directories, repeatable (node_modules, build output and .gitignore entries are skipped)
  --namespace <name>      only keys from this namespace
  --limit <n>             max keys per run (default: 200)
  --model <id>            AI model (default: claude-opus-5-5 or gpt-5.4)

Upload options:
  --no-references         don't upload where keys are used in code (references)

The AI provider is picked from ANTHROPIC_API_KEY or OPENAI_API_KEY (Anthropic first); the source code snippets of
keys being described are sent to it. Descriptions are uploaded as code descriptions (read-only in the editor).
SIMPLELOCALIZE_API_URL changes the SimpleLocalize API URL (default: ${DEFAULT_API_URL}).
Docs: https://github.com/simplelocalize/context-harvester#readme`;

const console_: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`warning: ${message}`)
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "api-key": { type: "string" },
      context: { type: "string", short: "c" },
      "dry-run": { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      "search-dir": { type: "string", default: "." },
      exclude: { type: "string", multiple: true, default: [] },
      namespace: { type: "string" },
      limit: { type: "string", default: "200" },
      model: { type: "string" },
      "no-references": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(readVersion());
    return 0;
  }

  const command = positionals[0] ?? "harvest";
  if (command !== "harvest" && command !== "upload") {
    throw new Error(`Unknown command "${command}". Run context-harvester --help.`);
  }
  const apiKey = values["api-key"] ?? process.env.SIMPLELOCALIZE_API_KEY ?? await readApiKeyFromCliConfig();
  if (!apiKey) {
    throw new Error("SimpleLocalize API key is missing. Pass --api-key or set SIMPLELOCALIZE_API_KEY.");
  }
  const client = new SimpleLocalizeClient({ apiKey, baseUrl: process.env.SIMPLELOCALIZE_API_URL ?? DEFAULT_API_URL });
  const contextPath = values.context ?? DEFAULT_CONTEXT_PATH;

  if (command === "upload") {
    const summary = await upload({
      contextPath,
      overwrite: values.overwrite,
      references: !values["no-references"],
      dryRun: values["dry-run"]
    }, client);
    console.log(`${values["dry-run"] ? "Would update" : "Updated"} code descriptions of ${summary.updated.length} keys.`);
    if (summary.referencesUpdated.length) console.log(`${values["dry-run"] ? "Would update" : "Updated"} places in code of ${summary.referencesUpdated.length} keys.`);
    if (summary.unchanged) console.log(`Unchanged: ${summary.unchanged}`);
    if (summary.keptExisting.length) console.log(`Kept existing descriptions of ${summary.keptExisting.length} keys (use --overwrite to replace): ${preview(summary.keptExisting)}`);
    if (summary.notFound.length) console.log(`Not found in the project, skipped: ${summary.notFound.length} ${preview(summary.notFound)}`);
    if (summary.empty) console.log(`Entries with an empty context, skipped: ${summary.empty}`);
    return 0;
  }

  const provider = createProvider(values.model);
  const summary = await harvest({
    contextPath,
    searchDir: values["search-dir"],
    exclude: values.exclude,
    namespace: values.namespace,
    limit: toPositiveInt(values.limit, "--limit"),
    overwrite: values.overwrite,
    dryRun: values["dry-run"]
  }, client, provider, console_);

  console.log("");
  console.log(`Keys in project: ${summary.keysInProject}, with a description: ${summary.withDescription}, already in ${contextPath}: ${summary.alreadyInFile}`);
  console.log(`Searched: ${summary.candidates}, described: ${summary.described.length}`);
  if (summary.referencesUpdated) console.log(`Places in code changed for ${summary.referencesUpdated} keys already in ${contextPath}`);
  if (summary.notFoundInCode.length) console.log(`Not found in code: ${summary.notFoundInCode.length} ${preview(summary.notFoundInCode)}`);
  if (summary.failedBatches) console.log(`Failed AI requests: ${summary.failedBatches} (see warnings above)`);
  if (values["dry-run"]) {
    for (const entry of summary.described) {
      console.log(`  ${entry.namespace ? `${entry.namespace}:` : ""}${entry.key}: ${entry.context}`);
    }
  } else if (summary.written) {
    console.log(`\nSaved to ${contextPath}. Review the changes, then run: context-harvester upload`);
  }
  return summary.failedBatches > 0 && summary.described.length === 0 ? 1 : 0;
}

function toPositiveInt(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

const preview = (items: string[]) => `(${items.slice(0, 10).join(", ")}${items.length > 10 ? `, and ${items.length - 10} more` : ""})`;

function readVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return packageJson.version;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
