// Publish the current edition to the OneDrive App Folder (PLAN.md §3.6 steps 8 and 11-12, §7.3):
//   items/<id>.html   the cleaned article (images point at data-src="images/…")
//   images/<hash>.*   cached copies of the article images
//   edition.json      the list the reader shows, written AFTER the files it points to
//   status.json       how the agent is doing, for the reader's footer
// Then expired items are pruned (PLAN.md §3.5): their rows, local content and OneDrive files, and any
// image no current item uses.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Edition, EDITION_SCHEMA_VERSION, FALLBACK_SECTION_ID, HideReason, type Config, type HiddenCard, type ItemCard } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { cacheImages } from "../content/images.ts";
import type { AppFolder } from "../microsoft/onedrive.ts";
import { score } from "./ranking.ts";
import { learn } from "./affinity.ts";
import { buildRulesFile } from "./rules.ts";

export { freshness } from "./ranking.ts";

export type AppFolderPort = Pick<AppFolder, "put" | "putJson"> & Partial<Pick<AppFolder, "delete" | "list">>;

export type PublishResult = { items: number; uploadedItems: number; uploadedImages: number; pruned: number; prunedImages: number; errors: string[] };

export type AgentStatus = {
  generatedAt: string;
  lastStage: "a" | "b";
  /** Items still waiting for Gemma. */
  pending: number;
  /** Why AI work is waiting, if it is (e.g. "you're active"). */
  deferred: string | null;
  model: string;
  errors: string[];
};

const WORDS_PER_MINUTE = 230;

