#!/usr/bin/env node
// The Broadsheet agent command line (PLAN.md §8.3). More commands arrive with each Phase 1 milestone.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { learn } from "./pipeline/affinity.ts";
import { currentProfile, profileNotDue, rebuildProfile } from "./ai/profile.ts";
import { applyReaderActions } from "./pipeline/reader-actions.ts";
import { setFormat } from "./pipeline/split.ts";
import { parsePause, pausedUntil, setPause } from "./pause.ts";
import { editSource, type SourceChanges } from "./pipeline/sources.ts";
import { looksLikeRoundup } from "./content/split.ts";
import { clearEval, loadSet, reportHtml, runModel, saveSet, savedRun, fingerprint, type EvalRun } from "./ai/eval.ts";
import { execFile } from "node:child_process";
import { SourceFormat } from "@broadsheet/shared";
import { OllamaProvider, ollamaStatus } from "./ai/ollama.ts";
import { acquireLock, keepAwakeWhileRunning, LOG_FILE, rotateLogs } from "./housekeeping.ts";
import * as launchd from "./launchd.ts";

const p = paths();
/** Which item Gemma is on, while it works; Admin's menu bar reads it. */
const PROGRESS = join(p.home, "progress.json");
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
    console.log(`     ${o.from} · source ${o.source}${o.newSource ? " (new)" : ""} · ${o.words} words${o.pieces ? ` · split into ${o.pieces} pieces` : ""}`);
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
    if (!opts.force) {
      const db = openDb(p.db);
      const until = pausedUntil(db);
      db.close();
      if (until) {
        console.log(`Paused until ${until.toLocaleString()}; nothing to do. (broadsheet pause off resumes.)`);
        return;
      }
    }
    await runLocked(opts);
  } finally {
    await rm(PROGRESS, { force: true });
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

    // Stage A: light, always runs. First, what you did in the reader since the last run.
    if (stage !== "b" && !dryRun) {
      const acts = await applyReaderActions({ db, appFolder, mail, contentDir: p.content });
      if (acts.files) console.log(`📱 ${acts.applied} reader action(s) applied from ${acts.files} file(s)${acts.ignored ? `, ${acts.ignored} for expired items ignored` : ""}.`);
      for (const e of acts.errors) console.log(`  ❌ ${e}`);
      errors.push(...acts.errors);
      counts.readerActions = acts.applied;
    }
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
      const b = await stageB({
        db, config, llm, mail, contentDir: p.content, sampleActivity, force: opts.force, limit: opts.limit, log: (l) => console.log(`🧠 ${l}`),
        onProgress: (n, total, title) => void writeFile(PROGRESS, JSON.stringify({ n, total, title, at: new Date().toISOString() })).catch(() => {}),
      });
      await rm(PROGRESS, { force: true });
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

      // About once a week, Gemma rewrites your reader profile from your ratings (while you're still away).
      if (!b.deferred && !profileNotDue(db)) {
        const may = opts.force ? ({ ok: true } as const) : aiMayRun(await sampleActivity(), config.politeness);
        if (may.ok) {
          try {
            const prof = await rebuildProfile({ db, config, llm });
            console.log(`🪞 Gemma rewrote your reader profile (version ${prof.version}, ${Math.round(prof.seconds)} s). See it with: broadsheet profile`);
            counts.profile = prof.version;
          } catch (e) {
            console.log(`  ❌ couldn't rewrite the reader profile: ${(e as Error).message}`);
            errors.push(`reader profile: ${(e as Error).message}`);
          }
        }
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
    const until = pausedUntil(db);
    if (until) console.log(`Paused until ${until.toLocaleString()} (broadsheet pause off resumes).`);
    const runs = db.prepare("SELECT started_at, stage, counts_json, deferred_reason, errors_json FROM runs ORDER BY id DESC LIMIT 5").all() as any[];
    for (const r of runs) {
      const errors = JSON.parse(r.errors_json).length;
      console.log(`  ${new Date(r.started_at).toLocaleString()}  stage ${r.stage}  ${r.counts_json}${r.deferred_reason ? `  waiting: ${r.deferred_reason}` : ""}${errors ? `  ${errors} error(s)` : ""}`);
    }
    const pending = db.prepare("SELECT count(*) n FROM items WHERE ai_status = 'pending' AND hidden_by IS NULL").get() as { n: number };
    console.log(`  ${pending.n} item(s) waiting for Gemma.`);
  });
}

