// Settings changed in Admin (docs/phase-3.md A6, A7). They're kept in the database and win over the config file;
// `broadsheet set <key> --reset` goes back to the file's value. Only these keys can be set this way.
import { z } from "zod";
import { Config } from "@broadsheet/shared";
import type { Db } from "./db/db.ts";

const weight = z.number().min(0).max(1);
export const SETTINGS = {
  "mailbox.mode": { schema: z.enum(["dedicated", "shared"]), label: "Mailbox mode" },
  "mailbox.markFiledAsRead": { schema: z.boolean(), label: "Mark filed emails as read" },
  // A7: AI
  "ai.model": { schema: z.string().min(1), label: "Ollama model" },
  "ai.numCtx": { schema: z.number().int().min(2048).max(262144), label: "Context size (tokens)" },
  // A7: politeness
  "politeness.idleMinutes": { schema: z.number().int().min(1).max(240), label: "Idle minutes before Gemma works" },
  "politeness.lockedCountsAsIdle": { schema: z.boolean(), label: "A locked screen counts as idle" },
  "politeness.maxLoad5m": { schema: z.number().positive().max(64), label: "Skip AI work above this load" },
  "politeness.backlog": { schema: z.enum(["never-while-active", "trickle"]), label: "Backlog while you're at the Mac" },
  "politeness.backlogHours": { schema: z.number().positive().max(72), label: "Backlog hours before it trickles" },
  "politeness.overnightFrom": { schema: z.number().int().min(0).max(23), label: "Overnight window from (hour)" },
  "politeness.overnightTo": { schema: z.number().int().min(0).max(23), label: "Overnight window to (hour)" },
  // A7: the paper
  "retention.days": { schema: z.number().int().min(1).max(14), label: "Days in the paper" },
  "ranking.content": { schema: weight, label: "Ranking: interest" },
  "ranking.author": { schema: weight, label: "Ranking: author" },
  "ranking.freshness": { schema: weight, label: "Ranking: freshness" },
  "ranking.learnedTopics": { schema: weight, label: "Ranking: learned topics" },
  "ranking.exploration": { schema: z.number().min(0).max(0.5), label: "Ranking: new-source bonus" },
  "ranking.coverage": { schema: z.number().min(0).max(0.2), label: "Ranking: widely covered stories" },
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