export async function publish(opts: {
  db: Db;
  appFolder: AppFolderPort;
  config: Config;
  contentDir: string;
  now?: Date;
  fetchImage?: typeof fetch;
  status?: Omit<AgentStatus, "generatedAt" | "pending" | "model">;
}): Promise<PublishResult> {
  const { db, appFolder, config, contentDir } = opts;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - config.retention.days * 24 * 3600 * 1000).toISOString();
  const result: PublishResult = { items: 0, uploadedItems: 0, uploadedImages: 0, pruned: 0, prunedImages: 0, errors: [] };

  const rows = db
    .prepare(
      `SELECT i.*, coalesce(s.display_name, s.id) AS source_name, parent.title AS newsletter_title FROM items i JOIN sources s ON s.id = i.source_id
         LEFT JOIN items parent ON parent.id = i.parent_id
       WHERE i.kind != 'newsletter' AND i.hidden_by IS NULL AND (i.is_article IS NULL OR i.is_article = 1) AND (i.published_at >= ? OR i.saved = 1)`,
    )
    .all(cutoff) as any[];
  // A split newsletter isn't shown itself, but its pieces link to it ("Read the whole newsletter").
  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))] as string[];
  const newsletters = parentIds.length
    ? (db.prepare(`SELECT * FROM items WHERE id IN (${parentIds.map(() => "?").join(",")})`).all(...parentIds) as any[])
    : [];
  const newsletterReady = new Set<string>();

  const learned = learn(db, now); // what your ratings say, for the ranking
  const uploaded = new Set<string>(); // images uploaded during this run
  const cards: ItemCard[] = [];

  /** Upload an item's article and its images once; after that only the card changes. False if it failed. */
  const uploadContent = async (r: any): Promise<boolean> => {
    if (r.content_published) return true;
    try {
      const dir = join(contentDir, r.id);
      const article = await readFile(join(dir, "article.html"), "utf8");
      const cached = await cacheImages(article, dir, opts.fetchImage);
      for (const img of cached.images) {
        if (uploaded.has(img.path)) continue;
        await appFolder.put(img.path, await readFile(img.file), contentTypeOf(img.path));
        uploaded.add(img.path);
        result.uploadedImages++;
      }
      await appFolder.put(`items/${r.id}.html`, cached.html, "text/html; charset=utf-8");
      db.prepare("UPDATE items SET content_published = 1, image = ?, images_json = ? WHERE id = ?").run(cached.hero, JSON.stringify(cached.images.map((i) => i.path)), r.id);
      r.image = cached.hero;
    } catch (e) {
      result.errors.push(`${r.title}: ${(e as Error).message}`);
      return false; // leave it out of this edition; the next run tries again
    }
    result.uploadedItems++;
    return true;
  };

  for (const n of newsletters) if (await uploadContent(n)) newsletterReady.add(n.id);

  for (const r of rows) {
    if (!(await uploadContent(r))) continue;

    const summarized = r.ai_status === "done";
    cards.push({
      id: r.id,
      title: r.title,
      source: r.source_name,
      author: r.author,
      channel: r.channel,
      publishedAt: new Date(r.published_at).toISOString(),
      url: r.url,
      section: r.section_id ?? FALLBACK_SECTION_ID,
      status: summarized ? "summarized" : "pending",
      opening: r.opening,
      summary: summarized ? r.summary : null,
      keyPoints: summarized ? JSON.parse(r.key_points_json) : [],
      tags: JSON.parse(r.tags_json),
      whyItsHere: summarized ? r.why_its_here : null,
      readMinutes: r.read_minutes ?? Math.max(1, Math.round(r.word_count / WORDS_PER_MINUTE)),
      score: score(
        { publishedAt: r.published_at, interest: summarized ? r.interest : null, sourceId: r.source_id, author: r.author, tags: JSON.parse(r.tags_json), section: r.section_id },
        now, config, learned,
      ),
      image: r.image,
      content: `items/${r.id}.html`,
      rating: r.rating ?? null,
      saved: Boolean(r.saved),
      sectionByYou: r.section_source === "user",
      kind: r.kind === "brief" ? "brief" : "article",
      newsletter: r.parent_id && newsletterReady.has(r.parent_id) ? { title: r.newsletter_title, content: `items/${r.parent_id}.html` } : null,
      alsoIn: [],
      read: Boolean(r.read_at),
    });
  }

  cards.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
  const shown = sameStoryOnce(
    cards,
    new Map(rows.map((r) => [r.id, { links: JSON.parse(r.links_json ?? "[]"), sender: r.sender, piece: Boolean(r.parent_id), storyId: r.story_id }])),
    config.ranking.coverage,
  );
  cards.splice(0, cards.length, ...shown);
  const hidden = hiddenCards(db, cutoff);
  const sections = (db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[]).map((s) => ({ ...s }));
  const edition = Edition.parse({ schemaVersion: EDITION_SCHEMA_VERSION, generatedAt: now.toISOString(), sections, items: cards, hidden });
  // The Rules page: your words, suggestions waiting, and your rules (P4). Before edition.json, which is last.
  await appFolder.putJson("rules.json", buildRulesFile(db, config, now));
  await appFolder.putJson("edition.json", edition);
  result.items = cards.length;

  await prune(db, appFolder, contentDir, cutoff, now, result);

  if (opts.status) {
    const pending = (db.prepare("SELECT count(*) n FROM items WHERE ai_status = 'pending' AND hidden_by IS NULL").get() as { n: number }).n;
    const status: AgentStatus = { generatedAt: now.toISOString(), pending, model: config.ai.model, ...opts.status, errors: [...opts.status.errors, ...result.errors].slice(0, 20) };
    await appFolder.putJson("status.json", status);
  }
  return result;
}

// ---- The same story in several roundups (PLAN.md §4.4) ---------------------------------------------

