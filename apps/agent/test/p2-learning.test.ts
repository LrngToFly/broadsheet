import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig, type Db } from "../src/db/db.ts";
import { learn } from "../src/pipeline/affinity.ts";
import { scoreParts } from "../src/pipeline/ranking.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { buildProfileMessages, currentProfile, profileNotDue, rebuildProfile } from "../src/ai/profile.ts";
import type { LlmProvider } from "../src/ai/provider.ts";
import type { ActivitySample } from "../src/activity.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" }, readerProfile: "I garden and save for retirement." });

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO agent_state VALUES ('folder:_sorting', 'SORT')").run();
  for (const s of ["garden", "markets", "brand-new"]) {
    db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES (?, 'email', ?, 'enabled', 'auto', 'x')").run(s, `The ${s} letter`);
  }
  return db;
}

let n = 0;
function record(db: Db, r: { source: string; author?: string; tags?: string[]; section?: string; rating?: number | null; movedTo?: string; at?: string }) {
  db.prepare(
    `INSERT INTO preference_records (item_id, source_id, author, section_id, tags_json, title, published_at, rating, moved_to_section, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`r${++n}`, r.source, r.author ?? null, r.section ?? null, JSON.stringify(r.tags ?? []), `Post ${n}`, "2026-11-20T00:00:00Z", r.rating ?? null, r.movedTo ?? null, r.at ?? "2026-11-26T00:00:00Z");
}

const input = (o: Partial<Parameters<typeof scoreParts>[0]> = {}) => ({
  publishedAt: "2026-11-27T10:00:00Z", interest: 60, sourceId: "garden", author: null, tags: [], section: "gardening", ...o,
});

describe("learning from your ratings", () => {
  it("learns authors (falling back to the source) and topics, smoothed toward neutral", () => {
    const db = setup();
    for (let i = 0; i < 4; i++) record(db, { source: "garden", author: "Ann", tags: ["tomatoes"], section: "gardening", rating: 1 });
    for (let i = 0; i < 4; i++) record(db, { source: "markets", author: "Bob", tags: ["crypto"], section: "financial", rating: -1 });
    record(db, { source: "markets", author: "Cy", tags: ["index funds"], section: "financial", rating: 1 });
    const l = learn(db, NOW);

    const ann = l.author({ sourceId: "garden", author: "ann " });
    expect(ann.value).toBeGreaterThan(0.75);
    expect(ann.value).toBeLessThan(1); // never certain
    expect(l.author({ sourceId: "markets", author: "Bob" }).value).toBeLessThan(0.25);
    expect(l.author({ sourceId: "garden", author: "Someone new" }).value).toBeGreaterThan(0.5); // the source's record
    expect(l.author({ sourceId: "brand-new", author: null })).toEqual({ value: 0.5, confidence: 0, ratings: 0 });

    expect(l.topic({ tags: ["Tomatoes"], section: null }).value).toBeGreaterThan(0.7);
    expect(l.topic({ tags: ["crypto"], section: "financial" }).value).toBeLessThan(0.3);
    expect(l.topic({ tags: ["index funds"], section: null }).value).toBeGreaterThan(0.5);
    expect(l.topic({ tags: ["unheard of"], section: null }).confidence).toBe(0);
    expect(l.ratedFromSource("markets")).toBe(5);
  });

  it("counts old ratings for less, so it follows your tastes as they change", () => {
    const db = setup();
    for (let i = 0; i < 3; i++) record(db, { source: "markets", author: "Bob", rating: 1, at: "2025-05-01T00:00:00Z" });
    for (let i = 0; i < 3; i++) record(db, { source: "markets", author: "Bob", rating: -1, at: "2026-11-26T00:00:00Z" });
    expect(learn(db, NOW).author({ sourceId: "markets", author: "Bob" }).value).toBeLessThan(0.45);
  });

  it("ranks what you like above what you don't, and gives unrated sources a small boost", () => {
    const db = setup();
    for (let i = 0; i < 6; i++) record(db, { source: "garden", author: "Ann", tags: ["tomatoes"], section: "gardening", rating: 1 });
    for (let i = 0; i < 6; i++) record(db, { source: "markets", author: "Bob", tags: ["crypto"], section: "financial", rating: -1 });
    const l = learn(db, NOW);

    const liked = scoreParts(input({ author: "Ann", tags: ["tomatoes"] }), NOW, config, l);
    const disliked = scoreParts(input({ sourceId: "markets", author: "Bob", tags: ["crypto"], section: "financial" }), NOW, config, l);
    expect(liked.score).toBeGreaterThan(disliked.score + 0.2);
    expect(liked.exploration).toBe(0);

    // Same Gemma interest, nothing known: a new source gets the exploration bonus.
    const fresh = scoreParts(input({ sourceId: "brand-new", tags: ["bees"], section: "outdoors" }), NOW, config, l);
    expect(fresh.exploration).toBeCloseTo(config.ranking.exploration);
    expect(fresh.topic).toBe(0.5);
    expect(fresh.relevance).toBeCloseTo(0.6); // all Gemma, since nothing is learned about these tags

    // Gemma's interest still matters when your ratings know the topic well.
    const dull = scoreParts(input({ author: "Ann", tags: ["tomatoes"], interest: 10 }), NOW, config, l);
    expect(dull.score).toBeLessThan(liked.score);
  });

  it("suggests a section once you've moved a source's items there twice in a row", () => {
    const db = setup();
    record(db, { source: "garden", movedTo: "outdoors", at: "2026-11-20T00:00:00Z" });
    expect(learn(db).sectionHint("garden")).toBeNull();
    record(db, { source: "garden", movedTo: "outdoors", at: "2026-11-21T00:00:00Z" });
    expect(learn(db).sectionHint("garden")).toBe("outdoors");
    record(db, { source: "garden", movedTo: "gardening", at: "2026-11-22T00:00:00Z" }); // changed your mind
    expect(learn(db).sectionHint("garden")).toBeNull();
  });
});

describe("Stage B with what it learned", () => {
  const away: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };
  const reply = JSON.stringify({
    is_article: true, summary: "A neutral summary of a post about trails.", key_points: [], section: "gardening", tags: ["trails"], interest: 50, why_its_here: "x", read_minutes: 2, hidden_by_rule: null,
  });
  const llm = (asked: string[] = []): LlmProvider => ({
    id: "fake:model",
    chat: async (m) => (asked.push(m[0]!.content), { text: reply, promptTokens: 1, outputTokens: 1, seconds: 1 }),
    isLoaded: async () => true,
    unload: async () => {},
  });

  it("files a source where you keep moving it, keeps your own moves, and uses the learned profile", async () => {
    const db = setup();
    record(db, { source: "garden", movedTo: "outdoors" });
    record(db, { source: "garden", movedTo: "outdoors" });
    db.prepare("INSERT INTO reader_profiles VALUES (1, 'The reader loves long walks and gardens, from the ratings.', 'x', 'fake', 9)").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-p2b-"));
    for (const [id, source, folder] of [["new", null, "SORT"], ["mine", "user", "F-technology"]] as const) {
      db.prepare(`INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, published_at, section_id, section_source, created_at)
                  VALUES (?, 'garden', 'email', ?, ?, ?, '2026-11-27T10:00:00Z', ?, ?, 'x')`).run(id, `m-${id}`, folder, id, source ? "technology" : null, source);
      mkdirSync(join(contentDir, id), { recursive: true });
      writeFileSync(join(contentDir, id, "article.txt"), "Trails.");
    }
    const moves: [string, string][] = [];
    const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id, to) => (moves.push([id, to]), id), markRead: async () => {} };
    const asked: string[] = [];
    await stageB({ db, config, llm: llm(asked), mail, contentDir, sampleActivity: async () => away });

    expect(db.prepare("SELECT id, section_id, section_source FROM items ORDER BY id").all()).toEqual([
      { id: "mine", section_id: "technology", section_source: "user" }, // read again, but your move stands
      { id: "new", section_id: "outdoors", section_source: "learned" },
    ]);
    expect(moves).toEqual([["m-new", "F-outdoors"]]);
    expect(asked[0]).toContain("loves long walks");
  });
});

describe("the reader profile", () => {
  it("starts from your own words, ignoring the example text", () => {
    const db = setup();
    expect(currentProfile(db, config)).toEqual({ text: "I garden and save for retirement.", from: "yours" });
    expect(currentProfile(db, { readerProfile: "Write a few sentences about what you like to read, e.g. …" }).from).toBe("none");
  });

  it("is written once there are enough ratings, then weekly when there are new ones; the last 4 are kept", async () => {
    const db = setup();
    for (let i = 0; i < 7; i++) record(db, { source: "garden", author: "Ann", tags: ["tomatoes"], section: "gardening", rating: 1 });
    expect(profileNotDue(db, NOW)).toMatch(/7 of 8/);
    record(db, { source: "markets", author: "Bob", tags: ["crypto"], section: "financial", rating: -1 });
    expect(profileNotDue(db, NOW)).toBeNull();

    const { messages } = buildProfileMessages(db, config, [{ id: "gardening", name: "Gardening" }]);
    expect(messages[0]!.content).toContain("I garden and save for retirement.");
    expect(messages[1]!.content).toMatch(/liked \(👍\):\n- "Post \d+" \(The garden letter, by Ann; Gardening; tomatoes\)/);
    expect(messages[1]!.content).toMatch(/disliked \(👎\):\n- "Post \d+" \(The markets letter, by Bob; no section; crypto\)/);

    const text = "The reader enjoys practical vegetable gardening, especially tomatoes, and writing by Ann. ".repeat(4);
    let unloaded = 0;
    const fake: LlmProvider = { id: "fake:model", chat: async () => ({ text: "Reader profile: " + text, promptTokens: 1, outputTokens: 1, seconds: 3 }), isLoaded: async () => false, unload: async () => void unloaded++ };
    for (let i = 0; i < 6; i++) await rebuildProfile({ db, config, llm: fake, now: NOW });
    expect(currentProfile(db, config)).toMatchObject({ from: "learned", version: 6, text: text.trim() });
    expect(db.prepare("SELECT group_concat(version) v FROM reader_profiles").get()).toEqual({ v: "3,4,5,6" });
    expect(unloaded).toBe(6);

    expect(profileNotDue(db, new Date("2026-11-30T12:00:00Z"))).toMatch(/3 day/);
    expect(profileNotDue(db, new Date("2026-12-05T12:00:00Z"))).toMatch(/0 new rating/);
    for (let i = 0; i < 3; i++) record(db, { source: "garden", rating: 1 });
    expect(profileNotDue(db, new Date("2026-12-05T12:00:00Z"))).toBeNull();
  });

  it("refuses a reply that isn't a profile", async () => {
    const db = setup();
    record(db, { source: "garden", rating: 1 });
    const fake: LlmProvider = { id: "f", chat: async () => ({ text: "OK!", promptTokens: 1, outputTokens: 1, seconds: 1 }), isLoaded: async () => true, unload: async () => {} };
    await expect(rebuildProfile({ db, config, llm: fake })).rejects.toThrow(/too short/);
    expect(currentProfile(db, config).from).toBe("yours");
  });
});
