// Publish the current edition to the OneDrive App Folder (PLAN.md §3.6 steps 8 and 11-12, §7.3):
//   items/<id>.html   the cleaned article (images point at data-src="images/…")
//   images/<hash>.*   cached copies of the article images
//   edition.json      the list the reader shows, written AFTER the files it points to
//   status.json       how the agent is doing, for the reader's footer
// Then expired items are pruned (PLAN.md §3.5): their rows, local content and OneDrive files, and any
// image no current item uses.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Edition, EDITION_SCHEMA_VERSION, FALLBACK_SECTION_ID, type Config, type ItemCard } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { cacheImages } from "../content/images.ts";
import type { AppFolder } from "../microsoft/onedrive.ts";
import { score } from "./ranking.ts";

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
      `SELECT i.*, coalesce(s.display_name, s.id) AS source_name FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.hidden_by IS NULL AND (i.is_article IS NULL OR i.is_article = 1) AND (i.published_at >= ? OR i.saved = 1)`,
    )
    .all(cutoff) as any[];

  const uploaded = new Set<string>(); // images uploaded during this run
  const cards: ItemCard[] = [];

  for (const r of rows) {
    // Upload the article and its images once; after that only the card changes.
    if (!r.content_published) {
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
        continue; // leave it out of this edition; the next run tries again
      }
      result.uploadedItems++;
    }

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
      score: score({ publishedAt: r.published_at, interest: summarized ? r.interest : null }, now, config),
      image: r.image,
      content: `items/${r.id}.html`,
      rating: r.rating ?? null,
      saved: Boolean(r.saved),
      sectionByYou: r.section_source === "user",
    });
  }

  cards.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
  const sections = (db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[]).map((s) => ({ ...s }));
  const edition = Edition.parse({ schemaVersion: EDITION_SCHEMA_VERSION, generatedAt: now.toISOString(), sections, items: cards });
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

/** Delete expired items everywhere, and images nothing uses any more (PLAN.md §3.5). */
async function prune(db: Db, appFolder: AppFolderPort, contentDir: string, cutoff: string, now: Date, result: PublishResult) {
  const expired = db.prepare("SELECT id, content_published FROM items WHERE published_at < ? AND saved = 0").all(cutoff) as { id: string; content_published: number }[];
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
  db.prepare("DELETE FROM runs WHERE started_at < ?").run(new Date(now.getTime() - 14 * day).toISOString());
}

function contentTypeOf(path: string): string {
  const ext = path.split(".").pop();
  return { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" }[ext ?? ""] ?? "application/octet-stream";
}
