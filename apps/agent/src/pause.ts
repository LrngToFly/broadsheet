// Pausing the agent (Admin's menu bar, or `broadsheet pause`): scheduled runs do nothing until the time passes.
// `broadsheet run --force` (Admin's Run now) still runs.
import type { Db } from "./db/db.ts";

const KEY = "pause:until";

export function pausedUntil(db: Db, now = new Date()): Date | null {
  const v = (db.prepare("SELECT value FROM agent_state WHERE key = ?").get(KEY) as { value: string } | undefined)?.value;
  return v && new Date(v) > now ? new Date(v) : null;
}

export function setPause(db: Db, until: Date | null) {
  if (until) db.prepare("INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)").run(KEY, until.toISOString());
  else db.prepare("DELETE FROM agent_state WHERE key = ?").run(KEY);
}

/** "30m", "1h", "2h30m", "tomorrow" (6 a.m. tomorrow, your time) or "off" (null). */
export function parsePause(arg: string, now = new Date()): Date | null {
  if (arg === "off") return null;
  if (arg === "tomorrow") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    return t;
  }
  const m = arg.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  const minutes = m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
  if (!minutes || minutes > 7 * 24 * 60) throw new Error(`Pause for how long? e.g. 30m, 1h, tomorrow, or off (got "${arg}")`);
  return new Date(now.getTime() + minutes * 60_000);
}