const STOP = new Set("the a an and or of to in on for with at by from as is are was were be its it this that new over after into says say amid than more most".split(" "));
const titleWords = (t: string) => new Set(t.toLowerCase().replace(/[’']s\b/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
/** A link with its query and fragment dropped, so two newsletters' links to one story compare equal. */
const bare = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/$/, "")}`;
  } catch {
    return u;
  }
};
/** Links that say nothing about which story it is. */
const GENERIC_HOSTS = /(^|\.)(twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|bsky\.app|threads\.net|apple\.com|spotify\.com)$/;

/**
 * One story told by several newsletters. Cards are grouped when Gemma matched them (`storyId`, see ai/stories.ts), or
 * when their headlines share most of their words, or they link to the same page (not either newsletter's own site).
 * In each group:
 *   - every card is told the other newsletters ("also in …"),
 *   - every card gets a coverage bonus: `coverage` per extra newsletter, counting at most MAX_COVERAGE of them, so a
 *     widely covered story ranks higher without swamping your interests,
 *   - briefs are shown once: the best-scored one.
 * Articles are never dropped (two writers on one event usually give different angles), and a brief and an article on
 * the same story both stay.
 */
export const MAX_COVERAGE = 4;
export function sameStoryOnce(
  cards: ItemCard[],
  extra: Map<string, { links: string[]; sender: string | null; piece: boolean; storyId?: string | null }>,
  coverage = 0,
): ItemCard[] {
  // Union-find over the cards.
  const parent = new Map(cards.map((c) => [c.id, c.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  // Gemma's matches.
  const byStory = new Map<string, string>();
  for (const c of cards) {
    const sid = extra.get(c.id)?.storyId;
    if (!sid) continue;
    if (byStory.has(sid)) union(byStory.get(sid)!, c.id);
    else byStory.set(sid, c.id);
  }
  // Same headline or same link, between different newsletters.
  const facts = cards.map((card) => {
    const x = extra.get(card.id);
    const own = x?.sender?.split("@")[1]?.split(".").slice(-2).join(".") ?? "";
    const links = new Set((x?.links ?? []).filter((l) => { const h = hostOf(l); return h && !GENERIC_HOSTS.test(h) && !(own && (h === own || h.endsWith(`.${own}`))); }).map(bare));
    return { card, words: titleWords(card.title), links };
  });
  for (let i = 0; i < facts.length; i++) {
    for (let j = 0; j < i; j++) {
      const [a, b] = [facts[i]!, facts[j]!];
      if (a.card.source === b.card.source) continue;
      const shared = [...a.words].filter((w) => b.words.has(w)).length;
      const jaccard = shared / (a.words.size + b.words.size - shared || 1);
      if ((shared >= 2 && jaccard >= 0.5) || [...a.links].some((l) => b.links.has(l))) union(a.card.id, b.card.id);
    }
  }

  const groups = new Map<string, ItemCard[]>();
  for (const c of cards) groups.set(find(c.id), [...(groups.get(find(c.id)) ?? []), c]);
  const dropped = new Set<string>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sources = [...new Set(members.map((m) => m.source))];
    for (const m of members) {
      m.alsoIn = sources.filter((s) => s !== m.source);
      m.score = Math.round((m.score + coverage * Math.min(sources.length - 1, MAX_COVERAGE)) * 1e4) / 1e4;
    }
    // Briefs of one story are shown once (the best-scored). A brief and an article on the same story both stay.
    const briefs = members.filter((m) => m.kind === "brief").sort((a, b) => b.score - a.score);
    for (const b of briefs.slice(1)) dropped.add(b.id);
  }
  return cards.filter((c) => !dropped.has(c.id)).sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
}

/** What was left out of the paper in the same window, and why, for the reader's Hidden list (and Admin's). */
export function hiddenCards(db: Db, cutoff: string): HiddenCard[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.title, i.author, i.published_at, i.url, i.hidden_by, i.hidden_reason, i.hidden_note, coalesce(s.display_name, s.id) AS source_name, r.wording
       FROM items i JOIN sources s ON s.id = i.source_id LEFT JOIN rules r ON r.id = i.hidden_by
       WHERE (i.hidden_by IS NOT NULL OR i.is_article = 0) AND i.kind != 'newsletter' AND i.published_at >= ?
       ORDER BY coalesce(i.hidden_at, i.published_at) DESC, i.id`,
    )
    .all(cutoff) as any[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    source: r.source_name,
    author: r.author,
    publishedAt: new Date(r.published_at).toISOString(),
    url: r.url,
    why:
      r.hidden_by === "user" ? { kind: "you" as const, reason: HideReason.safeParse(r.hidden_reason).data ?? null, note: r.hidden_note ?? null }
      : r.hidden_by ? { kind: "rule" as const, ruleId: r.hidden_by, wording: r.wording ?? r.hidden_by }
      : { kind: "not-article" as const },
  }));
}

