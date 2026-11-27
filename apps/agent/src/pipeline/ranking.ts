// The first-cut ranking (PLAN.md §4.2):
//   score = w_c · content_relevance + w_a · author_affinity + w_f · freshness
// Phase 1 has no ratings yet, so author affinity is neutral (0.5) and content relevance is Gemma's
// interest score. Phase 2 adds learned tag and author affinity from your 👍 👌 👎.
import type { Config } from "@broadsheet/shared";

export function freshness(publishedAt: string, now: Date, retentionDays: number): number {
  const age = (now.getTime() - new Date(publishedAt).getTime()) / (retentionDays * 24 * 3600 * 1000);
  return Math.max(0, Math.min(1, 1 - age));
}

export function score(
  item: { publishedAt: string; interest: number | null },
  now: Date,
  config: Pick<Config, "ranking" | "retention">,
): number {
  const w = config.ranking;
  const total = w.content + w.author + w.freshness || 1;
  const relevance = item.interest === null ? 0.5 : item.interest / 100; // not summarized yet: middle of the pack
  const author = 0.5;
  const fresh = freshness(item.publishedAt, now, config.retention.days);
  return Number(((w.content * relevance + w.author * author + w.freshness * fresh) / total).toFixed(4));
}
