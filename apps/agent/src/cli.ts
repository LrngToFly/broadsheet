#!/usr/bin/env node
// The Broadsheet agent command line (PLAN.md §8.3). More commands arrive with each Phase 1 milestone.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@broadsheet/shared";
import { paths } from "./paths.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { openDb, schemaVersion, syncConfig, type Db } from "./db/db.ts";
import { Auth, NotSignedInError } from "./microsoft/auth.ts";
import { Graph } from "./microsoft/graph.ts";
import { checkFolders, ensureFolders, type FolderReport } from "./microsoft/mail-folders.ts";
import { AppFolder } from "./microsoft/onedrive.ts";
import { ollamaStatus } from "./ai/ollama.ts";
import { aiMayRun, sampleActivity } from "./activity.ts";

const p = paths();
const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, "..", "config.example.json");
const SPIKE_CACHE = join(homedir(), "Library", "Application Support", "Broadsheet-spike", "msal-cache.json");

const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const bad = (msg: string) => console.log(`  ❌ ${msg.replaceAll("\n", "\n     ")}`);
const note = (msg: string) => console.log(`  ·  ${msg}`);
const mask = (email: string) => email.replace(/^(.).*(@.*)$/, "$1•••$2");

function services(config: Config) {
  const auth = new Auth({ clientId: config.microsoft.clientId, cacheFile: p.tokenCache });
  const graph = new Graph(() => auth.token());
  return { auth, graph, appFolder: new AppFolder(graph) };
}

