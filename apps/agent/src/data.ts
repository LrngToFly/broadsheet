// Your data (PLAN.md §7.1, docs/phase-3.md A7): export and import of the long-term data in one JSON file, Forget for
// ratings, and what's stored where. Article text is never exported: it lasts only a few days by design.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { transaction, type Db } from "./db/db.ts";
import { OWN_WORDS_AT_KEY, OWN_WORDS_KEY } from "./pipeline/rules.ts";

export const EXPORT_KIND = "broadsheet-export";
export const EXPORT_VERSION = 1;

type Row = Record<string, unknown>;
export type ExportFile = {
  kind: typeof EXPORT_KIND;
  version: number;
  exportedAt: string;
  sections: Row[];
  sources: Row[];
  rules: Row[];
  /** Settings changed in Admin, and your own words. */
  state: Row[];
  /** What you rated, moved or hid (no article text). */
  preferences: Row[];
  /** The profiles Gemma wrote from your ratings. */
  profiles: Row[];
};

/** agent_state keys worth keeping: Admin's settings and your own words (not folder ids or run bookkeeping). */
const KEPT_STATE = (key: string) => key.startsWith("setting:") || key === OWN_WORDS_KEY || key === OWN_WORDS_AT_KEY;

export function exportData(db: Db, now = new Date()): ExportFile {
  const all = (sql: string) => db.prepare(sql).all() as Row[];
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    sections: all("SELECT id, name, sort_order FROM sections ORDER BY sort_order"),
    sources: all("SELECT * FROM sources ORDER BY id"),
    rules: all("SELECT * FROM rules ORDER BY id"),
    state: (all("SELECT key, value FROM agent_state") as { key: string; value: string }[]).filter((r) => KEPT_STATE(r.key)),
    preferences: all("SELECT * FROM preference_records ORDER BY updated_at"),
    profiles: all("SELECT * FROM reader_profiles ORDER BY version"),
  };
}

export type ImportSummary = Record<"sections" | "sources" | "rules" | "state" | "preferences" | "profiles", number>;

/**
 * Bring an export in, on top of what's here: matching ids are updated, new ones added, nothing is deleted. Rows are
 * upserted (never replaced), because replacing a source would delete its current articles. Columns this version
 * doesn't know are ignored.
 */
export function importData(db: Db, file: unknown, opts: { dryRun?: boolean } = {}): ImportSummary {
  const f = file as Partial<ExportFile>;
  if (f?.kind !== EXPORT_KIND) throw new Error("That isn't a Broadsheet export file.");
  if (typeof f.version !== "number" || f.version > EXPORT_VERSION) throw new Error(`It's from a newer Broadsheet (export version ${f.version}). Update the agent first.`);
  const summary: ImportSummary = { sections: 0, sources: 0, rules: 0, state: 0, preferences: 0, profiles: 0 };
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const upsert = (table: string, key: string, rows: Row[] | undefined, n: keyof ImportSummary) => {
    const known = columns(table);
    for (const row of rows ?? []) {
      const cols = Object.keys(row).filter((c) => known.has(c));
      if (!cols.includes(key)) continue;
      const updates = cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`);
      db.prepare(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})
         ON CONFLICT(${key}) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
      ).run(...(cols.map((c) => row[c]) as never[]));
      summary[n]++;
    }
  };
  const run = () => {
    upsert("sections", "id", f.sections, "sections");
    upsert("sources", "id", f.sources, "sources");
    upsert("rules", "id", f.rules, "rules");
    upsert("agent_state", "key", (f.state ?? []).filter((r) => KEPT_STATE(String(r.key))), "state");
    upsert("preference_records", "item_id", f.preferences, "preferences");
    upsert("reader_profiles", "version", f.profiles, "profiles");
  };
  if (opts.dryRun) {
    // Do it inside a transaction and undo it, so the counts are real.
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
    } finally {
      db.exec("ROLLBACK");
    }
  } else {
    transaction(db, run);
  }
  return summary;
}

/**
 * Forget: one item's record (its rating, note, move and hide reason) or everything learned from you. Your own words
 * and your rules stay; so do hides themselves (the item stays out of the paper).
 */
export function forget(db: Db, itemId: string | null): number {
  return transaction(db, () => {
    if (itemId) {
      db.prepare("UPDATE items SET rating = NULL, rated_at = NULL WHERE id = ?").run(itemId);
      return Number(db.prepare("DELETE FROM preference_records WHERE item_id = ?").run(itemId).changes);
    }
    db.prepare("UPDATE items SET rating = NULL, rated_at = NULL").run();
    db.prepare("DELETE FROM reader_profiles").run();
    return Number(db.prepare("DELETE FROM preference_records").run().changes);
  });
}

async function sizeOf(path: string): Promise<number> {
  const s = await stat(path).catch(() => null);
  if (!s) return 0;
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await sizeOf(join(path, name));
  return total;
}

/** What's stored, and how much space it takes. */
export async function storage(db: Db, places: { db: string; content: string; eval: string; logs: string }) {
  const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  return {
    bytes: {
      database: (await sizeOf(places.db)) + (await sizeOf(`${places.db}-wal`)),
      articles: await sizeOf(places.content),
      eval: await sizeOf(places.eval),
      logs: await sizeOf(places.logs),
    },
    counts: {
      articles: count("items"),
      newsletters: count("sources"),
      rules: count("rules"),
      preferences: count("preference_records"),
      ratings: (db.prepare("SELECT count(*) n FROM preference_records WHERE rating IS NOT NULL").get() as { n: number }).n,
      mailLog: count("mail_log"),
    },
  };
}
