// What your ratings say about your tastes (PLAN.md §4.2), learned with plain statistics, not AI.
// Everything is computed from preference_records each time it's needed, so it always reflects your latest
// ratings, and a better method later can recompute it from the same history.
//
//   👍 = +1, 👌 = 0, 👎 = −1, and hiding for "Not this author" or "Not my topic" counts as −1. Older ratings count for less (half as much after HALF_LIFE_DAYS), so the
//   Broadsheet follows your tastes as they change.
//
// Each affinity is a value from 0 (you dislike it) through 0.5 (neutral or unknown) to 1 (you like it), and
// a confidence from 0 to 1 that grows with the number of ratings behind it.
import type { Db } from "../db/db.ts";

export const HALF_LIFE_DAYS = 180;
/** Ratings it takes before an affinity counts for half of what it could: smoothing toward neutral. */
const AUTHOR_PRIOR = 3;
const TOPIC_PRIOR = 4;
/** A section is broad, so a rating says less about it than about a tag. */
const SECTION_WEIGHT = 0.5;
/** A source needs this many ratings before it stops getting the exploration bonus. */
export const EXPLORE_UNTIL = 3;
/** Consecutive moves of a source's items to one section before its new items go there by themselves. */
export const MOVES_FOR_HINT = 2;

export type Affinity = { value: number; confidence: number; ratings: number };
const NEUTRAL: Affinity = { value: 0.5, confidence: 0, ratings: 0 };

type Tally = { sum: number; weight: number; count: number };

export type Learned = {
  /** By author if you've rated their posts, otherwise by source. */
  author(item: { sourceId: string; author: string | null }): Affinity;
  /** From the item's tags and section. */
  topic(item: { tags: string[]; section: string | null }): Affinity;
  /** How many items from this source you've rated. */
  ratedFromSource(sourceId: string): number;
  /** The section you keep moving this source's items to, if you do. */
  sectionHint(sourceId: string): string | null;
  /** For `broadsheet profile`: the strongest likes and dislikes. */
  summary(): { ratings: number; authors: [string, Affinity][]; topics: [string, Affinity][]; hints: [string, string][] };
};

const norm = (s: string) => s.trim().toLowerCase();

function affinityOf(t: Tally | undefined, prior: number): Affinity {
  if (!t || t.weight === 0) return NEUTRAL;
  const mean = t.sum / t.weight; // −1 … 1
  const confidence = t.weight / (t.weight + prior);
  return { value: 0.5 + 0.5 * mean * confidence, confidence, ratings: t.count };
}

export function learn(db: Db, now = new Date()): Learned {
  const records = db
    .prepare("SELECT source_id, author, section_id, tags_json, rating, moved_to_section, hidden_reason, updated_at FROM preference_records ORDER BY updated_at")
    .all() as { source_id: string; author: string | null; section_id: string | null; tags_json: string; rating: number | null; moved_to_section: string | null; hidden_reason: string | null; updated_at: string }[];
  const sourceNames = new Map((db.prepare("SELECT id, coalesce(display_name, id) AS name FROM sources").all() as { id: string; name: string }[]).map((s) => [s.id, s.name]));

  const authors = new Map<string, Tally>();
  const sources = new Map<string, Tally>();
  const topics = new Map<string, Tally>(); // "tag" or "§section"
  const moves = new Map<string, string[]>(); // source → sections, oldest first

  const add = (map: Map<string, Tally>, key: string, rating: number, weight: number) => {
    const t = map.get(key) ?? { sum: 0, weight: 0, count: 0 };
    t.sum += rating * weight;
    t.weight += weight;
    t.count++;
    map.set(key, t);
  };

  for (const r of records) {
    if (r.moved_to_section) moves.set(r.source_id, [...(moves.get(r.source_id) ?? []), r.moved_to_section]);
    const ageDays = Math.max(0, (now.getTime() - new Date(r.updated_at).getTime()) / 86_400_000);
    const w = 0.5 ** (ageDays / HALF_LIFE_DAYS);
    // Hiding for "Not this author" or "Not my topic" counts like a 👎 for that author or those topics.
    if (r.hidden_reason === "author") {
      if (r.author) add(authors, norm(r.author), -1, w);
      add(sources, r.source_id, -1, w);
    }
    if (r.hidden_reason === "topic") for (const tag of JSON.parse(r.tags_json) as string[]) add(topics, norm(tag), -1, w);
    if (r.rating === null) continue;
    if (r.author) add(authors, norm(r.author), r.rating, w);
    add(sources, r.source_id, r.rating, w);
    for (const tag of JSON.parse(r.tags_json) as string[]) add(topics, norm(tag), r.rating, w);
    if (r.section_id) add(topics, `§${r.section_id}`, r.rating, w * SECTION_WEIGHT);
  }

  const sectionHint = (sourceId: string) => {
    const last = (moves.get(sourceId) ?? []).slice(-MOVES_FOR_HINT);
    return last.length === MOVES_FOR_HINT && last.every((s) => s === last[0]) ? last[0]! : null;
  };

  return {
    author: ({ sourceId, author }) => {
      const byAuthor = author ? authors.get(norm(author)) : undefined;
      return affinityOf(byAuthor ?? sources.get(sourceId), AUTHOR_PRIOR);
    },
    topic: ({ tags, section }) => {
      // Pool the ratings behind every tag the item has (and its section) into one tally.
      const pooled: Tally = { sum: 0, weight: 0, count: 0 };
      for (const key of [...new Set(tags.map(norm)), ...(section ? [`§${section}`] : [])]) {
        const t = topics.get(key);
        if (!t) continue;
        pooled.sum += t.sum;
        pooled.weight += t.weight;
        pooled.count += t.count;
      }
      return affinityOf(pooled, TOPIC_PRIOR);
    },
    ratedFromSource: (sourceId) => sources.get(sourceId)?.count ?? 0,
    sectionHint,
    summary: () => {
      const ranked = (map: Map<string, Tally>, prior: number, label: (k: string) => string) =>
        [...map].map(([k, t]) => [label(k), affinityOf(t, prior)] as [string, Affinity]).sort((a, b) => b[1].value - a[1].value);
      return {
        ratings: records.filter((r) => r.rating !== null).length,
        authors: ranked(authors, AUTHOR_PRIOR, (k) => k),
        topics: ranked(topics, TOPIC_PRIOR, (k) => (k.startsWith("§") ? `section: ${k.slice(1)}` : k)),
        hints: [...moves.keys()].flatMap((s) => {
          const h = sectionHint(s);
          return h ? [[sourceNames.get(s) ?? s, h] as [string, string]] : [];
        }),
      };
    },
  };
}

/** Nothing learned yet: everything neutral. */
export const NOTHING_LEARNED: Learned = {
  author: () => NEUTRAL,
  topic: () => NEUTRAL,
  ratedFromSource: () => 0,
  sectionHint: () => null,
  summary: () => ({ ratings: 0, authors: [], topics: [], hints: [] }),
};
