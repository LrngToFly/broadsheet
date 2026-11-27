// The same story in several newsletters (2026-11-27). Headlines alone miss a lot ("Fed holds rates" and "Powell
// keeps borrowing costs steady" are one story), so while you're away Gemma compares each new item with likely
// candidates from other newsletters of the last two days, and items it finds telling the same story share a
// story_id. Publishing then marks them "also in …", ranks widely covered stories a little higher, and shows
// briefs of one story once (pipeline/publish.ts, sameStoryOnce). Each item is compared once.
import { z } from "zod";
import type { Db } from "../db/db.ts";
import type { LlmProvider } from "./provider.ts";
import { extractJson } from "./enrich.ts";

/** Candidates come from this many hours either side of the item. */
export const STORY_WINDOW_HOURS = 48;
export const MAX_CANDIDATES = 8;

type Row = { id: string; source_id: string; source_name: string; title: string; summary: string | null; tags_json: string; published_at: string; story_id: string | null };

const STOP = new Set("the a an and or of to in on for with at by from as is are was were be its it this that new over after into says say amid than more most will has have had not but how why what who your their about week today".split(" "));
const words = (text: string) => new Set(text.toLowerCase().replace(/[’']s\b/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

const ROW_SQL = `SELECT i.id, i.source_id, coalesce(s.display_name, s.id) AS source_name, i.title, i.summary, i.tags_json, i.published_at, i.story_id
  FROM items i JOIN sources s ON s.id = i.source_id`;

/** Items from other newsletters near in time that share at least two words of headline or tags, best first. */
export function candidatesFor(db: Db, item: Row): Row[] {
  const t = new Date(item.published_at).getTime();
  const from = new Date(t - STORY_WINDOW_HOURS * 3_600_000).toISOString();
  const to = new Date(t + STORY_WINDOW_HOURS * 3_600_000).toISOString();
  const rows = db
    .prepare(
      `${ROW_SQL} WHERE i.id != ? AND i.source_id != ? AND i.ai_status = 'done' AND i.hidden_by IS NULL AND coalesce(i.is_article, 1) = 1
         AND i.kind != 'newsletter' AND i.published_at BETWEEN ? AND ?`,
    )
    .all(item.id, item.source_id, from, to) as Row[];
  const mine = new Set([...words(item.title), ...(JSON.parse(item.tags_json) as string[]).flatMap((tag) => [...words(tag)])]);
  return rows
    .map((r) => {
      const theirs = new Set([...words(r.title), ...(JSON.parse(r.tags_json) as string[]).flatMap((tag) => [...words(tag)])]);
      return { r, shared: [...mine].filter((w) => theirs.has(w)).length };
    })
    .filter((x) => x.shared >= 2)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.r);
}

const Reply = z.object({ same: z.array(z.number().int()) });
const line = (r: Row) => `[${r.source_name}] ${r.title}${r.summary ? ` — ${r.summary.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;

/** Which candidates report the same story as the item (not just the same topic). */
export async function sameStory(llm: LlmProvider, item: Row, candidates: Row[]): Promise<Row[]> {
  const reply = await llm.chat([
    {
      role: "system",
      content: [
        `You decide whether news items report the SAME specific story or event: the same announcement, ruling, report, deal or incident.`,
        `Items that are only about the same topic, person or company are NOT the same story.`,
        `Reply with ONLY a JSON object {"same": [numbers]} listing the numbered items that report the same story as item A, or {"same": []}.`,
      ].join("\n"),
    },
    { role: "user", content: [`A. ${line(item)}`, ``, ...candidates.map((c, n) => `${n + 1}. ${line(c)}`)].join("\n") },
  ]);
  const parsed = Reply.parse(extractJson(reply.text));
  return parsed.same.filter((n) => n >= 1 && n <= candidates.length).map((n) => candidates[n - 1]!);
}

/** Compare one item with its candidates and record what it matched. Returns the titles of the matches. */
export async function checkStory(db: Db, llm: LlmProvider, itemId: string): Promise<string[]> {
  const item = db.prepare(`${ROW_SQL} WHERE i.id = ?`).get(itemId) as Row | undefined;
  if (!item) return [];
  const candidates = candidatesFor(db, item);
  const matched = candidates.length ? await sameStory(llm, item, candidates) : [];
  // One story id for the item, its matches, and any stories they already belong to (merged).
  const members = [item, ...matched];
  const existing = [...new Set(members.map((m) => m.story_id).filter(Boolean))] as string[];
  const storyId = [...existing, ...members.map((m) => m.id)].sort()[0]!;
  if (matched.length) {
    for (const m of members) db.prepare("UPDATE items SET story_id = ? WHERE id = ?").run(storyId, m.id);
    for (const old of existing) db.prepare("UPDATE items SET story_id = ? WHERE story_id = ?").run(storyId, old);
  }
  db.prepare("UPDATE items SET story_checked = 1 WHERE id = ?").run(itemId);
  return matched.map((m) => `${m.title} (${m.source_name})`);
}
