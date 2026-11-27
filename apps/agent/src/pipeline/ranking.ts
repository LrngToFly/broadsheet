// Ranking (PLAN.md §4.2):
//
//   score = (w_c · relevance + w_a · author + w_f · freshness) / (w_c + w_a + w_f) + exploration
//
//   relevance  Gemma's interest score (against your reader profile), blended with the topic affinity
//              learned from your ratings. The more ratings behind the tags, the more the learned part counts,
//              up to ranking.learnedTopics.
//   author     what you think of this author (or source), from your ratings; 0.5 until you've rated any.
//   freshness  1 when new, 0 at the end of the retention window.
//   exploration a small bonus for sources you've rated fewer than EXPLORE_UNTIL items from, so new sources
//              get a fair chance instead of the paper narrowing to what it already knows you like.
import type { Config } from "@broadsheet/shared";
import { EXPLORE_UNTIL, NOTHING_LEARNED, type Learned } from "./affinity.ts";

export function freshness(publishedAt: string, now: Date, retentionDays: number): number {
  const age = (now.getTime() - new Date(publishedAt).getTime()) / (retentionDays * 24 * 3600 * 1000);
  return Math.max(0, Math.min(1, 1 - age));
}

export type RankInput = {
  publishedAt: string;
  /** Gemma's 0–100, or null if it hasn't read the item yet. */
  interest: number | null;
  sourceId: string;
  author: string | null;
  tags: string[];
  section: string | null;
};

export type ScoreParts = { score: number; relevance: number; interest: number; topic: number; author: number; freshness: number; exploration: number };

export function scoreParts(item: RankInput, now: Date, config: Pick<Config, "ranking" | "retention">, learned: Learned = NOTHING_LEARNED): ScoreParts {
  const w = config.ranking;
  const total = w.content + w.author + w.freshness || 1;

  const interest = item.interest === null ? 0.5 : item.interest / 100; // not read yet: middle of the pack
  const topic = learned.topic(item);
  const learnedShare = w.learnedTopics * topic.confidence;
  const relevance = (1 - learnedShare) * interest + learnedShare * topic.value;

  const author = learned.author(item).value;
  const fresh = freshness(item.publishedAt, now, config.retention.days);
  const exploration = w.exploration * Math.max(0, 1 - learned.ratedFromSource(item.sourceId) / EXPLORE_UNTIL);

  const score = (w.content * relevance + w.author * author + w.freshness * fresh) / total + exploration;
  const r4 = (n: number) => Number(n.toFixed(4));
  return { score: r4(score), relevance: r4(relevance), interest: r4(interest), topic: r4(topic.value), author: r4(author), freshness: r4(fresh), exploration: r4(exploration) };
}

export function score(item: RankInput, now: Date, config: Pick<Config, "ranking" | "retention">, learned?: Learned): number {
  return scoreParts(item, now, config, learned).score;
}
