// SQLite via Node's built-in node:sqlite (no native add-ons to install or rebuild).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "@broadsheet/shared";
import { migrations } from "./migrations.ts";

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function schemaVersion(db: Db): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

function migrate(db: Db) {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(`Database is version ${current}, newer than this agent (${migrations.length}). Update the agent.`);
  }
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export type SyncSummary = { sections: number; sources: number; rules: number; removed: string[] };

/**
 * Copy sections, sources and rules from the config file into the database (Phase 1: the file is the
 * source of truth). Sources the agent created itself (new senders) are left alone. Outlook folder ids
 * already stored for a section are kept.
 */
export function syncConfig(db: Db, config: Config, now = new Date().toISOString()): SyncSummary {
  return transaction(db, () => {
    const removed: string[] = [];

    // Sections
    const upsertSection = db.prepare(
      `INSERT INTO sections (id, name, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order`,
    );
    config.sections.forEach((s, i) => upsertSection.run(s.id, s.name, i));
    const sectionIds = config.sections.map((s) => s.id);
    for (const row of db.prepare("SELECT id FROM sections").all() as { id: string }[]) {
      if (!sectionIds.includes(row.id)) {
        db.prepare("DELETE FROM sections WHERE id = ?").run(row.id);
        removed.push(`section ${row.id}`);
      }
    }

    // Sources from the config file
    const upsertSource = db.prepare(
      `INSERT INTO sources (id, channel, display_name, match_json, site_url, status, fixed_section_id, origin, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'config', ?)
       ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, display_name = excluded.display_name,
         match_json = excluded.match_json, site_url = excluded.site_url, status = excluded.status,
         fixed_section_id = excluded.fixed_section_id, origin = 'config'`,
    );
    for (const s of config.sources) {
      upsertSource.run(
        s.id,
        s.channel,
        s.name ?? null,
        s.channel === "email" ? JSON.stringify(s.match) : null,
        s.channel === "feed" ? s.url : null,
        s.enabled ? "enabled" : "muted",
        s.section ?? null,
        now,
      );
    }
    const sourceIds = config.sources.map((s) => s.id);
    for (const row of db.prepare("SELECT id FROM sources WHERE origin = 'config'").all() as { id: string }[]) {
      if (!sourceIds.includes(row.id)) {
        db.prepare("DELETE FROM sources WHERE id = ?").run(row.id);
        removed.push(`source ${row.id}`);
      }
    }

    // Rules from the config file replace the previous config rules.
    db.prepare("DELETE FROM rules WHERE origin = 'config'").run();
    const insertRule = db.prepare(
      `INSERT INTO rules (id, kind, wording, match_mode, conditions_json, instruction, source_id, mail_action,
         section_id, status, origin, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'config', ?)`,
    );
    for (const r of config.rules) {
      insertRule.run(
        r.id,
        r.kind,
        r.wording,
        r.kind === "instruction" ? null : r.match,
        r.kind === "instruction" ? null : JSON.stringify(r.conditions),
        r.kind === "instruction" ? r.instruction : null,
        r.source ?? null,
        r.kind === "include" ? null : r.mail,
        r.kind === "include" ? (r.section ?? null) : null,
        r.status,
        now,
      );
    }

    return { sections: config.sections.length, sources: config.sources.length, rules: config.rules.length, removed };
  });
}