/** Delete expired items everywhere, and images nothing uses any more (PLAN.md §3.5). */
async function prune(db: Db, appFolder: AppFolderPort, contentDir: string, cutoff: string, now: Date, result: PublishResult) {
  // An email still waiting in _Sorting for Gemma to choose its section is kept until it's filed, even when it's too
  // old for the paper (one you dropped into _Add, or a backlog): only then is its record removed.
  const expired = db
    .prepare(
      `SELECT id, content_published FROM items WHERE published_at < ? AND saved = 0
         AND NOT (ai_status = 'pending' AND hidden_by IS NULL AND channel = 'email' AND message_id IS NOT NULL AND mail_folder_id = ?)`,
    )
    .all(cutoff, sortingFolder(db)) as { id: string; content_published: number }[];
  for (const e of expired) {
    try {
      if (e.content_published && appFolder.delete) await appFolder.delete(`items/${e.id}.html`);
      await rm(join(contentDir, e.id), { recursive: true, force: true });
      db.prepare("DELETE FROM items WHERE id = ?").run(e.id);
      result.pruned++;
    } catch (err) {
      result.errors.push(`couldn't remove an expired item: ${(err as Error).message}`);
    }
  }

  // Images: keep every image a remaining item uses.
  if (appFolder.list && appFolder.delete) {
    const used = new Set<string>();
    for (const r of db.prepare("SELECT id, images_json, content_published FROM items").all() as any[]) {
      let paths: string[] | null = r.images_json ? JSON.parse(r.images_json) : null;
      if (!paths && r.content_published) {
        // Published before images were tracked: read the list from the local copy.
        const names = await readdir(join(contentDir, r.id, "images")).catch(() => [] as string[]);
        paths = names.map((n) => `images/${n}`);
        db.prepare("UPDATE items SET images_json = ? WHERE id = ?").run(JSON.stringify(paths), r.id);
      }
      for (const p of paths ?? []) used.add(p);
    }
    for (const name of await appFolder.list("images")) {
      if (used.has(`images/${name}`)) continue;
      await appFolder.delete(`images/${name}`);
      result.prunedImages++;
    }
  }

  const day = 24 * 3600 * 1000;
  db.prepare("DELETE FROM seen WHERE first_seen_at < ?").run(new Date(now.getTime() - 90 * day).toISOString());
  db.prepare("DELETE FROM source_posts WHERE published_at < ?").run(new Date(now.getTime() - 90 * day).toISOString());
  db.prepare("DELETE FROM mail_log WHERE received_at < ?").run(new Date(now.getTime() - 90 * day).toISOString());
  db.prepare("DELETE FROM runs WHERE started_at < ?").run(new Date(now.getTime() - 14 * day).toISOString());
  // Rules: "hid N in the last 30 days" needs only 30 days; finished drafting requests a month; and the article
  // text copied for a draft lasts no longer than the article itself.
  db.prepare("DELETE FROM rule_hits WHERE at < ?").run(new Date(now.getTime() - 30 * day).toISOString());
  db.prepare("DELETE FROM rule_requests WHERE status IN ('done', 'dismissed') AND updated_at < ?").run(new Date(now.getTime() - 30 * day).toISOString());
  db.prepare("UPDATE rule_requests SET excerpt = NULL WHERE excerpt IS NOT NULL AND created_at < ?").run(cutoff);
}

const sortingFolder = (db: Db) => (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_sorting'").get() as { value: string } | undefined)?.value ?? "";

function contentTypeOf(path: string): string {
  const ext = path.split(".").pop();
  return { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" }[ext ?? ""] ?? "application/octet-stream";
}
