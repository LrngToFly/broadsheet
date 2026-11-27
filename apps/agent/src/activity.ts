// Is the Mac's owner using it? Read with built-in macOS commands (PLAN.md §6.2; confirmed in Phase 0).
import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { promisify } from "node:util";
import type { Config } from "@broadsheet/shared";

const run = promisify(execFile);
const sh = async (cmd: string, args: string[]) => (await run(cmd, args, { maxBuffer: 10 * 1024 * 1024 })).stdout;

export type ActivitySample = {
  /** Seconds since the last keyboard, mouse or trackpad input; null if it couldn't be read. */
  idleSeconds: number | null;
  screenLocked: boolean | null;
  lowPowerMode: boolean | null;
  memoryPressure: "normal" | "warn" | "critical" | "unknown";
  /** "none", or the warning text macOS reports. */
  thermal: string;
  load5m: number;
};

async function idleSeconds(): Promise<number | null> {
  const out = await sh("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/); // nanoseconds
  return m ? Number(BigInt(m[1]!) / 1_000_000n) / 1000 : null;
}

async function screenLocked(): Promise<boolean | null> {
  const out = await sh("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"]);
  if (!out.includes("IOConsoleUsers")) return null;
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(out);
}

async function lowPowerMode(): Promise<boolean | null> {
  const m = (await sh("/usr/bin/pmset", ["-g"])).match(/lowpowermode\s+(\d)/);
  return m ? m[1] === "1" : null;
}

async function memoryPressure(): Promise<ActivitySample["memoryPressure"]> {
  const level = (await sh("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim();
  return ({ "1": "normal", "2": "warn", "4": "critical" } as const)[level as "1" | "2" | "4"] ?? "unknown";
}

async function thermal(): Promise<string> {
  const out = await sh("/usr/bin/pmset", ["-g", "therm"]);
  if (/No thermal warning level has been recorded/i.test(out) && /No performance warning level has been recorded/i.test(out)) return "none";
  return out.trim().split("\n").filter((l) => /level/i.test(l)).join(" | ") || "unknown";
}

export async function sampleActivity(): Promise<ActivitySample> {
  const [idle, locked, lpm, mem, therm] = await Promise.all([idleSeconds(), screenLocked(), lowPowerMode(), memoryPressure(), thermal()]);
  return { idleSeconds: idle, screenLocked: locked, lowPowerMode: lpm, memoryPressure: mem, thermal: therm, load5m: loadavg()[1]! };
}

/** May AI work run now? If not, the reason, in words for the log and the status display. */
export function aiMayRun(s: ActivitySample, p: Config["politeness"]): { ok: true } | { ok: false; reason: string } {
  if (s.lowPowerMode) return { ok: false, reason: "Low Power Mode is on" };
  if (s.thermal !== "none") return { ok: false, reason: `thermal warning: ${s.thermal}` };
  if (s.memoryPressure !== "normal") return { ok: false, reason: `memory pressure is ${s.memoryPressure}` };
  if (s.load5m > p.maxLoad5m) return { ok: false, reason: `the Mac is busy (load ${s.load5m.toFixed(1)})` };
  if (p.lockedCountsAsIdle && s.screenLocked) return { ok: true };
  if (s.idleSeconds === null) return { ok: false, reason: "couldn't read idle time" };
  const needed = p.idleMinutes * 60;
  if (s.idleSeconds < needed) {
    return { ok: false, reason: `you're active (idle ${Math.floor(s.idleSeconds / 60)} of ${p.idleMinutes} min)` };
  }
  return { ok: true };
}
