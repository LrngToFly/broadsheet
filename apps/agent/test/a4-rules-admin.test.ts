import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { parseExactRule, ruleResult, saveExactRule, testRule } from "../src/pipeline/rule-editor.ts";
import { applyActions } from "../src/pipeline/reader-actions.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
const NOW = new Date("2026-11-27T12:00:00Z");

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
  db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('tv', 'email', 'TV Letter', 'enabled', 'auto', 'x'), ('garden', 'email', 'Garden', 'enabled', 'auto', 'x')").run();
  const contentDir = mkdtempSync(join(tmpdir(), "bs-a4-"));
  const log = (key: string, o: { at: string; sender: string; subject: string; words: number; source: string; item?: string; links?: string[]; decision?: string }) =>
    db.prepare("INSERT INTO mail_log (message_key, received_at, sender, subject, word_count, links_json, source_id, decision, item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(key, o.at, o.sender, o.subject, o.words, JSON.stringify(o.links ?? []), o.source, o.decision ?? "include", o.item ?? null);
  log("1", { at: "2026-11-26T10:00:00Z", sender: "hi@tv.example", subject: "We're LIVE tonight", words: 80, source: "tv", item: "live1", links: ["https://tv.example/live/9"] });
  log("2", { at: "2026-10-20T10:00:00Z", sender: "hi@tv.example", subject: "We're live again", words: 90, source: "tv" });
  log("3", { at: "2026-11-25T10:00:00Z", sender: "hi@tv.example", subject: "A long essay", words: 2000, source: "tv" });
  log("4", { at: "2026-11-25T10:00:00Z", sender: "ann@garden.example", subject: "Live plants", words: 100, source: "garden" });
  log("old", { at: "2026-06-01T10:00:00Z", sender: "hi@tv.example", subject: "Live from June", words: 50, source: "tv" });
  // The one still in the paper, with its text.
  db.prepare("INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, published_at, word_count, sender, created_at, ai_status) VALUES ('live1', 'tv', 'email', 'm-live1', 'F-technology', 'We''re LIVE tonight', '2026-11-26T10:00:00Z', 80, 'hi@tv.example', 'x', 'done')").run();
  mkdirSync(join(contentDir, "live1"), { recursive: true });
  writeFileSync(join(contentDir, "live1", "article.txt"), "Join us on the livestream tonight.");
  writeFileSync(join(contentDir, "live1", "article.html"), '<a href="https://tv.example/live/9">watch</a>');
  const moves: [string, string][] = [];
  const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
  return { db, contentDir, mail, moves };
}

const liveVideo = { kind: "check", wording: "No live-video posts", match: "all", conditions: [{ field: "subject", op: "contains", value: "live" }, { field: "wordCount", op: "lessThan", value: 150 }], source: "tv" };

describe("exact rules from Admin", () => {
  it("gives a new rule an id from its wording, and explains a bad one", () => {
    const { db } = setup();
    expect(parseExactRule(db, liveVideo).id).toBe("no-live-video-posts");
    db.prepare("INSERT INTO rules (id, kind, wording, status, origin, updated_at) VALUES ('no-live-video-posts', 'instruction', 'x', 'active', 'admin', 'x')").run();
    expect(parseExactRule(db, liveVideo).id).toBe("no-live-video-posts-2");
    expect(() => parseExactRule(db, { ...liveVideo, conditions: [] })).toThrow(/conditions/);
    expect(() => parseExactRule(db, { ...liveVideo, conditions: [{ field: "subject", op: "matches", value: "(" }] })).toThrow(/regular expression/);
    expect(() => parseExactRule(db, { kind: "instruction", wording: "w", instruction: "i" })).toThrow();
  });

  it("can't tell about body text once an email has left the paper", () => {
    const f = { sender: "a@b.c", subject: "Hi", listId: null, links: [], wordCount: 10, text: null };
    const body = { field: "body", op: "contains", value: "x" } as const;
    const subj = { field: "subject", op: "contains", value: "hi" } as const;
    expect(ruleResult({ match: "all", conditions: [body, subj] }, f)).toBeNull();
    expect(ruleResult({ match: "all", conditions: [body, { ...subj, value: "no" }] }, f)).toBe(false);
    expect(ruleResult({ match: "any", conditions: [body, subj] }, f)).toBe(true);
    expect(ruleResult({ match: "any", conditions: [body] }, f)).toBeNull();
  });

  it("tests a rule against the last N days of mail, only for its newsletter", async () => {
    const { db, contentDir } = setup();
    const r = await testRule(db, contentDir, parseExactRule(db, liveVideo), { now: NOW, days: 90 });
    expect(r).toMatchObject({ checked: 3, days: 90, unknown: 0 });
    expect(r.matched.map((m) => m.subject)).toEqual(["We're LIVE tonight", "We're live again"]);
    const body = await testRule(db, contentDir, parseExactRule(db, { ...liveVideo, conditions: [{ field: "body", op: "contains", value: "livestream" }] }), { now: NOW, days: 90 });
    expect(body).toMatchObject({ checked: 3, unknown: 2 });
    expect(body.matched.map((m) => m.subject)).toEqual(["We're LIVE tonight"]);
    expect((await testRule(db, contentDir, parseExactRule(db, liveVideo), { now: NOW, days: 7 })).checked).toBe(2);
  });

  it("saves it, and can hide the current articles it catches", async () => {
    const { db, contentDir, mail, moves } = setup();
    const opts = { contentDir, cutoff: "2026-11-23T00:00:00Z", now: NOW.toISOString(), hideCurrent: true };
    expect(await saveExactRule(db, mail, parseExactRule(db, liveVideo), opts)).toEqual({ id: "no-live-video-posts", created: true, hid: 1 });
    expect(db.prepare("SELECT kind, match_mode, source_id, mail_action, status, origin FROM rules WHERE id = 'no-live-video-posts'").get()).toEqual({
      kind: "check", match_mode: "all", source_id: "tv", mail_action: "deleted-items", status: "active", origin: "admin",
    });
    expect(db.prepare("SELECT hidden_by FROM items WHERE id = 'live1'").get()).toEqual({ hidden_by: "no-live-video-posts" });
    expect(moves).toEqual([["m-live1", "deleteditems"]]);
    // Edited and turned off: same id, no more hiding.
    const off = parseExactRule(db, { ...liveVideo, id: "no-live-video-posts", wording: "No live video", status: "off" });
    expect(await saveExactRule(db, mail, off, opts)).toEqual({ id: "no-live-video-posts", created: false, hid: 0 });
    expect(db.prepare("SELECT wording, status, version FROM rules WHERE id = 'no-live-video-posts'").get()).toEqual({ wording: "No live video", status: "off", version: 2 });
  });

  it("applies reader-style actions from Admin", async () => {
    const { db, mail } = setup();
    const r = await applyActions({ db, mail, actions: [{ type: "own-words", text: "Less spectacle, more policy.", at: NOW.toISOString() }, { type: "hide", itemId: "live1", reason: "ad", note: null, at: NOW.toISOString() }], now: NOW });
    expect(r).toEqual({ applied: 2, ignored: 0, errors: [] });
    expect(db.prepare("SELECT value FROM agent_state WHERE key = 'profile:own-words'").get()).toEqual({ value: "Less spectacle, more policy." });
    expect(db.prepare("SELECT hidden_by, hidden_reason FROM items WHERE id = 'live1'").get()).toEqual({ hidden_by: "user", hidden_reason: "ad" });
  });
});
