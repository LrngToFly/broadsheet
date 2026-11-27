import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { decrypt, encrypt, encryptedCachePlugin, type KeyStore } from "../src/microsoft/token-cache.ts";
import { Graph, GraphError } from "../src/microsoft/graph.ts";
import { checkFolders, ensureFolders } from "../src/microsoft/mail-folders.ts";
import { openDb, syncConfig } from "../src/db/db.ts";
import { aiMayRun, type ActivitySample } from "../src/activity.ts";

describe("token cache encryption", () => {
  const key = randomBytes(32);

  it("round-trips, and detects tampering or the wrong key", () => {
    const box = encrypt('{"refresh":"secret"}', key);
    expect(box.toString("utf8")).not.toContain("secret");
    expect(decrypt(box, key)).toBe('{"refresh":"secret"}');
    const tampered = Buffer.from(box);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decrypt(tampered, key)).toThrow();
    expect(() => decrypt(box, randomBytes(32))).toThrow();
  });

  it("writes an encrypted file through the MSAL plugin, creating the key on first save", async () => {
    let stored: Buffer | null = null;
    const keys: KeyStore = {
      get: async () => stored,
      create: async () => (stored = randomBytes(32)),
      remove: async () => void (stored = null),
    };
    const file = join(mkdtempSync(join(tmpdir(), "bs-")), "cache.bin");
    const plugin = encryptedCachePlugin(file, keys);
    let saved = "";
    const ctx = (changed: boolean) =>
      ({
        cacheHasChanged: changed,
        tokenCache: { serialize: () => '{"a":1}', deserialize: (s: string) => (saved = s) },
      }) as any;

    await plugin.beforeCacheAccess(ctx(false)); // no file yet: nothing happens
    await plugin.afterCacheAccess(ctx(true));
    expect(stored).not.toBeNull();
    expect(readFileSync(file).toString("utf8")).not.toContain('"a"');
    await encryptedCachePlugin(file, keys).beforeCacheAccess(ctx(false));
    expect(saved).toBe('{"a":1}');
  });
});

/** A fake Graph server: a list of [method + path matcher, handler]. */
function fakeFetch(routes: [RegExp, (url: URL, init: RequestInit) => Response][]) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const route = routes.find(([re]) => re.test(key));
    if (!route) return new Response(JSON.stringify({ error: { code: "NotFound", message: key } }), { status: 404 });
    return route[1](url, init);
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("Graph client", () => {
  it("waits and retries when throttled", async () => {
    let n = 0;
    const waits: number[] = [];
    const { f } = fakeFetch([[/GET \/v1.0\/me$/, () => (++n < 3 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : json({ id: "me" }))]]);
    const g = new Graph(async () => "t", { fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(await g.call("/me")).toEqual({ id: "me" });
    expect(waits).toEqual([2000, 2000]);
  });

  it("follows paging links", async () => {
    const { f } = fakeFetch([
      [/GET \/v1.0\/me\/things$/, (url) => (url.searchParams.get("page") === "2" ? json({ value: [3] }) : json({ value: [1, 2], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/things?page=2" }))],
    ]);
    expect(await new Graph(async () => "t", { fetch: f }).all("/me/things")).toEqual([1, 2, 3]);
  });

  it("reports Graph's error code", async () => {
    const { f } = fakeFetch([[/GET/, () => json({ error: { code: "ErrorAccessDenied", message: "no" } }, 403)]]);
    await expect(new Graph(async () => "t", { fetch: f }).call("/me")).rejects.toMatchObject({ status: 403, code: "ErrorAccessDenied" } satisfies Partial<GraphError>);
  });
});

describe("Outlook section folders", () => {
  const config = Config.parse({
    microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
    sections: [
      { id: "tech", name: "Technology" },
      { id: "everything-else", name: "Everything Else" },
    ],
  });

  function mailbox() {
    const top = [{ id: "inbox", displayName: "Inbox" }, { id: "R", displayName: "The Broadsheet" }];
    const children = [{ id: "S", displayName: "_Sorting" }, { id: "T", displayName: "Tech News" }];
    let next = 0;
    return fakeFetch([
      [/GET \/v1.0\/me\/mailFolders$/, () => json({ value: top })],
      [/GET \/v1.0\/me\/mailFolders\/R\/childFolders$/, () => json({ value: children })],
      [/POST \/v1.0\/me\/mailFolders\/R\/childFolders$/, (_u, init) => {
        const made = { id: `N${++next}`, displayName: JSON.parse(String(init.body)).displayName };
        children.push(made);
        return json(made, 201);
      }],
      [/PATCH \/v1.0\/me\/mailFolders\/T$/, (_u, init) => {
        children.find((c) => c.id === "T")!.displayName = JSON.parse(String(init.body)).displayName;
        return json({});
      }],
    ]);
  }

  it("finds folders by name, and by remembered id after a rename", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("UPDATE sections SET mail_folder_id = 'T' WHERE id = 'tech'").run();
    const { f } = mailbox();
    const r = await checkFolders(new Graph(async () => "t", { fetch: f }), config, db);
    expect(r.root.id).toBe("R");
    expect(r.folders.map((x) => [x.key, x.status])).toEqual([
      ["tech", "rename"],
      ["everything-else", "missing"],
      ["_sorting", "ok"],
      ["_add", "missing"],
    ]);
  });

  it("creates what's missing, renames what changed, and never deletes", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("UPDATE sections SET mail_folder_id = 'T' WHERE id = 'tech'").run();
    const { f, calls } = mailbox();
    const graph = new Graph(async () => "t", { fetch: f });
    const r = await ensureFolders(graph, config, db);
    expect(r.changes).toEqual([
      'renamed "Tech News" → "Technology"',
      'created "The Broadsheet/Everything Else"',
      'created "The Broadsheet/_Add"',
    ]);
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect((await checkFolders(graph, config, db)).folders.every((x) => x.status === "ok")).toBe(true);
    expect(db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_add'").get()).toEqual({ value: "N2" });
  });
});

describe("when AI work may run", () => {
  const p = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } }).politeness;
  const calm: ActivitySample = { idleSeconds: 3600, screenLocked: false, lowPowerMode: false, memoryPressure: "normal", thermal: "none", load5m: 1 };

  it("runs when you've been away long enough, or the screen is locked", () => {
    expect(aiMayRun(calm, p).ok).toBe(true);
    expect(aiMayRun({ ...calm, idleSeconds: 5, screenLocked: true }, p).ok).toBe(true);
  });

  it("waits while you're active or the Mac is under strain", () => {
    expect(aiMayRun({ ...calm, idleSeconds: 120 }, p)).toEqual({ ok: false, reason: "you're active (idle 2 of 10 min)" });
    expect(aiMayRun({ ...calm, memoryPressure: "warn" }, p).ok).toBe(false);
    expect(aiMayRun({ ...calm, lowPowerMode: true, screenLocked: true }, p).ok).toBe(false);
    expect(aiMayRun({ ...calm, load5m: 9 }, p).ok).toBe(false);
  });
});
