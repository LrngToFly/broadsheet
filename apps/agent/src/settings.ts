// Settings changed in Admin (docs/phase-3.md A6, A7). They're kept in the database and win over the config file;
// `broadsheet set <key> --reset` goes back to the file's value. Only these keys can be set this way.
import { z } from "zod";
import { Config } from "@broadsheet/shared";
import type { Db } from "./db/db.ts";

export const SETTINGS = {
  "mailbox.mode": { schema: z.enum(["dedicated", "shared"]), label: "Mailbox mode" },
  "mailbox.markFiledAsRead": { schema: z.boolean(), label: "Mark filed emails as read" },
} as const;
export type SettingKey = keyof typeof SETTINGS;

const stateKey = (k: string) => `setting:${k}`;
export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS;

/** "true"/"false" and numbers from the command line; everything else stays text. */
export function parseSettingValue(key: SettingKey, raw: string): unknown {
  const value: unknown = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  const r = SETTINGS[key].schema.safeParse(value);
  if (!r.success) throw new Error(`${SETTINGS[key].label}: ${z.prettifyError(r.error)}`);
  return r.data;
}

export function setSetting(db: Db, key: SettingKey, value: unknown | null) {
  if (value === null) db.prepare("DELETE FROM agent_state WHERE key = ?").run(stateKey(key));
  else db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)").run(stateKey(key), JSON.stringify(value));
}

export function overrides(db: Db): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = {};
  for (const r of db.prepare("SELECT key, value FROM agent_state WHERE key LIKE 'setting:%'").all() as { key: string; value: string }[]) {
    const k = r.key.slice("setting:".length);
    if (isSettingKey(k)) out[k] = JSON.parse(r.value);
  }
  return out;
}

/** The config file with Admin's settings on top. A stored value that's no longer valid is ignored. */
export function withSettings(config: Config, db: Db): Config {
  const merged = structuredClone(config) as Record<string, any>;
  for (const [key, value] of Object.entries(overrides(db))) {
    if (!SETTINGS[key as SettingKey].schema.safeParse(value).success) continue;
    const [group, name] = key.split(".") as [string, string];
    merged[group] = { ...(merged[group] ?? {}), [name]: value };
  }
  return Config.parse(merged);
}

/** Each setting's value now, and whether it comes from Admin or the file. */
export function describeSettings(config: Config, db: Db) {
  const o = overrides(db);
  const effective = withSettings(config, db) as Record<string, any>;
  return Object.entries(SETTINGS).map(([key, s]) => {
    const [group, name] = key.split(".") as [string, string];
    const fileValue = (config as Record<string, any>)[group]?.[name];
    return { key, label: s.label, value: effective[group]?.[name], fromAdmin: key in o, fileValue };
  });
}
