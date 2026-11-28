// Bigger and more images per article, uploads in pieces, JSON feeds, and how often a feed is checked (2026-11-28).
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { cacheImages, MAX_IMAGES } from "../src/content/images.ts";
import { Graph } from "../src/microsoft/graph.ts";
import { AppFolder, UPLOAD_CHUNK_BYTES } from "../src/microsoft/onedrive.ts";
import { discoverFeed, parseFeed } from "../src/feeds/feed.ts";
import { describeCheckEvery, parseCheckEvery, stageAFeeds } from "../src/pipeline/stage-a-feeds.ts";
import { follow } from "../src/pipeline/following.ts";
import { editSource } from "../src/pipeline/sources.ts";
import type { MailPort } from "../src/pipeline/stage-a-email.ts";

const NOW = new Date("2026-11-28T12:00:00Z");
const MB = 1024 * 1024;

/** A fake web: url → [status, content-type, body]. */
function fakeWeb(pages: Record<string, [number, string, string | Uint8Array]>) {
  const requested: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    const page = pages[url];
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page[2] as BodyInit, { status: page[0], headers: { "content-type": page[1] } });
  }) as typeof fetch;
  return { f, requested };
}

describe("images in an article", () => {
  it("keeps images up to 15 MB, such as animated weather maps, and drops bigger ones", async () => {
    const web = fakeWeb({
      "https://img.example/radar.gif": [200, "image/gif", new Uint8Array(6 * MB)],
      "https://img.example/huge.gif": [200, "image/gif", new Uint8Array(16 * MB)],
    });
    const r = await cacheImages(`<img src="https://img.example/radar.gif"><img src="https://img.example/huge.gif">`, mkdtempSync(join(tmpdir(), "bs-img-")), web.f);
    expect(r.images.map((i) => i.bytes)).toEqual([6 * MB]);
    expect(r.html.match(/<img/g)).toHaveLength(1);
  });

  it(`keeps up to ${MAX_IMAGES} images, and ones that fail to download don't count`, async () => {
    const pages: Record<string, [number, string, Uint8Array]> = {};
    for (let i = 0; i < 70; i++) pages[`https://img.example/${i}.png`] = [200, "image/png", new Uint8Array([i, 1, 2])];
    const broken = Array.from({ length: 10 }, (_, i) => `<img src="https://img.example/broken-${i}.png">`).join("");
    const html = broken + Array.from({ length: 70 }, (_, i) => `<img src="https://img.example/${i}.png">`).join("");
    const r = await cacheImages(html, mkdtempSync(join(tmpdir(), "bs-img-")), fakeWeb(pages).f);
    expect(r.images).toHaveLength(MAX_IMAGES);
    expect(r.images.at(-1)!.url).toBe(`https://img.example/${MAX_IMAGES - 1}.png`);
  });
});

describe("uploading to OneDrive", () => {
  function fakeGraph() {
    const calls: { url: string; method: string; auth: boolean; range?: string; bytes?: number }[] = [];
    const f = (async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const headers = (init.headers ?? {}) as Record<string, string>;
      const body = init.body as Uint8Array | string | undefined;
      calls.push({ url, method: init.method ?? "GET", auth: "Authorization" in headers, range: headers["Content-Range"], bytes: typeof body === "string" ? body.length : body?.byteLength });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (url.endsWith(":/createUploadSession")) return json({ uploadUrl: "https://upload.example/session/1" });
      if (url.startsWith("https://upload.example/")) {
        const [, end, total] = headers["Content-Range"]!.match(/bytes \d+-(\d+)\/(\d+)/)!.map(Number);
        return end! + 1 === total ? json({ id: "big", size: total }, 201) : json({ nextExpectedRanges: [`${end! + 1}-`] }, 202);
      }
      return json({ id: "small", size: typeof body === "string" ? body.length : body?.byteLength });
    }) as typeof fetch;
    return { folder: new AppFolder(new Graph(async () => "token", { fetch: f })), calls };
  }

  it("uploads a small file in one go", async () => {
    const g = fakeGraph();
    expect(await g.folder.put("images/a.png", new Uint8Array(1000), "image/png")).toEqual({ id: "small", size: 1000 });
    expect(g.calls).toHaveLength(1);
  });

  it("uploads a file over 4 MB in pieces, through an upload session that takes no sign-in header", async () => {
    const g = fakeGraph();
    const size = 2 * UPLOAD_CHUNK_BYTES + 123;
    expect(await g.folder.put("images/radar.gif", new Uint8Array(size), "image/gif")).toEqual({ id: "big", size });
    expect(g.calls.map((c) => [c.method, c.url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, ""), c.auth, c.range ?? null])).toEqual([
      ["POST", "/me/drive/special/approot:/images/radar.gif:/createUploadSession", true, null],
      ["PUT", "https://upload.example/session/1", false, `bytes 0-${UPLOAD_CHUNK_BYTES - 1}/${size}`],
      ["PUT", "https://upload.example/session/1", false, `bytes ${UPLOAD_CHUNK_BYTES}-${2 * UPLOAD_CHUNK_BYTES - 1}/${size}`],
      ["PUT", "https://upload.example/session/1", false, `bytes ${2 * UPLOAD_CHUNK_BYTES}-${size - 1}/${size}`],
    ]);
  });
});

