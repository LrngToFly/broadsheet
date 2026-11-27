import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { ratingExamples, SCORING_GUIDE, scoringProfile } from "../src/ai/profile.ts";
import { buildMessages } from "../src/ai/enrich.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });

describe("scoring interest", () => {
  it("gives Gemma your recent ratings as examples, with your reasons, from the first rating", () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    expect(scoringProfile(db, config)).toBe("");
    db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('pn', 'email', 'Civic Desk', 'enabled', 'auto', 'x')").run();
    const rec = (id: string, title: string, rating: number | null, note: string | null, at: string, hidden: string | null = null) =>
      db.prepare("INSERT INTO preference_records (item_id, source_id, title, published_at, rating, rating_note, hidden_reason, updated_at) VALUES (?, 'pn', ?, 'x', ?, ?, ?, ?)").run(id, title, rating, note, hidden, at);
    rec("feud", "A celebrity feud", -1, "A distraction story", "2026-11-27T10:00:00Z");
    rec("war", "The new transit plan", 1, null, "2026-11-26T10:00:00Z");
    rec("ad", "Big sale", null, null, "2026-11-25T10:00:00Z", "ad");
    expect(ratingExamples(db)).toBe([
      "Articles they rated recently. Score similar articles the same way, but where they gave a reason, the reason matters more than the subject:",
      `- 👎 disliked: "A celebrity feud" (Civic Desk). Why: A distraction story`,
      `- 👍 liked: "The new transit plan" (Civic Desk)`,
      `- 🚫 hid: "Big sale" (Civic Desk). Why: hidden: ad`,
    ].join("\n"));
    expect(ratingExamples(db, { exclude: ["feud"] })).not.toContain("feud");
    expect(ratingExamples(db, { limit: 1 }).split("\n")).toHaveLength(2);

    db.prepare("INSERT INTO agent_state VALUES ('profile:own-words', 'Less spectacle, more policy.')").run();
    expect(scoringProfile(db, config)).toMatch(/^Less spectacle, more policy\.\n\nArticles they rated recently/);
  });

  it("puts the scoring scale and the reader in the prompt, and asks for the reason before the score", () => {
    const { messages } = buildMessages(
      { title: "T", source: "S", author: null, text: "Words.", fixedSection: null },
      { sections: [{ id: "everything-else", name: "Everything Else" }], instructionRules: [], sourceId: "s", readerProfile: "Likes gardens.", numCtx: 8192 },
    );
    const system = messages[0]!.content;
    expect(system).toContain(SCORING_GUIDE);
    expect(system).toContain("The reader:\nLikes gardens.");
    expect(system.indexOf('"why_its_here"')).toBeLessThan(system.indexOf('"interest"'));
  });
});
