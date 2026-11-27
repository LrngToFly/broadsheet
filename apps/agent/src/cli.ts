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
import { aiMayRun, sampleActivity } from "./activity.ts";
import { Mail } from "./microsoft/mail.ts";
import { stageAEmail, type EmailOutcome } from "./pipeline/stage-a-email.ts";
import { publish } from "./pipeline/publish.ts";
import { stageAFeeds } from "./pipeline/stage-a-feeds.ts";
import { discoverFeed } from "./feeds/feed.ts";
import { stageB } from "./pipeline/stage-b.ts";
import { OllamaProvider, ollamaStatus } from "./ai/ollama.ts";
import { acquireLock, keepAwakeWhileRunning, LOG_FILE, rotateLogs } from "./housekeeping.ts";
import * as launchd from "./launchd.ts";

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

  console.log("Schedule");
  const job = await launchd.status();
  if (job.loaded) ok(`runs every ${launchd.INTERVAL_SECONDS / 60} min in the background${job.running ? " (running now)" : ""}`);
  else note("not scheduled yet (broadsheet install)");
  const sleep = await launchd.systemSleepMinutes();
  if (sleep === 0) ok("the Mac doesn't sleep when idle, so AI work can happen while you're away");
  else if (sleep) fail(`the Mac sleeps after ${sleep} min idle, so AI work will rarely happen. System Settings → Energy → turn on "Prevent automatic sleeping when the display is off"`);

  console.log(healthy ? "\nAll checks passed." : "\nSome checks need attention (❌ above).");
  return healthy;
}

function printOutcomes(outcomes: EmailOutcome[], dryRun: boolean) {
  const verb = dryRun ? "would go to" : "→";
  for (const o of outcomes) {
    const tag = o.error ? "❌" : o.decision.action === "include" ? "📰" : o.decision.action === "hide" ? "🙈" : "↩️ ";
    console.log(`${tag} ${o.subject.slice(0, 70)}`);
    console.log(`     ${o.from} · source ${o.source}${o.newSource ? " (new)" : ""} · ${o.words} words`);
    console.log(o.error ? `     error: ${o.error}` : `     ${verb} ${o.destination} (${o.decision.why})`);
  }
}

async function run(opts: { stage?: string; dryRun: boolean; force: boolean; limit?: number }) {
  const { stage, dryRun } = opts;
  if (stage && stage !== "a" && stage !== "b") throw new Error(`Unknown stage "${stage}" (use a or b).`);
  if (dryRun && stage === "b") throw new Error("--dry-run is for stage a only.");

  // Unattended runs: one at a time, tidy logs, a timestamp for the log, and no idle sleep mid-run.
  const release = await acquireLock(join(p.home, "run.lock"));
  if (!release) {
    console.log(`${new Date().toISOString()} Another run is still working; skipping this one.`);
    return;
  }
  try {
    await rotateLogs(p.logs);
    if (!dryRun) keepAwakeWhileRunning();
    console.log(`=== ${new Date().toISOString()} run${stage ? ` --stage ${stage}` : ""}${dryRun ? " --dry-run" : ""}${opts.force ? " --force" : ""}`);
    await runLocked(opts);
  } finally {
    await release();
  }
}

