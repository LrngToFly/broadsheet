import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionsFile, Config, Edition } from "@broadsheet/shared";
import { applyReaderActions } from "../src/pipeline/reader-actions.ts";
import { publish } from "../src/pipeline/publish.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { learn } from "../src/pipeline/affinity.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";
import type { LlmProvider } from "../src/ai/provider.ts";
import type { ActivitySample } from "../src/activity.ts";

const config = Config.parse({
  microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
  rules: [{ id: "no-live-video", kind: "instruction", wording: "No live-video posts", instruction: "Hide posts that are only a link to a live video.", mail: "deleted-items" }],
});
const NOW = new Date("2026-11-27T12:00:00Z");

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE rules SET status = 'active'").run();
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
  db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('s', 'email', 'Garden Letter', 'enabled', 'auto', 'x')").run();
  const contentDir = mkdtempSync(join(tmpdir(), "bs-p3-"));
  const add = (id: string, extra: string, values: unknown[] = []) => {
    db.prepare(
      `INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, author, published_at, section_id, section_source, tags_json, created_at, content_published, ai_status, summary, interest, is_article${extra ? `, ${extra}` : ""})
       VALUES (?, 's', 'email', ?, ?, ?, 'Ann', '2026-11-27T10:00:00Z', 'gardening', 'ai', '["tomatoes"]', 'x', 1, 'done', 'A summary of the post.', 70, 1${values.map(() => ", ?").join("")})`,
    ).run(id, `m-${id}`, "F-gardening", `Post ${id}`, ...(values as any[]));
    mkdirSync(join(contentDir, id), { recursive: true });
    writeFileSync(join(contentDir, id, "article.html"), "<p>x</p>");
    writeFileSync(join(contentDir, id, "article.txt"), "x");
  };

  const files = new Map<string, unknown>();
  let edition: Edition | undefined;
  const appFolder = {
    list: async (folder: string) => [...files.keys()].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)),
    getJson: async <T>(path: string) => files.get(path) as T,
    delete: async (path: string) => void files.delete(path),
    put: async () => ({ id: "x", size: 1 }),
    putJson: async (path: string, v: unknown) => ((edition = path === "edition.json" ? Edition.parse(v) : edition), { id: path, size: 1 }),
  };
  const moves: [string, string][] = [];
  const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
  let n = 0;
  const send = (actions: unknown[]) =>
    files.set(`ratings/phone01-${++n}.json`, ActionsFile.parse({ schemaVersion: 1, device: "phone01", createdAt: "2026-11-27T11:00:00Z", actions }));
  const run = async () => {
    const r = await applyReaderActions({ db, appFolder, mail, now: NOW });
    await publish({ db, appFolder, config, contentDir, now: NOW });
    return r;
  };
  return { db, add, send, run, moves, mail, contentDir, edition: () => edition! };
}

