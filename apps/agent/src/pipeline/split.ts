// Roundup and multi-section newsletters become pieces (PLAN.md §4.4). The newsletter itself stays as an item
// of kind 'newsletter': it isn't shown, but it holds the email (filed once its pieces are read) and the
// "Read the whole newsletter" page. Each piece is an item of its own, so it can be rated, moved, saved and
// hidden like any article.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../backup.ts";
import type { SourceFormat } from "@broadsheet/shared";
import { transaction, type Db } from "../db/db.ts";
import { looksLikeRoundup, splitPieces } from "../content/split.ts";

export const pieceId = (parentId: string, n: number) => `${parentId}-${n}`;
const pieceKind = (format: SourceFormat) => (format === "roundup" ? "brief" : "article");

export const formatOf = (db: Db, sourceId: string): SourceFormat =>
  ((db.prepare("SELECT format FROM sources WHERE id = ?").get(sourceId) as { format: SourceFormat } | undefined)?.format ?? "normal");

/** Split one newsletter. Returns how many pieces it made, or 0 if it didn't split (it stays one article). */
export async function splitItem(db: Db, contentDir: string, itemId: string, format: Exclude<SourceFormat, "normal">, now: string): Promise<number> {
  const parent = db.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as any;
  if (!parent) return 0;
  const html = await readFile(join(contentDir, itemId, "article.html"), "utf8").catch(() => null);
  const pieces = html ? splitPieces(html) : null;
  if (!pieces) return 0;

  const old = (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(itemId) as { id: string }[]).map((r) => r.id);
  for (const [i, p] of pieces.entries()) {
    const dir = join(contentDir, pieceId(itemId, i + 1));
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, "article.html"), p.html);
    await writeFileAtomic(join(dir, "article.txt"), p.text);
  }
  const fixed = parent.section_source === "fixed" ? parent.section_id : null;
  transaction(db, () => {
    retire(db, old.filter((id) => !pieces.some((_, i) => pieceId(itemId, i + 1) === id)));
    db.prepare("UPDATE items SET kind = 'newsletter', ai_status = 'skipped' WHERE id = ?").run(itemId);
    const insert = db.prepare(
      `INSERT INTO items (id, source_id, channel, title, author, published_at, content_origin, opening, word_count, section_id, section_source,
         ai_status, created_at, sender, list_id, shown_anyway, kind, parent_id, piece, links_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         -- Split again (a tidier cleaner, or the format set again): Gemma reads it again only if its words changed.
         ai_status = CASE WHEN items.title = excluded.title AND items.word_count = excluded.word_count THEN items.ai_status ELSE 'pending' END,
         ai_attempts = CASE WHEN items.title = excluded.title AND items.word_count = excluded.word_count THEN items.ai_attempts ELSE 0 END,
         title = excluded.title, opening = excluded.opening, word_count = excluded.word_count, kind = excluded.kind,
         links_json = excluded.links_json, content_published = 0`,
    );
    pieces.forEach((p, i) =>
      insert.run(
        pieceId(itemId, i + 1), parent.source_id, parent.channel, p.title, parent.author, parent.published_at, parent.content_origin,
        p.opening, p.wordCount, fixed, fixed ? "fixed" : null, now, parent.sender, parent.list_id, parent.shown_anyway,
        pieceKind(format), itemId, i + 1, JSON.stringify(p.links),
      ),
    );
  });
  return pieces.length;
}

/** Put a split newsletter back together as one article (its format was set back to normal). */
export function unsplit(db: Db, itemId: string) {
  transaction(db, () => {
    retire(db, (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(itemId) as { id: string }[]).map((r) => r.id));
    db.prepare("UPDATE items SET kind = 'article', ai_status = CASE WHEN summary IS NULL THEN 'pending' ELSE 'done' END WHERE id = ?").run(itemId);
  });
}

/** Pieces that no longer exist: dated as long expired, so the next publish removes them everywhere,
 *  OneDrive included, the same way as any expired item. */
function retire(db: Db, ids: string[]) {
  const stmt = db.prepare("UPDATE items SET published_at = '1970-01-01T00:00:00.000Z', saved = 0, parent_id = NULL WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

/** After Stage A files an email: split it if its newsletter is a roundup or multi-section one, or note that it
 *  looks like a roundup so `broadsheet sources` can suggest it. */
export async function afterFiling(db: Db, contentDir: string, itemId: string, sourceId: string, html: string, now: string): Promise<number> {
  const format = formatOf(db, sourceId);
  if (format !== "normal") return splitItem(db, contentDir, itemId, format, now);
  if (looksLikeRoundup(html)) db.prepare("UPDATE sources SET looks_like = 'roundup' WHERE id = ? AND format = 'normal'").run(sourceId);
  return 0;
}

/**
 * Change a newsletter's format (`broadsheet format`) and apply it to its current emails: split them (again), or put
 * them back together.
 */
export async function setFormat(db: Db, contentDir: string, sourceId: string, format: SourceFormat, cutoff: string, now: string) {
  db.prepare("UPDATE sources SET format = ?, looks_like = NULL WHERE id = ?").run(format, sourceId);
  const current = db.prepare("SELECT id, kind FROM items WHERE source_id = ? AND parent_id IS NULL AND channel = 'email' AND published_at >= ? AND hidden_by IS NULL").all(sourceId, cutoff) as { id: string; kind: string }[];
  let split = 0;
  let joined = 0;
  for (const it of current) {
    if (format === "normal") {
      if (it.kind === "newsletter") (unsplit(db, it.id), joined++);
    } else if (await splitItem(db, contentDir, it.id, format, now)) {
      split++;
    }
  }
  return { split, joined, current: current.length };
}