async function runLocked(opts: { stage?: string; dryRun: boolean; force: boolean; limit?: number }) {
  const { stage, dryRun } = opts;
  await withConfigAndDb(async (config, db) => {
    const { graph, appFolder } = services(config);
    const mail = new Mail(graph);
    const started = new Date().toISOString();
    const errors: string[] = [];
    const counts: Record<string, unknown> = {};
    let deferred: string | null = null;

    // Stage A: light, always runs.
    if (stage !== "b") {
      const r = await stageAEmail({ mail, db, config, contentDir: p.content, dryRun });
      if (!r.outcomes.length) console.log("No new email.");
      printOutcomes(r.outcomes, dryRun);
      const c = r.counts;
      console.log(`${dryRun ? "\nDry run (nothing moved or saved): " : ""}${c.included} included, ${c.skipped} left in Inbox, ${c.hidden} hidden, ${c.newSources} new sources, ${c.errors} errors.`);
      if (dryRun) return;
      Object.assign(counts, c);
      errors.push(...r.outcomes.filter((o) => o.error).map((o) => `${o.subject}: ${o.error}`));

      for (const f of await stageAFeeds({ db, config, contentDir: p.content })) {
        console.log(`${f.error ? "❌" : "📡"} feed ${f.source}: ${f.status}${f.error ? ` (${f.error})` : ""}`);
        for (const t of f.added) console.log(`     + ${t}`);
        if (f.error) errors.push(`feed ${f.source}: ${f.error}`);
      }
    }

    // Publish now, so new items appear ("summary pending") without waiting for the AI.
    const pubA = await publish({ db, appFolder, config, contentDir: p.content, status: { lastStage: "a", deferred: null, errors } });
    console.log(`Published ${pubA.items} items (${pubA.uploadedItems} new articles, ${pubA.uploadedImages} images${pubA.pruned ? `, ${pubA.pruned} expired removed` : ""}).`);
    errors.push(...pubA.errors);

    // Stage B: AI, only when you're away (or --force).
    if (stage !== "a") {
      const llm = new OllamaProvider({ baseUrl: config.ai.baseUrl, model: config.ai.model, numCtx: config.ai.numCtx, temperature: config.ai.temperature });
      const b = await stageB({ db, config, llm, mail, contentDir: p.content, sampleActivity, force: opts.force, limit: opts.limit, log: (l) => console.log(`🧠 ${l}`) });
      deferred = b.deferred;
      for (const o of b.outcomes) console.log(`   ${o.error ? "❌" : "✅"} ${o.result} (${Math.round(o.seconds)} s)${o.error ? `: ${o.error.split("\n")[0]}` : ""}`);
      if (b.deferred) console.log(`⏸  AI work is waiting: ${b.deferred}. ${b.pendingLeft} item(s) pending.`);
      else console.log(`Gemma read ${b.outcomes.length} item(s); ${b.pendingLeft} still pending.${b.unloaded ? " Model unloaded." : ""}`);
      counts.ai = b.outcomes.length;
      errors.push(...b.outcomes.filter((o) => o.error).map((o) => `${o.title}: ${o.error}`));

      if (b.outcomes.length) {
        const pubB = await publish({ db, appFolder, config, contentDir: p.content, status: { lastStage: "b", deferred, errors } });
        console.log(`Republished ${pubB.items} items, ranked.`);
        errors.push(...pubB.errors);
      }
    }

    db.prepare("INSERT INTO runs (started_at, finished_at, stage, counts_json, deferred_reason, errors_json, model) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      started, new Date().toISOString(), stage ?? "ab", JSON.stringify(counts), deferred, JSON.stringify(errors), config.ai.model,
    );
    if (errors.length) process.exitCode = 1;
  });
}

async function installSchedule() {
  const cli = fileURLToPath(import.meta.url);
  await launchd.install({ cli, workingDir: join(here, "..", "..", ".."), logFile: join(p.logs, LOG_FILE) });
  console.log(`Installed. The agent now runs every ${launchd.INTERVAL_SECONDS / 60} minutes in the background.`);
  console.log(`  Job:  ${launchd.PLIST}\n  Log:  ${join(p.logs, LOG_FILE)}\nStop it any time with: broadsheet uninstall`);
  const sleep = await launchd.systemSleepMinutes();
  if (sleep) console.log(`\n⚠️  Your Mac sleeps after ${sleep} min of inactivity, so AI work will rarely happen. In System Settings → Energy, turn on "Prevent automatic sleeping when the display is off".`);
}