async function withConfigAndDb<T>(fn: (config: Config, db: Db) => Promise<T>): Promise<T> {
  const config = await loadConfig(p.config);
  const db = openDb(p.db);
  try {
    syncConfig(db, config);
    return await fn(config, db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------------------------------

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

async function login(importSpike: boolean) {
  const config = await loadConfig(p.config);
  const { auth } = services(config);
  if (importSpike) {
    if (!existsSync(SPIKE_CACHE)) throw new Error(`No Phase 0 sign-in found at ${SPIKE_CACHE}`);
    const account = await auth.importPlainCache(await readFile(SPIKE_CACHE, "utf8"));
    if (!account) throw new Error("The Phase 0 sign-in file had no account in it.");
    console.log(`Signed in as ${mask(account.username)} using the Phase 0 sign-in.`);
  } else {
    console.log("Sign in to the newsletter account (you can do this on your phone):\n");
    const account = await auth.login((message) => console.log(`  ${message}\n`));
    console.log(`Signed in as ${mask(account.username)}.`);
  }
  console.log("The sign-in is saved encrypted; its key is in your Keychain as \"The Broadsheet sign-in key\".");
}

async function logout() {
  const config = await loadConfig(p.config);
  await services(config).auth.logout();
  console.log("Signed out: the saved sign-in and its Keychain key are removed.");
}

function printFolders(r: FolderReport) {
  if (!r.root.id) bad(`"${r.root.name}" folder not found`);
  for (const f of r.folders) {
    const label = `${r.root.name}/${f.name}`;
    if (f.status === "ok") ok(label);
    else if (f.status === "rename") bad(`${r.root.name}/${f.currentName} should be renamed to "${f.name}"`);
    else bad(`${label} is missing`);
  }
}

async function folders(create: boolean) {
  await withConfigAndDb(async (config, db) => {
    const { graph } = services(config);
    if (create) {
      const r = await ensureFolders(graph, config, db);
      for (const c of r.changes) console.log(`  ${c}`);
      console.log(r.changes.length ? "Folders are up to date." : "Nothing to change: all folders already exist.");
    } else {
      printFolders(await checkFolders(graph, config, db));
    }
  });
}

async function doctor(): Promise<boolean> {
  let healthy = true;
  const fail = (msg: string) => {
    bad(msg);
    healthy = false;
  };

  console.log("Config");
  let config: Config;
  try {
    config = await loadConfig(p.config);
    ok(p.config);
    ok(`${config.sections.length} sections, ${config.sources.length} sources, ${config.rules.length} rules, mailbox mode "${config.mailbox.mode}"`);
    if (/^0{8}-/.test(config.microsoft.clientId)) {
      fail("microsoft.clientId is still the placeholder from the example");
      return false;
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    fail(e.message);
    return false;
  }

  console.log("Database");
  const db = openDb(p.db);
  try {
    ok(`${p.db} (schema version ${schemaVersion(db)})`);
    const s = syncConfig(db, config);
    ok(`config copied in: ${s.sections} sections, ${s.sources} sources, ${s.rules} rules`);
    if (s.removed.length) note(`removed (no longer in config): ${s.removed.join(", ")}`);

    const { auth, graph, appFolder } = services(config);

    console.log("Microsoft sign-in");
    let signedIn = false;
    try {
      const account = await auth.account();
      await auth.token();
      ok(`signed in as ${mask(account!.username)}; token renews silently`);
      signedIn = true;
    } catch (e) {
      fail(e instanceof NotSignedInError ? e.message : `sign-in check failed: ${(e as Error).message}`);
    }

    if (signedIn) {
      console.log("Outlook folders");
      try {
        const r = await checkFolders(graph, config, db);
        printFolders(r);
        if (!r.root.id || r.folders.some((f) => f.status !== "ok")) {
          healthy = false;
          note("Run: broadsheet folders --create");
        }
      } catch (e) {
        fail(`couldn't read mail folders: ${(e as Error).message}`);
      }

      console.log("OneDrive App Folder");
      try {
        const probe = { checkedAt: new Date().toISOString(), by: "broadsheet doctor" };
        await appFolder.putJson("status/doctor.json", probe);
        const back = await appFolder.getJson<typeof probe>("status/doctor.json");
        if (back.checkedAt !== probe.checkedAt) throw new Error("read back a different file");
        const info = await appFolder.info();
        ok(`write and read OK (${info.name})`);
      } catch (e) {
        fail(`OneDrive check failed: ${(e as Error).message}`);
      }
    }
  } finally {
    db.close();
  }

  console.log("Ollama");
  const o = await ollamaStatus(config.ai.baseUrl, config.ai.model);
  if (!o.running) fail(`not reachable at ${config.ai.baseUrl} (${o.error}). Start it with: brew services start ollama`);
  else {
    ok(`Ollama ${o.version} at ${config.ai.baseUrl}`);
    if (o.hasModel) ok(`${config.ai.model} installed${o.loaded ? " (loaded right now)" : " (not loaded; it loads only while summarizing)"}`);
    else fail(`${config.ai.model} isn't installed. Run: ollama pull ${config.ai.model}`);
  }

  console.log("Activity signals");
  try {
    const s = await sampleActivity();
    const fmt = (v: unknown) => (v === null ? "unreadable" : String(v));
    ok(`idle ${fmt(s.idleSeconds === null ? null : `${Math.round(s.idleSeconds)} s`)}, screen locked ${fmt(s.screenLocked)}, Low Power Mode ${fmt(s.lowPowerMode)}`);
    ok(`memory pressure ${s.memoryPressure}, thermal ${s.thermal}, load ${s.load5m.toFixed(1)}`);
    if (s.idleSeconds === null || s.screenLocked === null) fail("some signals couldn't be read");
    const may = aiMayRun(s, config.politeness);
    note(may.ok ? "AI work could run right now" : `AI work would wait: ${may.reason}`);
  } catch (e) {
    fail(`couldn't read activity: ${(e as Error).message}`);
  }

  console.log(healthy ? "\nAll checks passed." : "\nSome checks need attention (❌ above).");
  return healthy;
}

// ---------------------------------------------------------------------------------------------------

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

try {
  switch (cmd) {
    case "init":
      await init(flag("client-id"));
      break;
    case "login":
      await login(has("import-spike"));
      break;
    case "logout":
      await logout();
      break;
    case "folders":
      await folders(has("create"));
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
  login                     sign in to the newsletter account (once)
  login --import-spike      reuse the Phase 0 sign-in instead
  logout                    remove the saved sign-in
  folders [--create]        check (or create/rename) the Outlook section folders
  doctor                    check everything the agent needs
  paths                     show where the agent keeps its files`);
      if (cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof ConfigError || e instanceof NotSignedInError ? e.message : e);
  process.exitCode = 1;
}
