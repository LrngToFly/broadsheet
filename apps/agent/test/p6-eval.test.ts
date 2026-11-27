import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { loadSet, pickCases, reportHtml, runModel, saveSet, savedRun, fingerprint, stats, clearEval } from "../src/ai/eval.ts";
import type { LlmProvider } from "../src/ai/provider.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  for (const s of ["a", "b", "c"]) db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES (?, 'email', ?, 'enabled', 'auto', 'x')").run(s, `Letter ${s.toUpperCase()}`);
  const contentDir = mkdtempSync(join(tmpdir(), "bs-p6-"));
  const add = (id: string, source: string, at: string, extra: Record<string, unknown> = {}) => {
    const cols = { id, source_id: source, channel: "email", title: `Post ${id} <b>`, published_at: at, section_id: "technology", section_source: "ai", summary: `Summary of ${id}.`, interest: 70, is_article: 1, ai_status: "done", created_at: "x", word_count: 500, model: "ollama:gemma4:12b", ...extra };
    db.prepare(`INSERT INTO items (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`).run(...(Object.values(cols) as any[]));
    mkdirSync(join(contentDir, id), { recursive: true });
    writeFileSync(join(contentDir, id, "article.txt"), `The text of post ${id}.`);
  };
  add("a1", "a", "2026-11-27T10:00:00Z");
  add("a2", "a", "2026-11-27T09:00:00Z");
  add("a3", "a", "2026-11-27T08:00:00Z", { rating: 1 }); // rated: comes first
  add("b1", "b", "2026-11-26T10:00:00Z", { section_id: "gardening", section_source: "user", rating: -1 }); // moved and rated
  add("c1", "c", "2026-11-25T10:00:00Z", { is_article: 0 });
  add("c2", "c", "2026-11-25T09:00:00Z", { is_article: 0 });
  add("c3", "c", "2026-11-25T08:00:00Z", { is_article: 0 }); // a third "not an article" is too many
  add("p", "a", "2026-11-27T11:00:00Z", { kind: "newsletter", ai_status: "skipped" }); // a split newsletter is never a case
  db.prepare("INSERT INTO preference_records (item_id, source_id, title, published_at, rating, rating_note, moved_to_section, updated_at) VALUES ('b1', 'b', 'x', 'x', -1, 'Too fluffy', 'gardening', 'x')").run();
  return { db, contentDir, evalDir: mkdtempSync(join(tmpdir(), "bs-p6-eval-")) };
}

const fake = (id: string, section: (title: string) => string, interest: (title: string) => number, calls: { n: number }): LlmProvider => ({
  id,
  chat: async (messages) => {
    calls.n++;
    const title = messages.at(-1)!.content.match(/^Title: (.*)$/m)![1]!;
    return {
      text: JSON.stringify({ is_article: true, summary: `${id} says: ${title} is about things.`, key_points: ["one"], section: section(title), tags: ["x"], interest: interest(title), why_its_here: "because", read_minutes: 2, hidden_by_rule: null }),
      promptTokens: 10, outputTokens: 50, seconds: 2,
    };
  },
  isLoaded: async () => false,
  unload: async () => {},
});

describe("broadsheet eval", () => {
  it("picks what you rated or moved first, one per newsletter before seconds, and few 'not an article's", () => {
    const { db } = setup();
    expect(pickCases(db, 20)).toEqual(["a3", "b1", "c1", "a1", "c2", "a2"]);
    expect(pickCases(db, 3)).toEqual(["a3", "b1", "c1"]);
  });

  it("saves the set with what the paper had and what you did, runs two models, and compares them", async () => {
    const { db, contentDir, evalDir } = setup();
    const set = await saveSet(db, contentDir, evalDir, 20, new Date("2026-11-27T12:00:00Z"));
    expect(set.cases).toHaveLength(6);
    const b1 = set.cases.find((c) => c.id === "b1")!;
    expect(b1.you).toEqual({ rating: -1, ratingNote: "Too fluffy", movedTo: "gardening", hidden: null });
    expect(b1.paper.section).toBeNull(); // you moved it, so the AI's own choice is gone
    expect(existsSync(join(evalDir, "set", "b1.txt"))).toBe(true);
    expect((await loadSet(evalDir))!.cases.map((c) => c.id)).toEqual(set.cases.map((c) => c.id));

    const ctx = { sections: db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as any[], instructionRules: [], readerProfile: "I like gardens.", numCtx: 8192 };
    const callsA = { n: 0 };
    const callsB = { n: 0 };
    // A scores everything 85 in Technology; B follows your moves and your ratings.
    const a = await runModel(fake("model-a", () => "technology", () => 85, callsA), "model-a", set, evalDir, ctx);
    const b = await runModel(fake("model-b", (t) => (t.includes("b1") ? "gardening" : "technology"), (t) => (t.includes("a3") ? 90 : t.includes("b1") ? 20 : 60), callsB), "model-b", set, evalDir, ctx);
    expect(callsA.n).toBe(6);

    expect(stats(set, a)).toMatchObject({ valid: 6, interestSpread: 0, ratingGap: 0, matchesYourMoves: { agree: 0, of: 1 }, matchesPaper: { agree: 5, of: 5 }, notArticles: 0, avgSeconds: 2, avgOutputTokens: 50 });
    expect(stats(set, b)).toMatchObject({ valid: 6, ratingGap: 70, matchesYourMoves: { agree: 1, of: 1 } });
    expect(stats(set, b).interestSpread).toBeGreaterThan(10);

    // A full run is kept and reused while the set and prompt are the same; a new profile means a new prompt.
    const fp = await fingerprint(set, evalDir, ctx);
    expect((await savedRun(evalDir, "model-a", fp))?.results).toHaveLength(6);
    expect(await fingerprint(set, evalDir, { ...ctx, readerProfile: "I like chips." })).not.toBe(fp);

    const html = reportHtml(set, [a, b], ctx.sections);
    expect(html).toContain("Post b1 &lt;b&gt;"); // escaped
    expect(html).toContain("You rated it 👎: “Too fluffy”");
    expect(html).toContain("You moved it to <b>Gardening</b>");
    expect(html).toContain("model-b says");
    expect(html).toMatch(/Interest: spread[\s\S]*?<td class="num">0\.0<\/td>/);

    await clearEval(evalDir);
    expect(await loadSet(evalDir)).toBeNull();
  });
});
