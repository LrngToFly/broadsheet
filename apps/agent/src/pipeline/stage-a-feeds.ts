// Stage A for feeds you follow by URL (PLAN.md §3.3, §3.4): poll the feeds that are due, and save new
// posts as items. Feed posts aren't kept long term; like everything else they expire with the window.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../backup.ts";
import type { Config } from "@broadsheet/shared";
import { transaction, type Db } from "../db/db.ts";
import { cleanArticle, stripTracking } from "../content/clean.ts";
import { discoverFeed, parseFeed, USER_AGENT, type FeedEntry } from "../feeds/feed.ts";
import { fetchWebArticle } from "../feeds/web.ts";

const HOUR = 3600;
/** Fewer words than this and the feed item is probably a teaser: try the web page. */
export const TEASER_WORDS = 150;

export type FeedOutcome = { source: string; status: string; added: string[]; error?: string };

export const feedItemId = (guid: string) => "f" + createHash("sha256").update(guid).digest("base64url").slice(0, 15);
const seenKey = (guid: string) => `feed:${createHash("sha256").update(guid).digest("hex").slice(0, 32)}`;

export async function stageAFeeds(opts: {
  db: Db;
  config: Config;
  contentDir: string;
  now?: Date;
  /** Poll every enabled feed, even if it isn't due. */
  force?: boolean;
  doFetch?: typeof fetch;
}): Promise<FeedOutcome[]> {
  const { db, config, contentDir } = opts;
  const doFetch = opts.doFetch ?? fetch;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - config.retention.days * 24 * HOUR * 1000).toISOString();

  const due = db
    .prepare(
      `SELECT s.id, s.site_url, s.feed_url, f.etag, f.last_modified, f.next_poll_at, f.poll_interval_s
       FROM sources s LEFT JOIN feed_state f ON f.source_id = s.id
       WHERE s.channel = 'feed' AND s.status = 'enabled'`,
    )
    .all() as any[];

  const outcomes: FeedOutcome[] = [];
  for (const s of due) {
    if (!opts.force && s.next_poll_at && s.next_poll_at > nowIso) continue;
    const outcome: FeedOutcome = { source: s.id, status: "", added: [] };
    outcomes.push(outcome);
    const interval: number = s.poll_interval_s ?? HOUR;
    const schedule = (seconds: number, error: string | null, etag?: string | null, lastModified?: string | null) =>
      db.prepare(
        `INSERT INTO feed_state (source_id, etag, last_modified, next_poll_at, poll_interval_s, last_error) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET etag = coalesce(excluded.etag, etag), last_modified = coalesce(excluded.last_modified, last_modified),
           next_poll_at = excluded.next_poll_at, poll_interval_s = excluded.poll_interval_s, last_error = excluded.last_error`,
      ).run(s.id, etag ?? null, lastModified ?? null, new Date(now.getTime() + seconds * 1000).toISOString(), seconds, error);

    try {
      let entries: FeedEntry[];
      let etag: string | null = null;
      let lastModified: string | null = null;
      if (!s.feed_url) {
        // First poll: find the feed from the site address.
        const found = await discoverFeed(s.site_url, doFetch);
        db.prepare("UPDATE sources SET feed_url = ? WHERE id = ?").run(found.feedUrl, s.id);
        entries = found.feed.entries;
      } else {
        const res = await doFetch(s.feed_url, {
          headers: { "User-Agent": USER_AGENT, ...(s.etag ? { "If-None-Match": s.etag } : {}), ...(s.last_modified ? { "If-Modified-Since": s.last_modified } : {}) },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 304) {
          outcome.status = "no change";
          schedule(interval, null);
          continue;
        }
        if (!res.ok) throw new Error(`feed returned ${res.status}`);
        etag = res.headers.get("etag");
        lastModified = res.headers.get("last-modified");
        entries = parseFeed(await res.text()).entries;
      }

      for (const e of entries) {
        if (e.publishedAt < windowStart) continue;
        if (e.url) e.url = stripTracking(e.url).replace(/\?$/, ""); // same form as email links, so duplicates match
        if (db.prepare("SELECT 1 FROM seen WHERE key = ?").get(seenKey(e.guid))) continue;
        // Already here from another channel (usually the email): keep that one.
        if (e.url && db.prepare("SELECT 1 FROM items WHERE url = ?").get(e.url)) {
          db.prepare("INSERT OR IGNORE INTO seen (key, first_seen_at) VALUES (?, ?)").run(seenKey(e.guid), nowIso);
          continue;
        }

        let article = cleanArticle(e.html, "", { title: e.title, listPost: e.url });
        let origin: "feed" | "web" = "feed";
        let teaser = article.wordCount < TEASER_WORDS;
        if (teaser && e.url) {
          const web = await fetchWebArticle(e.url, doFetch);
          const full = web ? cleanArticle(web, "", { title: e.title, listPost: e.url }) : null;
          if (full && full.wordCount > article.wordCount) {
            article = full;
            origin = "web";
            teaser = full.wordCount < TEASER_WORDS;
          }
        }

        const id = feedItemId(e.guid);
        const dir = join(contentDir, id);
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(join(dir, "article.html"), article.html);
        await writeFileAtomic(join(dir, "article.txt"), article.text);
        transaction(db, () => {
          db.prepare(
            `INSERT OR REPLACE INTO items (id, source_id, channel, feed_guid, title, author, published_at, url, content_origin, is_teaser,
               opening, word_count, section_id, section_source, ai_status, created_at)
             SELECT ?, ?, 'feed', ?, ?, ?, ?, ?, ?, ?, ?, ?, fixed_section_id, CASE WHEN fixed_section_id IS NULL THEN NULL ELSE 'fixed' END, 'pending', ?
             FROM sources WHERE id = ?`,
          ).run(id, s.id, e.guid, e.title, e.author, e.publishedAt, e.url, origin, teaser ? 1 : 0, article.opening, article.wordCount, nowIso, s.id);
          db.prepare("INSERT OR IGNORE INTO seen (key, first_seen_at) VALUES (?, ?)").run(seenKey(e.guid), nowIso);
          db.prepare("UPDATE sources SET last_post_at = max(coalesce(last_post_at, ''), ?) WHERE id = ?").run(e.publishedAt, s.id);
        });
        outcome.added.push(e.title);
      }
      outcome.status = outcome.added.length ? `${outcome.added.length} new` : "nothing new";
      schedule(HOUR, null, etag, lastModified);
    } catch (e) {
      outcome.error = (e as Error).message;
      outcome.status = "error";
      // Back off: 1 h, 2 h, 4 h … up to a day.
      schedule(Math.min(24 * HOUR, Math.max(HOUR, interval * 2)), outcome.error);
    }
  }
  return outcomes;
}