async function scheduleStatus() {
  const s = await launchd.status();
  console.log(s.loaded ? `Scheduled: every ${launchd.INTERVAL_SECONDS / 60} min${s.running ? " (running right now)" : ""}; last exit code ${s.lastExit ?? "n/a"}` : s.installed ? "Installed but not loaded. Run: broadsheet install" : "Not scheduled. Run: broadsheet install");
  await withConfigAndDb(async (_config, db) => {
    const runs = db.prepare("SELECT started_at, stage, counts_json, deferred_reason, errors_json FROM runs ORDER BY id DESC LIMIT 5").all() as any[];
    for (const r of runs) {
      const errors = JSON.parse(r.errors_json).length;
      console.log(`  ${new Date(r.started_at).toLocaleString()}  stage ${r.stage}  ${r.counts_json}${r.deferred_reason ? `  waiting: ${r.deferred_reason}` : ""}${errors ? `  ${errors} error(s)` : ""}`);
    }
    const pending = db.prepare("SELECT count(*) n FROM items WHERE ai_status = 'pending' AND hidden_by IS NULL").get() as { n: number };
    console.log(`  ${pending.n} item(s) waiting for Gemma.`);
  });
}

/** Have Gemma read current items again (after a prompt, profile or model change). */
async function resummarize(all: boolean) {
  await withConfigAndDb(async (_config, db) => {
    const where = all ? "ai_status IN ('done', 'failed')" : "ai_status = 'failed' OR (ai_status = 'done' AND is_article = 0)";
    // Rules are re-checked too, so clear hides that came from an Instruction rule (Check-rule hides stay).
    const r = db
      .prepare(
        `UPDATE items SET ai_status = 'pending', ai_attempts = 0,
           hidden_by = CASE WHEN hidden_by IN (SELECT id FROM rules WHERE kind = 'instruction') THEN NULL ELSE hidden_by END
         WHERE ${where}`,
      )
      .run();
    console.log(`${r.changes} item(s) queued for Gemma to read again. They're read on the next run while you're away.`);
  });
}

/** Find a site's feed and show its latest posts, without following it (a preview, like Admin's Follow by URL). */
async function feedCheck(url: string | undefined) {
  if (!url) throw new Error("Usage: broadsheet feed-check <site or feed address>");
  const { feedUrl, feed } = await discoverFeed(url);
  console.log(`Feed: ${feedUrl}\nTitle: ${feed.title}\n`);
  for (const e of feed.entries.slice(0, 8)) console.log(`  ${e.publishedAt.slice(0, 10)}  ${e.title}`);
  console.log(`\nTo follow it, add to "sources" in your config file:\n  { "id": "…", "channel": "feed", "url": "${url}" }`);
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
    case "run":
      await run({ stage: flag("stage"), dryRun: has("dry-run"), force: has("force"), limit: flag("limit") ? Number(flag("limit")) : undefined });
      break;
    case "resummarize":
      await resummarize(has("all"));
      break;
    case "feed-check":
      await feedCheck(args[0]);
      break;
    case "doctor":
      process.exitCode = (await doctor()) ? 0 : 1;
      break;
    case "install":
      await installSchedule();
      break;
    case "uninstall":
      console.log((await launchd.uninstall()) ? "Removed the schedule. The agent no longer runs on its own." : "There was no schedule to remove.");
      break;
    case "status":
      await scheduleStatus();
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
  run                       stage A, publish, then stage B if you're away (what launchd runs)
  run --stage a [--dry-run] file new newsletters, poll feeds, publish
                            (--dry-run shows what would happen, changes nothing)
  run --stage b [--force] [--limit N]
                            Gemma summarizes and files pending items; only while you're
                            away unless --force
  feed-check <url>          find a site's feed and preview it, without following it
  resummarize [--all]       have Gemma read again the items it dropped or failed on
                            (--all: every current item, e.g. after changing your profile)
  install                   run the agent every 15 minutes in the background (launchd)
  uninstall                 stop running it in the background
  status                    is it scheduled, and what did the last runs do
  doctor                    check everything the agent needs
  paths                     show where the agent keeps its files`);
      if (cmd) process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof ConfigError || e instanceof NotSignedInError ? e.message : e);
  process.exitCode = 1;
}
