// The reader profile (PLAN.md §4.2, §7.1 row 6): a short description of your tastes that goes with every
// item Gemma reads, so its interest score fits you. Gemma rewrites it about once a week, while you're away,
// from your preference records (titles, sources, tags and your ratings, never article text). It starts from
// your own words (config readerProfile), and they win where the two disagree. The last 4 versions are kept.
import type { Config } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import type { ChatMessage, LlmProvider } from "./provider.ts";

export const REBUILD_EVERY_DAYS = 7;
/** Don't write a profile from fewer ratings than this: it would be guesswork. */
export const MIN_RATINGS = 8;
/** …and don't rewrite it unless at least this many ratings are new since the last one. */
export const MIN_NEW_RATINGS = 3;
const KEEP_VERSIONS = 4;
const PER_GROUP = 40;

export type Profile = { text: string; from: "learned" | "yours" | "none"; version?: number; builtAt?: string; model?: string };

/** Your own words, unless it's still the example text from config.example.json. */
export function ownWords(config: Pick<Config, "readerProfile">): string {
  const own = config.readerProfile.trim();
  return /^write a few sentences about what you like to read/i.test(own) ? "" : own;
}

/** The profile Gemma uses: the learned one if there is one, otherwise your own words. */
export function currentProfile(db: Db, config: Pick<Config, "readerProfile">): Profile {
  const row = db.prepare("SELECT version, text, built_at, model FROM reader_profiles ORDER BY version DESC LIMIT 1").get() as
    | { version: number; text: string; built_at: string; model: string }
    | undefined;
  if (row) return { text: row.text, from: "learned", version: row.version, builtAt: row.built_at, model: row.model };
  const own = ownWords(config);
  return own ? { text: own, from: "yours" } : { text: "", from: "none" };
}

const ratedCount = (db: Db) => (db.prepare("SELECT count(*) n FROM preference_records WHERE rating IS NOT NULL").get() as { n: number }).n;

/** Is a new profile due? Returns why not, or null if it is. */
export function profileNotDue(db: Db, now = new Date()): string | null {
  const rated = ratedCount(db);
  if (rated < MIN_RATINGS) return `${rated} of ${MIN_RATINGS} ratings needed for a first profile`;
  const last = db.prepare("SELECT built_at, ratings_used FROM reader_profiles ORDER BY version DESC LIMIT 1").get() as { built_at: string; ratings_used: number } | undefined;
  if (!last) return null;
  const days = (now.getTime() - new Date(last.built_at).getTime()) / 86_400_000;
  if (days < REBUILD_EVERY_DAYS) return `last written ${Math.floor(days)} day(s) ago`;
  if (rated - last.ratings_used < MIN_NEW_RATINGS) return `only ${rated - last.ratings_used} new rating(s) since the last one`;
  return null;
}

export function buildProfileMessages(db: Db, config: Pick<Config, "readerProfile">, sections: { id: string; name: string }[]): { messages: ChatMessage[]; ratings: number } {
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));
  const sourceName = new Map((db.prepare("SELECT id, coalesce(display_name, id) AS name FROM sources").all() as { id: string; name: string }[]).map((s) => [s.id, s.name]));
  const records = db
    .prepare("SELECT source_id, author, section_id, tags_json, title, rating, moved_to_section FROM preference_records WHERE rating IS NOT NULL ORDER BY updated_at DESC")
    .all() as { source_id: string; author: string | null; section_id: string | null; tags_json: string; title: string; rating: number; moved_to_section: string | null }[];

  const line = (r: (typeof records)[number]) => {
    const tags = (JSON.parse(r.tags_json) as string[]).join(", ");
    const from = [sourceName.get(r.source_id) ?? r.source_id, r.author].filter(Boolean).join(", by ");
    return `- "${r.title}" (${from}; ${sectionName.get(r.section_id ?? "") ?? "no section"}${tags ? `; ${tags}` : ""})`;
  };
  const group = (rating: number, heading: string) => {
    const rows = records.filter((r) => r.rating === rating).slice(0, PER_GROUP);
    return rows.length ? [heading, ...rows.map(line), ""] : [];
  };

  const own = ownWords(config);
  const system = [
    `You write the reader profile for "The Broadsheet", a private newspaper built from one person's newsletters.`,
    `An editor reads the profile to judge how interesting each new article will be to this reader.`,
    ``,
    `Write 120 to 220 words of plain prose, in the third person ("The reader…"). Describe:`,
    `- the subjects and kinds of writing the reader values, as specifically as the evidence allows;`,
    `- what they find only OK, and what they don't want;`,
    `- writers or newsletters they especially like or dislike.`,
    `Base it only on the ratings below; don't guess beyond them. Don't quote or list article titles.`,
    own ? `The reader described themselves like this. Keep it, and where the ratings disagree, these words win:\n"""${own}"""` : ``,
    `Reply with the profile text only: no heading, no preamble, no list.`,
  ].join("\n");
  const user = [
    ...group(1, "Articles the reader liked (👍):"),
    ...group(0, "Articles the reader found OK (👌):"),
    ...group(-1, "Articles the reader disliked (👎):"),
  ].join("\n");
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], ratings: records.length };
}

/** Tidy Gemma's reply into the profile text, or throw if it isn't one. */
export function profileFromReply(raw: string): string {
  let text = raw.replace(/```[a-z]*\n?|```/g, "").trim();
  text = text.replace(/^(reader profile|profile)\s*:\s*/i, "").replace(/^["“]|["”]$/g, "").trim();
  if (text.length < 200) throw new Error(`the profile came back too short (${text.length} characters)`);
  if (text.length > 4000) text = text.slice(0, 4000).replace(/\s+\S*$/, "…");
  return text;
}

/** Have Gemma write a new profile from your ratings, and keep the last few. */
export async function rebuildProfile(opts: { db: Db; config: Pick<Config, "readerProfile">; llm: LlmProvider; now?: Date }): Promise<Profile & { seconds: number }> {
  const { db, llm } = opts;
  const sections = db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[];
  const { messages, ratings } = buildProfileMessages(db, opts.config, sections);
  if (!ratings) throw new Error("there are no ratings to learn from yet");

  const wasLoaded = await llm.isLoaded().catch(() => false);
  try {
    const reply = await llm.chat(messages);
    const text = profileFromReply(reply.text);
    const builtAt = (opts.now ?? new Date()).toISOString();
    const version = ((db.prepare("SELECT max(version) v FROM reader_profiles").get() as { v: number | null }).v ?? 0) + 1;
    db.prepare("INSERT INTO reader_profiles (version, text, built_at, model, ratings_used) VALUES (?, ?, ?, ?, ?)").run(version, text, builtAt, llm.id, ratings);
    db.prepare("DELETE FROM reader_profiles WHERE version <= ?").run(version - KEEP_VERSIONS);
    return { text, from: "learned", version, builtAt, model: llm.id, seconds: reply.seconds };
  } finally {
    if (!wasLoaded) await llm.unload().catch(() => {});
  }
}
