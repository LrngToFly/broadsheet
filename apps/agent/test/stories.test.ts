import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { candidatesFor, checkStory } from "../src/ai/stories.ts";
import { sameStoryOnce } from "../src/pipeline/publish.ts";
import type { LlmProvider } from "../src/ai/provider.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  for (const s of ["a", "b", "c"]) db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES (?, 'email', ?, 'enabled', 'auto', 'x')").run(s, `Letter ${s.toUpperCase()}`);
  const add = (id: string, source: string, title: string, tags: string[], at = "2026-11-27T10:00:00Z", extra = "") =>
    db.prepare(`INSERT INTO items (id, source_id, channel, title, summary, tags_json, published_at, created_at, ai_status, is_article${extra ? ", kind" : ""}) VALUES (?, ?, 'email', ?, 'A summary.', ?, ?, 'x', 'done', 1${extra ? ", ?" : ""})`)
      .run(...([id, source, title, JSON.stringify(tags), at, ...(extra ? [extra] : [])] as any[]));
  add("fed1", "a", "Fed holds interest rates steady", ["federal reserve", "interest rates"]);
  add("fed2", "b", "Powell keeps borrowing costs unchanged", ["federal reserve", "interest rates"]);
  add("fed3", "c", "What the Fed's pause means for mortgages", ["interest rates", "mortgages"]);
  add("same", "a", "Fed holds interest rates (again, own newsletter)", ["federal reserve", "interest rates"]); // same newsletter: never a candidate
  add("old", "b", "Fed holds interest rates steady", ["federal reserve", "interest rates"], "2026-11-20T10:00:00Z"); // a week earlier
  add("garden", "b", "Frost dates move later", ["gardening"]);
  return db;
}

const llm = (answer: (user: string) => number[]): LlmProvider => ({
  id: "fake",
  chat: async (m) => ({ text: JSON.stringify({ same: answer(m.at(-1)!.content) }), promptTokens: 1, outputTokens: 1, seconds: 1 }),
  isLoaded: async () => true,
  unload: async () => {},
});

describe("the same story in several newsletters", () => {
  it("finds likely candidates: other newsletters, within two days, sharing headline or tag words", () => {
    const db = setup();
    const fed1 = db.prepare("SELECT i.*, 'A' AS source_name FROM items i WHERE id = 'fed1'").get() as any;
    expect(candidatesFor(db, fed1).map((r) => r.id).sort()).toEqual(["fed2", "fed3"]);
  });

  it("records Gemma's matches as one story, merging stories it links up, and checks each item once", async () => {
    const db = setup();
    // Gemma says fed2 is the same story as fed1, but fed3 (an explainer) isn't.
    const asked: string[] = [];
    const gemma = llm((user) => (asked.push(user), user.includes("Powell keeps") ? [user.split("\n").findIndex((l) => l.includes("Powell")) - 1] : []));
    expect(await checkStory(db, gemma, "fed1")).toEqual(["Powell keeps borrowing costs unchanged (Letter B)"]);
    const story = (id: string) => (db.prepare("SELECT story_id, story_checked FROM items WHERE id = ?").get(id) as any);
    expect(story("fed1")).toEqual({ story_id: "fed1", story_checked: 1 });
    expect(story("fed2").story_id).toBe("fed1");
    expect(story("fed3").story_id).toBeNull();
    expect(asked[0]).toMatch(/^A\. \[Letter A\] Fed holds interest rates steady/);

    // Nothing in common with anything: no question asked, but checked.
    const before = asked.length;
    expect(await checkStory(db, gemma, "garden")).toEqual([]);
    expect(asked.length).toBe(before);
    expect(story("garden")).toEqual({ story_id: null, story_checked: 1 });
  });
});

describe("publishing a widely covered story", () => {
  const card = (id: string, source: string, score: number, kind: "article" | "brief" = "article") => ({ id, title: `Title ${id}`, source, score, kind, alsoIn: [] as string[], publishedAt: "2026-11-27T10:00:00Z" }) as any;
  it("marks also-in and boosts by coverage; one brief per story, briefs and articles together allowed", () => {
    const cards = [card("a1", "A", 0.5), card("b1", "B", 0.6, "brief"), card("c1", "C", 0.4, "brief"), card("x", "A", 0.7)];
    const extra = new Map([
      ["a1", { links: [], sender: null, piece: false, storyId: "s1" }],
      ["b1", { links: [], sender: null, piece: true, storyId: "s1" }],
      ["c1", { links: [], sender: null, piece: true, storyId: "s1" }],
      ["x", { links: [], sender: null, piece: false, storyId: null }],
    ]);
    const out = sameStoryOnce(cards, extra, 0.03);
    // b1 and c1 are briefs of one story: the better one stays; the article a1 stays too. Each gets +0.06 (two other newsletters).
    expect(out.map((c) => [c.id, c.score, c.alsoIn])).toEqual([
      ["x", 0.7, []],
      ["b1", 0.66, ["A", "C"]],
      ["a1", 0.56, ["B", "C"]],
    ]);
  });

  it("counts at most four extra newsletters", () => {
    const cards = ["A", "B", "C", "D", "E", "F", "G"].map((s, i) => card(`i${i}`, s, 0.1));
    const extra = new Map(cards.map((c) => [c.id, { links: [], sender: null, piece: false, storyId: "big" }]));
    expect(sameStoryOnce(cards, extra, 0.03)[0]!.score).toBe(0.22);
  });
});

describe("dates aren't a story", () => {
  it("doesn't match two newsletters only because their headlines are the same date", () => {
    const card = (id: string, source: string, title: string) => ({ id, title, source, score: 0.5, kind: "article", alsoIn: [] as string[], publishedAt: "2026-11-27T10:00:00Z" }) as any;
    const cards = [card("a", "Letters", "November 26, 2026"), card("b", "Market Notes", "Weekly Charts: November 26, 2026")];
    const extra = new Map(cards.map((c) => [c.id, { links: [], sender: null, piece: false, storyId: null }]));
    expect(sameStoryOnce(cards, extra, 0.03).map((c) => c.alsoIn)).toEqual([[], []]);
  });
});
