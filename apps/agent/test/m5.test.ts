import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { buildMessages, enrich, maxArticleChars } from "../src/ai/enrich.ts";
import type { ChatMessage, LlmProvider } from "../src/ai/provider.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { score } from "../src/pipeline/ranking.ts";
import { publish } from "../src/pipeline/publish.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import type { ActivitySample } from "../src/activity.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const config = Config.parse({
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  rules: [{ id: "no-course-ads", kind: "instruction", wording: "No course ads", instruction: "Hide course ads.", mail: "deleted-items" }],
  readerProfile: "Likes gardening and markets.",
});

const reply = (o: Record<string, unknown> = {}) =>
  JSON.stringify({
    is_article: true, summary: "A neutral summary of a gardening post about tomatoes.", key_points: ["Tomatoes"], section: "gardening",
    tags: ["tomatoes"], interest: 80, why_its_here: "You like gardening.", read_minutes: 3, hidden_by_rule: null, ...o,
  });

/** A fake model that answers from a script, and records what it was asked. */
function fakeLlm(script: string[], loaded = false) {
  const asked: ChatMessage[][] = [];
  let unloaded = 0;
  const llm: LlmProvider = {
    id: "fake:model",
    chat: async (messages) => {
      asked.push(structuredClone(messages));
      return { text: script.shift() ?? reply(), promptTokens: 100, outputTokens: 50, seconds: 1 };
    },
    isLoaded: async () => loaded,
    unload: async () => void unloaded++,
  };
  return { llm, asked, unloads: () => unloaded };
}

const sections = [
  { id: "gardening", name: "Gardening" },
  { id: "everything-else", name: "Everything Else" },
];
const ctx = { sections, instructionRules: [{ id: "no-course-ads", instruction: "Hide course ads.", sourceId: null }], sourceId: "s", readerProfile: "Likes gardening.", numCtx: 16384 };
const item = { title: "Tomatoes", source: "Garden Letter", author: "Ann", text: "Tomatoes ripen late. ".repeat(50), fixedSection: null };

describe("asking Gemma", () => {
  it("puts the schema, sections, rules and reader profile in the prompt, and cuts very long posts", () => {
    const { messages } = buildMessages(item, ctx);
    expect(messages[0]!.content).toMatch(/"hidden_by_rule"/);
    expect(messages[0]!.content).toContain("- gardening: Gardening");
    expect(messages[0]!.content).toContain("- no-course-ads: Hide course ads.");
    expect(messages[0]!.content).toContain("Likes gardening.");
    const long = buildMessages({ ...item, text: "x".repeat(maxArticleChars(16384) + 10) }, ctx);
    expect(long.truncated).toBe(true);
    expect(long.messages[1]!.content).toContain("cut for length");
  });

  it("accepts a code-fenced reply, and retries once with the problem when the reply is wrong", async () => {
    const ok = await enrich(fakeLlm(["```json\n" + reply() + "\n```"]).llm, item, ctx);
    expect(ok).toMatchObject({ ok: true, attempts: 1 });

    const f = fakeLlm([reply({ section: "sports" }), reply()]);
    const retried = await enrich(f.llm, item, ctx);
    expect(retried).toMatchObject({ ok: true, attempts: 2 });
    expect(f.asked[1]!.at(-1)!.content).toMatch(/doesn't match the schema/);

    const bad = await enrich(fakeLlm(["not json", "still not json"]).llm, item, ctx);
    expect(bad).toMatchObject({ ok: false, attempts: 2 });
  });
});

describe("Stage B", () => {
  const away: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };
  const here: ActivitySample = { ...away, idleSeconds: 5 };

  function setup() {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
    db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
    db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('s', 'email', 'Garden Letter', 'enabled', 'auto', 'x')").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-b-"));
    for (const [id, published] of [["one", "2026-11-27T10:00:00Z"], ["two", "2026-11-27T09:00:00Z"]] as const) {
      db.prepare(`INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, published_at, created_at) VALUES (?, 's', 'email', ?, 'SORT', ?, ?, 'x')`).run(id, `m-${id}`, `Post ${id}`, published);
      mkdirSync(join(contentDir, id), { recursive: true });
      writeFileSync(join(contentDir, id, "article.txt"), "Tomatoes ripen late.");
    }
    const moves: [string, string][] = [];
    const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
    return { db, contentDir, mail, moves };
  }

  it("waits while you're using the Mac", async () => {
    const { db, contentDir, mail } = setup();
    const f = fakeLlm([]);
    const r = await stageB({ db, config, llm: f.llm, mail, contentDir, sampleActivity: async () => here });
    expect(r.deferred).toMatch(/you're active/);
    expect(f.asked).toHaveLength(0);
  });

  it("summarizes, files each email into its section folder, and unloads the model afterwards", async () => {
    const { db, contentDir, mail, moves } = setup();
    const f = fakeLlm([reply(), reply({ section: "everything-else", interest: 20 })]);
    const r = await stageB({ db, config, llm: f.llm, mail, contentDir, sampleActivity: async () => away });
    expect(r).toMatchObject({ deferred: null, pendingLeft: 0, unloaded: true });
    expect(moves).toEqual([["m-one", "F-gardening"], ["m-two", "F-everything-else"]]);
    expect(db.prepare("SELECT section_id, section_source, ai_status, interest, model FROM items WHERE id = 'one'").get()).toEqual({
      section_id: "gardening", section_source: "ai", ai_status: "done", interest: 80, model: "fake:model",
    });
    expect(f.unloads()).toBe(1);
  });

  it("stops after the current item when you come back, and leaves a model it didn't load", async () => {
    const { db, contentDir, mail } = setup();
    const f = fakeLlm([], true);
    const samples = [away, here];
    const r = await stageB({ db, config, llm: f.llm, mail, contentDir, sampleActivity: async () => samples.shift()! });
    expect(r.outcomes).toHaveLength(1);
    expect(r.deferred).toMatch(/you're active/);
    expect(r.pendingLeft).toBe(1);
    expect(f.unloads()).toBe(0);
  });

  it("hides what an Instruction rule catches, and gives up on an item after 3 failed tries", async () => {
    const { db, contentDir, mail, moves } = setup();
    const f = fakeLlm([reply({ hidden_by_rule: "no-course-ads" }), "junk", "junk"]);
    await stageB({ db, config, llm: f.llm, mail, contentDir, sampleActivity: async () => away });
    expect(db.prepare("SELECT hidden_by FROM items WHERE id = 'one'").get()).toEqual({ hidden_by: "no-course-ads" });
    expect(moves).toEqual([["m-one", "deleteditems"]]);

    for (let i = 0; i < 2; i++) await stageB({ db, config, llm: fakeLlm(["junk", "junk"]).llm, mail, contentDir, sampleActivity: async () => away });
    expect(db.prepare("SELECT ai_status, ai_attempts FROM items WHERE id = 'two'").get()).toEqual({ ai_status: "failed", ai_attempts: 3 });
  });

  it("re-files an email the AI filed before when it changes its mind, but not one in another folder", async () => {
    const { db, contentDir, mail, moves } = setup();
    db.prepare("UPDATE items SET section_id = 'everything-else', section_source = 'ai', mail_folder_id = 'F-everything-else' WHERE id = 'one'").run();
    db.prepare("UPDATE items SET section_id = 'everything-else', section_source = 'ai', mail_folder_id = 'SOMEWHERE-ELSE' WHERE id = 'two'").run();
    await stageB({ db, config, llm: fakeLlm([reply(), reply()]).llm, mail, contentDir, sampleActivity: async () => away });
    expect(moves).toEqual([["m-one", "F-gardening"]]);
  });

  it("keeps a fixed section even if Gemma suggests another", async () => {
    const { db, contentDir, mail, moves } = setup();
    db.prepare("UPDATE items SET section_id = 'gardening', section_source = 'fixed' WHERE id = 'one'").run();
    await stageB({ db, config, llm: fakeLlm([reply({ section: "everything-else" })]).llm, mail, contentDir, sampleActivity: async () => away, limit: 1 });
    expect(db.prepare("SELECT section_id, section_source FROM items WHERE id = 'one'").get()).toEqual({ section_id: "gardening", section_source: "fixed" });
    expect(moves).toEqual([["m-one", "F-gardening"]]);
  });
});

