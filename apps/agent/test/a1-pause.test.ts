import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.ts";
import { parsePause, pausedUntil, setPause } from "../src/pause.ts";

describe("pausing the agent", () => {
  const now = new Date(2026, 10, 27, 15, 30); // 3:30 p.m. local time
  it("understands 30m, 1h, 2h30m, tomorrow and off", () => {
    expect(parsePause("30m", now)!.getTime() - now.getTime()).toBe(30 * 60_000);
    expect(parsePause("2h30m", now)!.getTime() - now.getTime()).toBe(150 * 60_000);
    expect(parsePause("tomorrow", now)).toEqual(new Date(2026, 10, 28, 6, 0));
    expect(parsePause("off", now)).toBeNull();
    expect(() => parsePause("soon", now)).toThrow(/how long/);
    expect(() => parsePause("0m", now)).toThrow();
  });

  it("is paused until the time passes, and off resumes", () => {
    const db = openDb(":memory:");
    expect(pausedUntil(db, now)).toBeNull();
    setPause(db, parsePause("1h", now));
    expect(pausedUntil(db, now)).toEqual(new Date(2026, 10, 27, 16, 30));
    expect(pausedUntil(db, new Date(2026, 10, 27, 16, 31))).toBeNull(); // over
    setPause(db, null);
    expect(pausedUntil(db, now)).toBeNull();
  });
});
