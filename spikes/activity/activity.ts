// Phase 0 spike (e): can the agent tell whether you're using the Mac,
// using only built-in macOS commands? Run with:  node spikes/activity/activity.ts
// Node 22.18+ runs TypeScript files directly (type stripping), so no build step.

import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

async function sh(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await run(cmd, args, { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Seconds since the last keyboard/mouse/trackpad input. */
async function hidIdleSeconds(): Promise<number | null> {
  const out = await sh("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const m = out.match(/"HIDIdleTime"\s*=\s*(\d+)/); // nanoseconds
  return m ? Number(BigInt(m[1]) / 1_000_000n) / 1000 : null;
}

/** True when the login session's screen is locked. */
async function screenLocked(): Promise<boolean | null> {
  const out = await sh("/usr/sbin/ioreg", ["-n", "Root", "-d", "1"]);
  if (!out.includes("IOConsoleUsers")) return null;
  return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(out);
}

/** Low Power Mode setting (System Settings → Energy). */
async function lowPowerMode(): Promise<boolean | null> {
  const out = await sh("/usr/bin/pmset", ["-g"]);
  const m = out.match(/lowpowermode\s+(\d)/);
  return m ? m[1] === "1" : null;
}

/** Kernel memory pressure: 1 = normal, 2 = warn, 4 = critical. */
async function memoryPressure(): Promise<"normal" | "warn" | "critical" | string> {
  const out = (await sh("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])).trim();
  return ({ "1": "normal", "2": "warn", "4": "critical" } as Record<string, string>)[out] ?? `unknown(${out})`;
}

/** Any thermal warning macOS has recorded. */
async function thermal(): Promise<string> {
  const out = await sh("/usr/bin/pmset", ["-g", "therm"]);
  if (/No thermal warning level has been recorded/i.test(out) && /No performance warning level has been recorded/i.test(out)) {
    return "none";
  }
  return out.trim().split("\n").filter((l) => /level/i.test(l)).join(" | ") || "unknown";
}

async function sample() {
  const [idle, locked, lpm, mem, therm] = await Promise.all([
    hidIdleSeconds(), screenLocked(), lowPowerMode(), memoryPressure(), thermal(),
  ]);
  return {
    time: new Date().toLocaleTimeString(),
    idleSeconds: idle,
    screenLocked: locked,
    lowPowerMode: lpm,
    memoryPressure: mem,
    thermal: therm,
    load1m: Number(loadavg()[0].toFixed(2)),
  };
}

// Default: one sample. With --watch N, sample every 5 s for N samples.
const watchIdx = process.argv.indexOf("--watch");
const count = watchIdx > -1 ? Number(process.argv[watchIdx + 1] ?? 12) : 1;
for (let i = 0; i < count; i++) {
  console.log(JSON.stringify(await sample()));
  if (i < count - 1) await new Promise((r) => setTimeout(r, 5000));
}