describe("hiding from the reader", () => {
  it("hides an item with your reason, moves the email to Deleted Items, and lists it as hidden", async () => {
    const { db, add, send, run, moves, edition } = setup();
    add("a", "saved", [1]);
    add("b", "");
    send([
      { type: "hide", itemId: "a", reason: null, note: null, at: "2026-11-27T11:00:00Z" },
      // The reason comes a moment later, from the sheet.
      { type: "hide", itemId: "a", reason: "not-article", note: "Live-video posts are never worth it", at: "2026-11-27T11:00:05Z" },
    ]);
    const r = await run();
    expect(r).toMatchObject({ applied: 2, errors: [] });
    expect(moves).toEqual([["m-a", "deleteditems"]]); // once, not twice
    expect(db.prepare("SELECT hidden_by, hidden_reason, saved, mail_folder_id FROM items WHERE id = 'a'").get()).toEqual({
      hidden_by: "user", hidden_reason: "not-article", saved: 0, mail_folder_id: "deleteditems",
    });
    expect(db.prepare("SELECT hidden_reason, hidden_note FROM preference_records WHERE item_id = 'a'").get()).toEqual({
      hidden_reason: "not-article", hidden_note: "Live-video posts are never worth it",
    });
    expect(edition().items.map((i) => i.id)).toEqual(["b"]);
    expect(edition().hidden).toEqual([
      expect.objectContaining({ id: "a", title: "Post a", source: "Garden Letter", why: { kind: "you", reason: "not-article", note: "Live-video posts are never worth it" } }),
    ]);
  });

  it("lists items hidden by a rule or judged not an article, and Show it again brings them back for good", async () => {
    const { db, add, send, run, moves, mail, contentDir, edition } = setup();
    add("ruled", "hidden_by", ["no-live-video"]);
    db.prepare("UPDATE items SET mail_folder_id = 'deleteditems' WHERE id = 'ruled'").run();
    add("promo", "");
    db.prepare("UPDATE items SET is_article = 0 WHERE id = 'promo'").run();
    await run();
    expect(edition().items).toEqual([]);
    expect(edition().hidden.map((h) => [h.id, h.why.kind])).toEqual([["promo", "not-article"], ["ruled", "rule"]]);
    expect(edition().hidden[1]!.why).toEqual({ kind: "rule", ruleId: "no-live-video", wording: "No live-video posts" });

    send([
      { type: "unhide", itemId: "ruled", at: "2026-11-27T11:10:00Z" },
      { type: "unhide", itemId: "promo", at: "2026-11-27T11:10:01Z" },
    ]);
    await run();
    expect(moves).toEqual([["m-ruled", "F-gardening"]]); // back from Deleted Items; promo's email was never moved
    expect(edition().items.map((i) => i.id).sort()).toEqual(["promo", "ruled"]);
    expect(edition().hidden).toEqual([]);

    // Gemma reads it again and still thinks so: it stays in the paper, because you said so.
    db.prepare("UPDATE items SET ai_status = 'pending' WHERE id IN ('ruled', 'promo')").run();
    const verdict = JSON.stringify({
      is_article: false, summary: "A post that is mostly a link to a live video.", key_points: [], section: "gardening", tags: [], interest: 20, why_its_here: "x", read_minutes: 1, hidden_by_rule: "no-live-video",
    });
    const llm: LlmProvider = { id: "fake", chat: async () => ({ text: verdict, promptTokens: 1, outputTokens: 1, seconds: 1 }), isLoaded: async () => true, unload: async () => {} };
    const away: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };
    await stageB({ db, config, llm, mail, contentDir, sampleActivity: async () => away });
    expect(db.prepare("SELECT id, hidden_by, is_article FROM items ORDER BY id").all()).toEqual([
      { id: "promo", hidden_by: null, is_article: 1 },
      { id: "ruled", hidden_by: null, is_article: 1 },
    ]);
  });

  it("a Check-rule item left in the Inbox comes back to _Sorting, and Gemma reads it", async () => {
    const { db, add, send, run, moves } = setup();
    add("checked", "hidden_by", ["no-live-video"]);
    db.prepare("UPDATE items SET mail_folder_id = NULL, ai_status = 'skipped', section_id = NULL, summary = NULL WHERE id = 'checked'").run();
    send([{ type: "unhide", itemId: "checked", at: "2026-11-27T11:10:00Z" }]);
    await run();
    expect(moves).toEqual([["m-checked", "SORT"]]);
    expect(db.prepare("SELECT ai_status, mail_folder_id FROM items WHERE id = 'checked'").get()).toEqual({ ai_status: "pending", mail_folder_id: "SORT" });
  });

  it("hiding for 'Not this author' or 'Not my topic' counts against them in the ranking", async () => {
    const { db, add, send, run } = setup();
    add("a", "");
    add("b", "");
    db.prepare(`UPDATE items SET author = 'Bob', tags_json = '["crypto"]' WHERE id = 'b'`).run();
    send([
      { type: "hide", itemId: "a", reason: "author", note: null, at: "2026-11-27T11:00:00Z" },
      { type: "hide", itemId: "b", reason: "topic", note: null, at: "2026-11-27T11:00:01Z" },
    ]);
    await run();
    const l = learn(db, NOW);
    expect(l.author({ sourceId: "s", author: "Ann" }).value).toBeLessThan(0.5);
    expect(l.topic({ tags: ["crypto"], section: null }).value).toBeLessThan(0.5);
    expect(l.topic({ tags: ["tomatoes"], section: null }).value).toBe(0.5); // Ann's post: the author, not the topic
  });
});
