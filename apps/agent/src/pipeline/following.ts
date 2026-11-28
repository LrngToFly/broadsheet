// Following by URL and switching a newsletter to its feed (Admin's Sources page, `broadsheet follow` and
// `broadsheet switch-to-feed`; PLAN.md §3.3, docs/phase-3.md A5). No email sign-up: the agent polls the feed.
import type { Db } from "../db/db.ts";
import { discoverFeed, type Feed } from "../feeds/feed.ts";

export type FeedPreview = {
  feedUrl: string;
  title: string;
  siteUrl: string | null;
  /** The newest few posts, to check it's the right site. */
  entries: { title: string; publishedAt: string; url: string | null }[];
};

const previewOf = (feedUrl: string, feed: Feed): FeedPreview => ({
  feedUrl,
  title: feed.title,
  siteUrl: feed.siteUrl,
  entries: [...feed.entries].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8).map((e) => ({ title: e.title, publishedAt: e.publishedAt, url: e.url })),
});

export async function previewFeed(url: string, doFetch: typeof fetch = fetch): Promise<FeedPreview> {
  const { feedUrl, feed } = await discoverFeed(normaliseUrl(url), doFetch);
  return previewOf(feedUrl, feed);
}

/** "example.substack.com" → "https://example.substack.com/". */
export function normaliseUrl(url: string): string {
  const u = url.trim();
  if (!u) throw new Error("Give a site or feed address.");
  const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new Error(`"${url}" isn't a web address.`);
  }
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "feed";
const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, "");

/** Already following this feed or site? */
function alreadyFollowing(db: Db, feedUrl: string, siteUrl: string): { id: string; name: string } | undefined {
  return db
    .prepare("SELECT id, coalesce(display_name, id) AS name FROM sources WHERE channel = 'feed' AND (feed_url = ? OR site_url = ?)")
    .get(feedUrl, siteUrl) as { id: string; name: string } | undefined;
}

/** Follow a site's feed as a new source. */
export async function follow(
  db: Db,
  url: string,
  opts: { name?: string; section?: string | null; now: string; doFetch?: typeof fetch; checkEvery?: number | null },
): Promise<{ id: string; name: string; preview: FeedPreview }> {
  const site = normaliseUrl(url);
  const preview = await previewFeed(site, opts.doFetch);
  const existing = alreadyFollowing(db, preview.feedUrl, site);
  if (existing) throw new Error(`You already follow this as "${existing.name}".`);
  if (opts.section && !db.prepare("SELECT 1 FROM sections WHERE id = ?").get(opts.section)) throw new Error(`No section "${opts.section}".`);
  const name = opts.name?.trim() || preview.title || hostOf(site);
  let id = slug(name);
  for (let n = 2; db.prepare("SELECT 1 FROM sources WHERE id = ?").get(id); n++) id = `${slug(name)}-${n}`;
  // origin 'auto': not from the config file (the table allows only 'config' or 'auto').
  db.prepare(
    `INSERT INTO sources (id, channel, display_name, site_url, feed_url, status, fixed_section_id, origin, created_at, check_every_s)
     VALUES (?, 'feed', ?, ?, ?, 'enabled', ?, 'auto', ?, ?)`,
  ).run(id, name, site, preview.feedUrl, opts.section ?? null, opts.now, opts.checkEvery ?? null);
  return { id, name, preview };
}

/** Where an email newsletter probably lives on the web: from a post's address, or a Substack list. */
export function guessSite(db: Db, sourceId: string): string | null {
  const url = (db.prepare("SELECT url FROM items WHERE source_id = ? AND url IS NOT NULL ORDER BY published_at DESC LIMIT 1").get(sourceId) as { url: string } | undefined)?.url;
  if (url) {
    try {
      return new URL(url).origin + "/";
    } catch {}
  }
  const match = (db.prepare("SELECT match_json FROM sources WHERE id = ?").get(sourceId) as { match_json: string | null } | undefined)?.match_json;
  const listId: string | undefined = match ? JSON.parse(match).listId : undefined;
  return listId?.endsWith(".substack.com") ? `https://${listId}/` : null;
}

/**
 * Switch an email newsletter to its feed: the same source (its name, section, ratings and history), now polled as a
 * feed. Its emails still count as the same source until you unsubscribe, and a post that arrives both ways is kept
 * once, in its fuller version.
 */
export async function switchToFeed(
  db: Db,
  sourceId: string,
  opts: { url?: string; doFetch?: typeof fetch },
): Promise<{ preview: FeedPreview; unsubscribe: string | null }> {
  const src = db.prepare("SELECT id, channel, unsubscribe_url FROM sources WHERE id = ?").get(sourceId) as { id: string; channel: string; unsubscribe_url: string | null } | undefined;
  if (!src) throw new Error(`No newsletter with the id "${sourceId}". See: broadsheet sources`);
  if (src.channel === "feed") throw new Error("It's already followed as a feed.");
  const site = opts.url ? normaliseUrl(opts.url) : guessSite(db, sourceId);
  if (!site) throw new Error("Couldn't tell where it lives on the web. Give its site address.");
  const preview = await previewFeed(site, opts.doFetch);
  const existing = alreadyFollowing(db, preview.feedUrl, site);
  if (existing) throw new Error(`You already follow its feed as "${existing.name}".`);
  db.prepare("UPDATE sources SET channel = 'feed', site_url = ?, feed_url = ?, status = 'enabled' WHERE id = ?").run(site, preview.feedUrl, sourceId);
  return { preview, unsubscribe: src.unsubscribe_url };
}

/** The best unsubscribe link from a List-Unsubscribe header: a web page if there is one, else an email address. */
export function unsubscribeLink(header: string | undefined): string | null {
  if (!header) return null;
  const links = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  return links.find((l) => /^https:\/\//i.test(l)) ?? links.find((l) => /^http:\/\//i.test(l)) ?? links.find((l) => /^mailto:/i.test(l)) ?? null;
}