describe("ranking and cleanup", () => {
  it("ranks interesting, fresh items first", () => {
    const fresh = score({ publishedAt: "2026-11-27T12:00:00Z", interest: 90 }, NOW, config);
    const dull = score({ publishedAt: "2026-11-27T12:00:00Z", interest: 10 }, NOW, config);
    const old = score({ publishedAt: "2026-11-24T12:00:00Z", interest: 90 }, NOW, config);
    expect(fresh).toBeGreaterThan(dull);
    expect(fresh).toBeGreaterThan(old);
  });

  it("removes expired items and unused images everywhere, and writes status.json", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, status, origin, created_at) VALUES ('s', 'email', 'enabled', 'auto', 'x')").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-prune-"));
    for (const [id, published, imgs] of [["keep", "2026-11-27T10:00:00Z", ["images/a.png"]], ["old", "2026-11-01T10:00:00Z", ["images/b.png"]]] as const) {
      db.prepare(`INSERT INTO items (id, source_id, channel, title, published_at, created_at, content_published, images_json) VALUES (?, 's', 'email', ?, ?, 'x', 1, ?)`).run(id, id, published, JSON.stringify(imgs));
      mkdirSync(join(contentDir, id), { recursive: true });
    }
    const files = new Set(["images/a.png", "images/b.png", "images/c.png", "items/keep.html", "items/old.html"]);
    const json: Record<string, unknown> = {};
    const appFolder = {
      put: async (p: string) => (files.add(p), { id: p, size: 1 }),
      putJson: async (p: string, v: unknown) => ((json[p] = v), { id: p, size: 1 }),
      delete: async (p: string) => void files.delete(p),
      list: async (folder: string) => [...files].filter((f) => f.startsWith(`${folder}/`)).map((f) => f.slice(folder.length + 1)),
    };
    const r = await publish({ db, appFolder, config, contentDir, now: NOW, status: { lastStage: "a", deferred: null, errors: [] } });
    expect(r).toMatchObject({ items: 1, pruned: 1, prunedImages: 2 });
    expect([...files].sort()).toEqual(["images/a.png", "items/keep.html"]);
    expect(existsSync(join(contentDir, "old"))).toBe(false);
    expect(json["status.json"]).toMatchObject({ lastStage: "a", pending: 1, model: "gemma4:12b" });
  });
});