/** What the Broadsheet has learned about your tastes, and the reader profile Gemma uses. */
async function profile(rebuild: boolean) {
  await withConfigAndDb(async (config, db) => {
    if (rebuild) {
      const llm = new OllamaProvider({ baseUrl: config.ai.baseUrl, model: config.ai.model, numCtx: config.ai.numCtx, temperature: config.ai.temperature });
      console.log("Gemma is writing your reader profile from your ratings…");
      const prof = await rebuildProfile({ db, config, llm });
      console.log(`Done (version ${prof.version}, ${Math.round(prof.seconds)} s).\n`);
    }
    const prof = currentProfile(db, config);
    console.log("READER PROFILE");
    if (prof.from === "learned") console.log(`Written by ${prof.model} from your ratings, ${new Date(prof.builtAt!).toLocaleDateString()} (version ${prof.version}):`);
    else if (prof.from === "yours") console.log("Your own words, from readerProfile in the config file (Gemma writes one from your ratings once there are enough):");
    else console.log("None yet. Add a few sentences as readerProfile in the config file, or rate articles and Gemma will write one.");
    if (prof.from === "learned") {
      console.log(`\n${prof.learned}\n`);
      console.log(prof.own ? `Your own words, which come first:\n\n${prof.own}\n` : "Your own words: none yet (the Rules page in the reader, In your own words).\n");
    } else if (prof.text) console.log(`\n${prof.text}\n`);
    const due = profileNotDue(db);
    console.log(due ? `Next rewrite: not yet (${due}).` : "Next rewrite: due on the next run while you're away.");

    const s = learn(db).summary();
    console.log(`\nWHAT YOUR RATINGS SAY (${s.ratings} rating${s.ratings === 1 ? "" : "s"})`);
    const show = (title: string, rows: [string, { value: number; ratings: number }][]) => {
      if (!rows.length) return;
      const fmt = ([k, a]: [string, { value: number; ratings: number }]) => `    ${a.value >= 0.5 ? "+" : "−"}${Math.abs(a.value - 0.5).toFixed(2)}  ${k} (${a.ratings})`;
      const liked = rows.filter(([, a]) => a.value > 0.5).slice(0, 8);
      const disliked = rows.filter(([, a]) => a.value < 0.5).slice(-8).reverse();
      console.log(`  ${title}:`);
      if (liked.length) console.log(["   liked:", ...liked.map(fmt)].join("\n"));
      if (disliked.length) console.log(["   disliked:", ...disliked.map(fmt)].join("\n"));
      if (!liked.length && !disliked.length) console.log("    nothing either way yet");
    };
    show("Authors", s.authors);
    show("Topics", s.topics);
    for (const [source, section] of s.hints) console.log(`  You keep moving ${source} to ${section}: its new items go there.`);
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

/** Your newsletters, how each is laid out, and which look like roundups (PLAN.md §4.4). */
async function sources() {
  await withConfigAndDb(async (_config, db) => {
    // Emails already in the paper count too, not just ones that arrive from now on.
    const current = db
      .prepare(
        `SELECT i.id, i.source_id FROM items i JOIN sources s ON s.id = i.source_id
         WHERE s.format = 'normal' AND s.looks_like IS NULL AND i.channel = 'email' AND i.kind = 'article' AND i.parent_id IS NULL`,
      )
      .all() as { id: string; source_id: string }[];
    for (const it of current) {
      const html = await readFile(join(p.content, it.id, "article.html"), "utf8").catch(() => "");
      if (html && looksLikeRoundup(html)) db.prepare("UPDATE sources SET looks_like = 'roundup' WHERE id = ?").run(it.source_id);
    }
    const rows = db
      .prepare(
        `SELECT s.id, coalesce(s.display_name, s.id) AS name, s.format, s.looks_like, s.fixed_section_id, s.status, sec.name AS section
         FROM sources s LEFT JOIN sections sec ON sec.id = s.fixed_section_id ORDER BY lower(coalesce(s.display_name, s.id))`,
      )
      .all() as any[];
    const width = Math.min(40, Math.max(...rows.map((r) => r.name.length)));
    console.log(`YOUR NEWSLETTERS (${rows.length})`);
    for (const r of rows) {
      const bits = [r.format === "normal" ? null : r.format, r.section ? `always ${r.section}` : null, r.status === "muted" ? "muted" : null].filter(Boolean);
      console.log(`  ${r.name.padEnd(width)}  ${r.id}${bits.length ? `  (${bits.join(", ")})` : ""}`);
    }
    const suggested = rows.filter((r) => r.looks_like === "roundup" && r.format === "normal");
    if (suggested.length) {
      console.log(`\nTHESE LOOK LIKE ROUNDUPS (many short stories, each under its own heading):`);
      for (const r of suggested) console.log(`  ${r.name}: broadsheet format ${r.id} roundup`);
      console.log(`Only if you want their stories as briefs; leave them alone to keep each email as one article.`);
    }
  });
}

/** Set a newsletter's format and apply it to its current emails. */
async function format(sourceId: string | undefined, value: string | undefined) {
  const parsed = SourceFormat.safeParse(value);
  if (!sourceId || !parsed.success) throw new Error("Usage: broadsheet format <newsletter id> normal|roundup|multi-section   (ids: broadsheet sources)");
  await withConfigAndDb(async (config, db) => {
    const src = db.prepare("SELECT id, coalesce(display_name, id) AS name, origin FROM sources WHERE id = ?").get(sourceId) as { name: string; origin: string } | undefined;
    if (!src) throw new Error(`No newsletter with the id "${sourceId}". See: broadsheet sources`);
    const inFile = config.sources.find((x) => x.id === sourceId);
    if (inFile?.format && inFile.format !== parsed.data) {
      throw new Error(`Your config file sets ${src.name} to "${inFile.format}". Change it there instead.`);
    }
    const now = new Date();
    const cutoff = new Date(now.getTime() - config.retention.days * 86_400_000).toISOString();
    const r = await setFormat(db, p.content, sourceId, parsed.data, cutoff, now.toISOString());
    const what = { normal: "one article per email", roundup: "each story as a brief", "multi-section": "each piece as its own article" }[parsed.data];
    console.log(`${src.name} is now "${parsed.data}": ${what}.`);
    if (r.split) console.log(`Split ${r.split} of its current email(s); Gemma reads any new pieces on the next run while you're away.`);
    if (r.joined) console.log(`Put ${r.joined} current email(s) back together.`);
    if (r.current && !r.split && !r.joined && parsed.data !== "normal") console.log(`Its current email(s) had no headings to split at, so they stay as single articles.`);
    console.log(`The paper updates on the next run (within 15 minutes).`);
  });
}

/** Change one newsletter (Admin's Sources page runs this). */
async function source(id: string | undefined) {
  const usage = "Usage: broadsheet source <id> [--name \"New name\"] [--section <section id>|none] [--format normal|roundup|multi-section] [--mute|--unmute]";
  if (!id || id.startsWith("--")) throw new Error(usage);
  const changes: SourceChanges = {};
  if (flag("name") !== undefined) changes.name = flag("name");
  if (flag("section") !== undefined) changes.section = flag("section") === "none" ? null : flag("section");
  if (flag("format") !== undefined) {
    const f = SourceFormat.safeParse(flag("format"));
    if (!f.success) throw new Error(usage);
    changes.format = f.data;
  }
  if (has("mute")) changes.muted = true;
  if (has("unmute")) changes.muted = false;
  if (!Object.keys(changes).length) throw new Error(usage);
  await withConfigAndDb(async (config, db) => {
    const inFile = config.sources.find((x) => x.id === id);
    const now = new Date();
    const r = await editSource(db, new Mail(services(config).graph), id, changes, {
      contentDir: p.content,
      cutoff: new Date(now.getTime() - config.retention.days * 86_400_000).toISOString(),
      now: now.toISOString(),
    });
    console.log(r.changed.length ? `Changed: ${r.changed.join("; ")}.` : "Nothing to change.");
    if (r.moved) console.log(`Moved ${r.moved} current email(s) to the new section's folder.`);
    for (const e of r.errors) console.log(`  ❌ ${e}`);
    if (inFile) console.log("(It's also in your config file: editing it there would overwrite these changes.)");
    if (r.errors.length) process.exitCode = 1;
  });
}

/** Pause scheduled runs (Admin's menu bar does the same). */
async function pause(arg: string | undefined) {
  if (!arg) throw new Error("Usage: broadsheet pause 30m|1h|tomorrow|off");
  const db = openDb(p.db);
  try {
    const until = parsePause(arg);
    setPause(db, until);
    console.log(until ? `Paused until ${until.toLocaleString()}. Scheduled runs do nothing until then; broadsheet pause off resumes.` : "Resumed: the next scheduled run works as usual.");
  } finally {
    db.close();
  }
}

/** Compare models on saved newsletters (P6). */
async function evalCmd(sub: string | undefined, o: { count?: number; model?: string; against?: string; limit?: number; rerun: boolean; open: boolean }) {
  await withConfigAndDb(async (config, db) => {
    if (sub === "save") {
      const set = await saveSet(db, p.content, p.eval, o.count ?? 20);
      console.log(`Saved ${set.cases.length} newsletters as the test set (kept on this Mac until you save a new one or run: broadsheet eval clear).`);
      for (const c of set.cases) {
        const yours = [c.you.rating !== null ? "rated" : null, c.you.movedTo ? "moved" : null, c.you.hidden ? "hidden" : null].filter(Boolean).join(", ");
        console.log(`  ${c.source.padEnd(28).slice(0, 28)}  ${c.title.slice(0, 60)}${c.piece ? ` (${c.piece.kind})` : ""}${yours ? `  [you ${yours}]` : ""}`);
      }
      console.log(`\nNext: broadsheet eval   (or: broadsheet eval --against <another model>)`);
      return;
    }
    if (sub === "clear") {
      await clearEval(p.eval);
      console.log("Deleted the saved test set, its runs and comparison pages.");
      return;
    }
    if (sub) throw new Error(`Unknown: broadsheet eval ${sub}. Try: broadsheet eval save | broadsheet eval [--model M] [--against M2] | broadsheet eval clear`);

    const set = await loadSet(p.eval);
    if (!set?.cases.length) throw new Error("There's no test set yet. Save one from today's paper first: broadsheet eval save");
    const models = [o.model ?? config.ai.model, ...(o.against ? [o.against] : [])];
    for (const m of models) {
      const st = await ollamaStatus(config.ai.baseUrl, m);
      if (!st.running) throw new Error(`Ollama isn't running (${st.error}).`);
      if (!st.hasModel) throw new Error(`The model "${m}" isn't installed. Installed: ${st.models.join(", ")}.\nTo try it, download it first: ollama pull ${m}`);
    }
    const sections = db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[];
    const ctx = {
      sections,
      instructionRules: (db.prepare("SELECT id, instruction, source_id FROM rules WHERE kind = 'instruction' AND status = 'active'").all() as any[]).map((r) => ({ id: r.id, instruction: r.instruction, sourceId: r.source_id })),
      readerProfile: currentProfile(db, config).text,
      numCtx: config.ai.numCtx,
    };
    const fp = await fingerprint(set, p.eval, ctx);
    const n = Math.min(o.limit ?? set.cases.length, set.cases.length);
    const runs: EvalRun[] = [];
    for (const m of models) {
      const saved = o.rerun || o.limit ? null : await savedRun(p.eval, m, fp);
      if (saved) {
        console.log(`${m}: using its earlier run (same newsletters, same prompt). --rerun runs it again.`);
        runs.push(saved);
        continue;
      }
      console.log(`${m}: reading ${n} newsletter(s), roughly ${Math.ceil((n * 35) / 60)} minute(s)…`);
      const llm = new OllamaProvider({ baseUrl: config.ai.baseUrl, model: m, numCtx: config.ai.numCtx, temperature: config.ai.temperature });
      const wasLoaded = await llm.isLoaded().catch(() => false);
      try {
        runs.push(
          await runModel(llm, m, set, p.eval, ctx, {
            limit: o.limit,
            onItem: (i, total, c, r) => console.log(`  ${String(i).padStart(2)}/${total} ${r.ok ? "✅" : "❌"} ${c.title.slice(0, 60)} (${Math.round(r.seconds)} s)${r.ok ? ` · ${r.data!.section}, interest ${r.data!.interest}` : `: ${r.error?.split("\n")[0]}`}`),
          }),
        );
      } finally {
        if (!wasLoaded) await llm.unload().catch(() => {});
      }
    }
    const shown = o.limit ? { ...set, cases: set.cases.slice(0, o.limit) } : set;
    const file = join(p.eval, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
    await writeFile(file, reportHtml(shown, runs, sections), { mode: 0o600 });
    console.log(`\nThe comparison: ${file}`);
    if (o.open) execFile("open", [file]);
    else console.log(`Open it with: open "${file}"`);
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
    case "profile":
      await profile(has("rebuild"));
      break;
    case "sources":
      await sources();
      break;
    case "format":
      await format(args[0], args[1]);
      break;
    case "source":
      await source(args[0]);
      break;
    case "pause":
      await pause(args[0]);
      break;
    case "eval":
      await evalCmd(args[0]?.startsWith("--") ? undefined : args[0], {
        count: flag("count") ? Number(flag("count")) : undefined,
        model: flag("model"),
        against: flag("against"),
        limit: flag("limit") ? Number(flag("limit")) : undefined,
        rerun: has("rerun"),
        open: has("open"),
      });
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
  sources                   your newsletters, their formats, and which look like roundups
  source <id> [--name "…"] [--section <id>|none] [--format …] [--mute|--unmute]
                            change one newsletter (current items and emails follow a new section)
  format <id> <format>      normal, roundup (each story a brief) or multi-section (each
                            piece its own article); applies to current emails too
  resummarize [--all]       have Gemma read again the items it dropped or failed on
                            (--all: every current item, e.g. after changing your profile)
  eval save [--count N]     keep N of today's items (default 20) as a test set for comparing models
  eval [--model M] [--against M2] [--limit N] [--rerun] [--open]
                            run the test set through a model (default: yours), or two side by
                            side, and write a comparison page; runs are reused while nothing changed
  eval clear                delete the test set, runs and pages
  profile [--rebuild]       what your ratings taught it, and the reader profile Gemma uses
                            (--rebuild: have Gemma rewrite the profile now)
  pause 30m|1h|tomorrow|off pause scheduled runs (tomorrow = until 6 a.m.); run --force still runs
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
