#!/usr/bin/env node
// The Broadsheet agent command line (PLAN.md §8.3). More commands arrive with each Phase 1 milestone.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { openDb, schemaVersion, syncConfig } from "./db/db.ts";

const p = paths();
const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, "..", "config.example.json");

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const bad = (msg: string) => console.log(`  ❌ ${msg}`);

async function init(clientId?: string) {
  if (existsSync(p.config)) {
    console.log(`A config file already exists at:\n  ${p.config}\nLeaving it alone.`);
    return;
  }
  await mkdir(p.home, { recursive: true });
  if (clientId) {
    const example = JSON.parse(await readFile(EXAMPLE, "utf8"));
    example.microsoft.clientId = clientId;
    await writeFile(p.config, JSON.stringify(example, null, 2) + "\n", { mode: 0o600 });
  } else {
    await copyFile(EXAMPLE, p.config);
  }
  console.log(`Created ${p.config}\nEdit it, then run: broadsheet doctor`);
}

async function doctor(): Promise<boolean> {
  console.log("Config");
  let config;
  try {
    config = await loadConfig(p.config);
    ok(`${p.config}`);
    ok(`${config.sections.length} sections, ${config.sources.length} sources, ${config.rules.length} rules, mailbox mode "${config.mailbox.mode}"`);
    if (config.microsoft.clientId === "00000000-0000-0000-0000-000000000000") {
      bad("microsoft.clientId is still the placeholder from the example");
      return false;
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    bad(e.message.replaceAll("\n", "\n     "));
    return false;
  }

  console.log("Database");
  const db = openDb(p.db);
  try {
    ok(`${p.db} (schema version ${schemaVersion(db)})`);
    const s = syncConfig(db, config);
    ok(`config copied in: ${s.sections} sections, ${s.sources} sources, ${s.rules} rules`);
    if (s.removed.length) ok(`removed (no longer in config): ${s.removed.join(", ")}`);
  } finally {
    db.close();
  }
  // M2 adds: Microsoft sign-in, mail folders, OneDrive, Ollama and the activity signals.
  return true;
}

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

switch (cmd) {
  case "init":
    await init(flag("client-id"));
    break;
  case "doctor":
    process.exitCode = (await doctor()) ? 0 : 1;
    break;
  case "paths":
    console.log(p);
    break;
  default:
    console.log(`Usage: broadsheet <command>

  init [--client-id <id>]   create the config file from the example
  doctor                    check the config file and database
  paths                     show where the agent keeps its files`);
    if (cmd) process.exitCode = 1;
}