const jsonFeed = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "Garden Notes",
  home_page_url: "https://notes.example/",
  feed_url: "https://notes.example/feed.json",
  authors: [{ name: "Ann Lee" }],
  items: [
    { id: "1", url: "https://notes.example/frost", title: "Frost dates", content_html: "<p>Later this year.</p>", date_published: "2026-11-28T08:00:00Z" },
    { id: 2, url: "https://notes.example/bulbs", title: "Bulbs", content_text: "Plant them now.\n\nWater once.", image: "https://notes.example/bulbs.jpg", date_published: "2026-11-27T08:00:00Z", authors: [{ name: "Bo" }] },
  ],
});

describe("JSON feeds", () => {
  it("reads a JSON Feed: HTML or plain-text content, its image, and authors", () => {
    const f = parseFeed(jsonFeed);
    expect(f).toMatchObject({ title: "Garden Notes", siteUrl: "https://notes.example/" });
    expect(f.entries).toEqual([
      { guid: "1", url: "https://notes.example/frost", title: "Frost dates", author: "Ann Lee", publishedAt: "2026-11-28T08:00:00.000Z", html: "<p>Later this year.</p>" },
      { guid: "2", url: "https://notes.example/bulbs", title: "Bulbs", author: "Bo", publishedAt: "2026-11-27T08:00:00.000Z", html: '<p><img src="https://notes.example/bulbs.jpg" alt=""></p><p>Plant them now.</p><p>Water once.</p>' },
    ]);
    expect(() => parseFeed("{ not json")).toThrow(/JSON Feed/);
  });

  it("finds a site's JSON Feed from its page", async () => {
    const web = fakeWeb({
      "https://notes.example/": [200, "text/html", `<html><head><link rel="alternate" type="application/feed+json" href="/feed.json"></head></html>`],
      "https://notes.example/feed.json": [200, "application/feed+json", jsonFeed],
    });
    const r = await discoverFeed("https://notes.example/", web.f);
    expect(r.feedUrl).toBe("https://notes.example/feed.json");
    expect(r.feed.entries).toHaveLength(2);
  });
});

describe("how often a feed is checked", () => {
  it("reads and describes intervals from an hour to a week", () => {
    expect([parseCheckEvery("12h"), parseCheckEvery("1d"), parseCheckEvery("90 min"), parseCheckEvery("30m"), parseCheckEvery("8d"), parseCheckEvery("soon")]).toEqual([43200, 86400, 5400, null, null, null]);
    expect([describeCheckEvery(null), describeCheckEvery(43200), describeCheckEvery(86400)]).toEqual(["every hour", "every 12 hours", "once a day"]);
  });

  function setup() {
    const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
    const db = openDb(":memory:");
    syncConfig(db, config);
    const web = fakeWeb({ "https://notes.example/feed.json": [200, "application/feed+json", jsonFeed] });
    const contentDir = mkdtempSync(join(tmpdir(), "bs-feed-"));
    const next = () => (db.prepare("SELECT next_poll_at FROM feed_state").get() as { next_poll_at: string }).next_poll_at;
    return { config, db, web, contentDir, next };
  }

  it("follows a feed checked every 12 hours, and keeps to that after each check", async () => {
    const t = setup();
    const r = await follow(t.db, "https://notes.example/feed.json", { now: NOW.toISOString(), doFetch: t.web.f, checkEvery: 43200 });
    const out = await stageAFeeds({ db: t.db, config: t.config, contentDir: t.contentDir, now: NOW, doFetch: t.web.f });
    expect(out[0]).toMatchObject({ source: r.id, added: ["Frost dates", "Bulbs"] });
    expect(t.next()).toBe("2026-11-29T00:00:00.000Z");
    // Six hours on, it isn't due yet.
    expect(await stageAFeeds({ db: t.db, config: t.config, contentDir: t.contentDir, now: new Date("2026-11-28T18:00:00Z"), doFetch: t.web.f })).toEqual([]);
  });

  it("changing it from Admin brings the next check forward when the new interval is shorter", async () => {
    const t = setup();
    const r = await follow(t.db, "https://notes.example/feed.json", { now: NOW.toISOString(), doFetch: t.web.f, checkEvery: 86400 });
    await stageAFeeds({ db: t.db, config: t.config, contentDir: t.contentDir, now: NOW, doFetch: t.web.f });
    expect(t.next()).toBe("2026-11-29T12:00:00.000Z");
    const opts = { contentDir: t.contentDir, cutoff: "2026-11-20T00:00:00Z", now: "2026-11-28T13:00:00.000Z" };
    expect((await editSource(t.db, {} as MailPort, r.id, { checkEvery: 21600 }, opts)).changed).toEqual(["checked every 6 hours"]);
    expect(t.next()).toBe("2026-11-28T19:00:00.000Z");
    expect((await editSource(t.db, {} as MailPort, r.id, { checkEvery: null }, opts)).changed).toEqual(["checked every hour"]);
    expect(t.next()).toBe("2026-11-28T14:00:00.000Z");
  });

  it("is only for feeds", async () => {
    const t = setup();
    t.db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('mail', 'email', 'Mail', 'enabled', 'auto', 'x')").run();
    const r = await editSource(t.db, {} as MailPort, "mail", { checkEvery: 43200 }, { contentDir: t.contentDir, cutoff: "x", now: NOW.toISOString() });
    expect(r.errors).toEqual(["only a feed you follow by URL has a check interval"]);
  });
});
