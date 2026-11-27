// Publish the current edition to the OneDrive App Folder (PLAN.md §3.6 step 8 and §7.3):
//   items/<id>.html   the cleaned article (images point at data-src="images/…")
//   images/<hash>.*   cached copies of the article images
//   edition.json      the list the reader shows, written LAST so the reader never sees a card whose
//                     article file isn't there yet
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Edition, EDITION_SCHEMA_VERSION, FALLBACK_SECTION_ID, type Config, type ItemCard } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { cacheImages } from "../content/images.ts";
import type { AppFolder } from "../microsoft/onedrive.ts";

export type AppFolderPort = Pick<AppFolder, "put" | "putJson">;

export type PublishResult = { items: number; uploadedItems: number; uploadedImages: number; errors: string[] };

const WORDS_PER_MINUTE = 230;

/** Newest items first until Gemma ranks them (M5): 1.0 for brand new, 0 at the end of the retention window. */
export function freshness(publishedAt: string, now: Date, retentionDays: number): number {
  const age = (now.getTime() - new Date(publishedAt).getTime()) / (retentionDays * 24 * 3600 * 1000);
  return Math.max(0, Math.min(1, 1 - age));
}

export async function publish(opts: {
  db: Db;
  appFolder: AppFolderPort;
  config: Config;
  contentDir: string;
  now?: Date;
  fetchImage?: typeof fetch;
}): Promise<PublishResult> {
  const { db, appFolder, config, contentDir } = opts;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - config.retention.days * 24 * 3600 * 1000).toISOString();
  const result: PublishResult = { items: 0, uploadedItems: 0, uploadedImages: 0, errors: [] };

  const rows = db
    .prepare(
      `SELECT i.*, coalesce(s.display_name, s.id) AS source_name FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.hidden_by IS NULL AND (i.is_article IS NULL OR i.is_article = 1) AND (i.published_at >= ? OR i.saved = 1)`,
    )
    .all(cutoff) as any[];

  const uploaded = new Set<string>(); // images already uploaded during this run
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
        db.prepare("UPDATE items SET content_published = 1, image = ? WHERE id = ?").run(cached.hero, r.id);
        r.image = cached.hero;
        r.content_published = 1;
        result.uploadedItems++;
      } catch (e) {
        result.errors.push(`${r.title}: ${(e as Error).message}`);
        continue; // leave it out of this edition; the next run tries again
      }
    }

    const summarized = r.ai_status === "done";
    const score = r.score && summarized ? r.score : freshness(r.published_at, now, config.retention.days);
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
      score,
      image: r.image,
      content: `items/${r.id}.html`,
    });
  }

  cards.sort((a, b) => b.score - a.score || b.publishedAt.localeCompare(a.publishedAt));
  const sections = (db.prepare("SELECT id, name FROM sections ORDER BY sort_order").all() as { id: string; name: string }[]).map((s) => ({ ...s }));
  const edition = Edition.parse({ schemaVersion: EDITION_SCHEMA_VERSION, generatedAt: now.toISOString(), sections, items: cards });
  await appFolder.putJson("edition.json", edition);
  result.items = cards.length;
  return result;
}

function contentTypeOf(path: string): string {
  const ext = path.split(".").pop();
  return { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" }[ext ?? ""] ?? "application/octet-stream";
}
