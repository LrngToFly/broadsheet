import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { stageB } from "../src/pipeline/stage-b.ts";
import { inOvernightWindow, type ActivitySample } from "../src/activity.ts";
import type { LlmProvider } from "../src/ai/provider.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const here: ActivitySample = { idleSeconds: 5, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };
const reply = JSON.stringify({ is_article: true, summary: "A post about tomatoes ripening late.", key_points: [], section: "gardening", tags: [], interest: 60, why_its_here: "x", read_minutes: 2, hidden_by_rule: null });

function setup(politeness: object, createdAt: string) {
  const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" }, politeness });
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('s', 'email', 'Garden', 'enabled', 'auto', 'x')").run();
  const contentDir = mkdtempSync(join(tmpdir(), "bs-a7-"));
  for (const id of ["one", "two"]) {
    db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at) VALUES (?, 's', 'email', ?, '2026-11-27T10:00:00Z', ?)").run(id, `Post ${id}`, createdAt);
    mkdirSync(join(contentDir, id), { recursive: true });
    writeFileSync(join(contentDir, id, "article.txt"), "Tomatoes ripen late.");
  }
  let calls = 0;
  const llm: LlmProvider = { id: "fake", chat: async () => (calls++, { text: reply, promptTokens: 1, outputTokens: 1, seconds: 1 }), isLoaded: async () => true, unload: async () => {} };
  const mail: MailPort = { list: async () => [], mime: async () => "", move: async (id) => id, markRead: async () => {} };
  return { config, db, contentDir, llm, mail, calls: () => calls };
}

describe("politeness (A7)", () => {
  it("trickles one item of an old backlog while you're at the Mac, when you ask for that", async () => {
    const old = new Date(Date.now() - 8 * 3_600_000).toISOString();
    const t = setup({ backlog: "trickle", backlogHours: 6 }, old);
    const r = await stageB({ db: t.db, config: t.config, llm: t.llm, mail: t.mail, contentDir: t.contentDir, sampleActivity: async () => here });
    expect(t.calls()).toBe(1);
    expect(r.pendingLeft).toBe(1);
    expect(r.deferred).toMatch(/read one item of the backlog/);

    // A young backlog, or the default setting: it waits for you to step away.
    const young = setup({ backlog: "trickle", backlogHours: 6 }, new Date().toISOString());
    expect((await stageB({ db: young.db, config: young.config, llm: young.llm, mail: young.mail, contentDir: young.contentDir, sampleActivity: async () => here })).deferred).toMatch(/^you're active/);
    expect(young.calls()).toBe(0);
    const never = setup({}, old);
    await stageB({ db: never.db, config: never.config, llm: never.llm, mail: never.mail, contentDir: never.contentDir, sampleActivity: async () => here });
    expect(never.calls()).toBe(0);
    // Busy or short of memory: no trickle either.
    const busy = setup({ backlog: "trickle", backlogHours: 6 }, old);
    await stageB({ db: busy.db, config: busy.config, llm: busy.llm, mail: busy.mail, contentDir: busy.contentDir, sampleActivity: async () => ({ ...here, memoryPressure: "warn" }) });
    expect(busy.calls()).toBe(0);
  });

  it("knows the overnight window, including one that wraps past midnight", () => {
    const at = (h: number) => new Date(2026, 10, 27, h, 30);
    const win = (from: number | null, to: number | null) => ({ overnightFrom: from, overnightTo: to });
    expect(inOvernightWindow(win(null, null), at(14))).toBe(true);
    expect([0, 1, 4, 5].map((h) => inOvernightWindow(win(1, 5), at(h)))).toEqual([false, true, true, false]);
    expect([21, 22, 3, 6, 12].map((h) => inOvernightWindow(win(22, 6), at(h)))).toEqual([false, true, true, false, false]);
  });
});
