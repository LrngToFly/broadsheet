// The reader profile (PLAN.md §4.2, §7.1 row 6): a short description of your tastes that goes with every
// item Gemma reads, so its interest score fits you. Gemma rewrites it about once a week, while you're away,
// from your preference records (titles, sources, tags, your ratings and notes, never article text). Your own
// words ("In your own words" in the reader, or readerProfile in the config file until you've used that) always
// go with it and win where the two disagree. The last 4 versions are kept.
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

export type Profile = {
  /** What Gemma is given: your own words, then what it learned from your ratings. */
  text: string;
  from: "learned" | "yours" | "none";
  own: string;
  learned?: string;
  version?: number;
  builtAt?: string;
  model?: string;
};

/** Your own words: from the reader once you've saved them there, otherwise the config file (not its example text). */
export function ownWords(db: Db, config: Pick<Config, "readerProfile">): string {
  const saved = db.prepare("SELECT value FROM agent_state WHERE key = 'profile:own-words'").get() as { value: string } | undefined;
  if (saved) return saved.value.trim();
  const own = config.readerProfile.trim();
  return /^write a few sentences about what you like to read/i.test(own) ? "" : own;
}

/** The profile Gemma uses: your own words, and the one it learned from your ratings if there is one. */
export function currentProfile(db: Db, config: Pick<Config, "readerProfile">): Profile {
  const own = ownWords(db, config);
  const row = db.prepare("SELECT version, text, built_at, model FROM reader_profiles ORDER BY version DESC LIMIT 1").get() as
    | { version: number; text: string; built_at: string; model: string }
    | undefined;
  if (row) {
    const text = own ? `In the reader's own words (these come first):\n"${own}"\n\nWhat their ratings show:\n${row.text}` : row.text;
    return { text, from: "learned", own, learned: row.text, version: row.version, builtAt: row.built_at, model: row.model };
  }
  return own ? { text: own, from: "yours", own } : { text: "", from: "none", own };
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
    .prepare(
      `SELECT source_id, author, section_id, tags_json, title, rating, rating_note, hidden_reason, hidden_note FROM preference_records
       WHERE rating IS NOT NULL OR hidden_reason IS NOT NULL OR hidden_note IS NOT NULL ORDER BY updated_at DESC`,
    )
    .all() as {
    source_id: string; author: string | null; section_id: string | null; tags_json: string; title: string;
    rating: number | null; rating_note: string | null; hidden_reason: string | null; hidden_note: string | null;
  }[];
  const REASONS: Record<string, string> = { "not-article": "not an article", ad: "an ad or promo", topic: "not their topic", author: "not this author" };

  const line = (r: (typeof records)[number]) => {
    const tags = (JSON.parse(r.tags_json) as string[]).join(", ");
    const from = [sourceName.get(r.source_id) ?? r.source_id, r.author].filter(Boolean).join(", by ");
    const why =
      r.rating === null
        ? ` — hidden${r.hidden_reason ? `: ${REASONS[r.hidden_reason] ?? r.hidden_reason}` : ""}${r.hidden_note ? `; "${r.hidden_note}"` : ""}`
        : r.rating_note ? ` — why: "${r.rating_note}"` : "";
    return `- "${r.title}" (${from}; ${sectionName.get(r.section_id ?? "") ?? "no section"}${tags ? `; ${tags}` : ""})${why}`;
  };
  const group = (rating: number | null, heading: string) => {
    const rows = records.filter((r) => r.rating === rating).slice(0, PER_GROUP);
    return rows.length ? [heading, ...rows.map(line), ""] : [];
  };

  const own = ownWords(db, config);
  const system = [
    `You write the reader profile for "The Broadsheet", a private newspaper built from one person's newsletters.`,
    `An editor reads the profile to judge how interesting each new article will be to this reader.`,
    ``,
    `Write 120 to 220 words of plain prose, in the third person ("The reader…"). Describe:`,
    `- the subjects and kinds of writing the reader values, as specifically as the evidence allows;`,
    `- what they find only OK, and what they don't want;`,
    `- writers or newsletters they especially like or dislike.`,
    `Base it only on the ratings below; don't guess beyond them. Don't quote or list article titles.`,
    `Where the reader said why, the reason matters more than the subject: a dislike explained as "a distraction story" is about that kind of story, not the people in it.`,
    own ? `The reader described themselves like this. Keep it, and where the ratings disagree, these words win:\n"""${own}"""` : ``,
    `Reply with the profile text only: no heading, no preamble, no list.`,
  ].join("\n");
  const user = [
    ...group(1, "Articles the reader liked (👍):"),
    ...group(0, "Articles the reader found OK (👌):"),
    ...group(-1, "Articles the reader disliked (👎):"),
    ...group(null, `Articles the reader hid ("don't show things like this"):`),
  ].join("\n");
  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], ratings: records.filter((r) => r.rating !== null).length };
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
    return { ...currentProfile(db, opts.config), seconds: reply.seconds };
  } finally {
    if (!wasLoaded) await llm.unload().catch(() => {});
  }
}
