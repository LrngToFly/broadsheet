import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Edition } from "@broadsheet/shared";
import { discoverFeed, parseFeed } from "../src/feeds/feed.ts";
import { cacheImages } from "../src/content/images.ts";
import { publish, freshness } from "../src/pipeline/publish.ts";
import { stageAFeeds, feedItemId } from "../src/pipeline/stage-a-feeds.ts";
import { openDb, syncConfig } from "../src/db/db.ts";

const NOW = new Date("2026-11-27T12:00:00Z");
const longText = (topic: string) => `<p>${`${topic} matters for this garden because the soil warms slowly in late autumn. `.repeat(20)}</p>`;

const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Garden Blog</title><link>https://garden.example</link>
<item><title>Full post</title><link>https://garden.example/p/full</link><guid>g1</guid><dc:creator>Ann</dc:creator>
  <pubDate>Thu, 27 Nov 2026 08:00:00 GMT</pubDate><content:encoded><![CDATA[${longText("Mulch")}]]></content:encoded></item>
<item><title>Teaser post</title><link>https://garden.example/p/teaser</link><guid>g2</guid>
  <pubDate>Thu, 27 Nov 2026 09:00:00 GMT</pubDate><description>Just a short teaser.</description></item>
<item><title>Old post</title><link>https://garden.example/p/old</link><guid>g3</guid>
  <pubDate>Sat, 01 Nov 2026 09:00:00 GMT</pubDate><description>Too old.</description></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>
<link rel="alternate" href="https://atom.example/"/><link rel="self" href="https://atom.example/atom.xml"/>
<entry><id>tag:a,1</id><title>Hello</title><link rel="alternate" href="https://atom.example/hello"/>
<published>2026-11-26T10:00:00Z</published><author><name>Bo</name></author><content type="html">&lt;p&gt;Hi there&lt;/p&gt;</content></entry></feed>`;

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

describe("feeds", () => {
  it("reads RSS and Atom", () => {
    const r = parseFeed(rss);
    expect(r.title).toBe("Garden Blog");
    expect(r.entries[0]).toMatchObject({ guid: "g1", url: "https://garden.example/p/full", author: "Ann", publishedAt: "2026-11-27T08:00:00.000Z" });
    expect(r.entries[0]!.html).toContain("Mulch matters");
    const a = parseFeed(atom);
    expect(a).toMatchObject({ title: "Atom Blog", siteUrl: "https://atom.example/" });
    expect(a.entries[0]).toMatchObject({ guid: "tag:a,1", url: "https://atom.example/hello", author: "Bo", html: "<p>Hi there</p>" });
  });

  it("finds the feed from a site's page, or from the usual paths", async () => {
    const page = `<html><head><link rel="alternate" type="application/rss+xml" href="/my-feed.xml"></head></html>`;
    const web = fakeWeb({ "https://garden.example/": [200, "text/html", page], "https://garden.example/my-feed.xml": [200, "application/rss+xml", rss] });
    expect((await discoverFeed("https://garden.example/", web.f)).feedUrl).toBe("https://garden.example/my-feed.xml");
    const web2 = fakeWeb({ "https://sub.example/": [200, "text/html", "<html></html>"], "https://sub.example/feed": [200, "application/xml", rss] });
    expect((await discoverFeed("https://sub.example/", web2.f)).feedUrl).toBe("https://sub.example/feed");
    await expect(discoverFeed("https://nothing.example/", fakeWeb({}).f)).rejects.toThrow(/No feed found/);
  });

  it("adds new posts in the window, fetches the web page for teasers, and remembers what it saw", async () => {
    const config = Config.parse({
      microsoft: { clientId: "11111111-2222-3333-4444-555555555555" },
      sources: [{ id: "garden-blog", channel: "feed", url: "https://garden.example/", section: "gardening" }],
    });
    const db = openDb(":memory:");
    syncConfig(db, config);
    const web = fakeWeb({
      "https://garden.example/": [200, "application/rss+xml", rss],
      "https://garden.example/p/teaser": [200, "text/html", `<html><body><article><h1>Teaser post</h1>${longText("Compost")}</article></body></html>`],
    });
    const contentDir = mkdtempSync(join(tmpdir(), "bs-feed-"));
    const out = await stageAFeeds({ db, config, contentDir, now: NOW, doFetch: web.f });
    expect(out[0]).toMatchObject({ source: "garden-blog", added: ["Full post", "Teaser post"] });

    const rows = db.prepare("SELECT id, content_origin, is_teaser, section_id, section_source FROM items ORDER BY title").all();
    expect(rows).toEqual([
      { id: feedItemId("g1"), content_origin: "feed", is_teaser: 0, section_id: "gardening", section_source: "fixed" },
      { id: feedItemId("g2"), content_origin: "web", is_teaser: 0, section_id: "gardening", section_source: "fixed" },
    ]);
    expect(db.prepare("SELECT feed_url FROM sources WHERE id = 'garden-blog'").get()).toEqual({ feed_url: "https://garden.example/" });

    // Not due again for an hour; when forced, nothing is added twice.
    expect(await stageAFeeds({ db, config, contentDir, now: NOW, doFetch: web.f })).toEqual([]);
    const again = await stageAFeeds({ db, config, contentDir, now: NOW, doFetch: web.f, force: true });
    expect(again[0]!.added).toEqual([]);
  });

  it("backs off when a feed fails", async () => {
    const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" }, sources: [{ id: "x", channel: "feed", url: "https://broken.example/" }] });
    const db = openDb(":memory:");
    syncConfig(db, config);
    const out = await stageAFeeds({ db, config, contentDir: mkdtempSync(join(tmpdir(), "bs-")), now: NOW, doFetch: fakeWeb({}).f });
    expect(out[0]!.status).toBe("error");
    expect(db.prepare("SELECT poll_interval_s, last_error IS NOT NULL e FROM feed_state").get()).toEqual({ poll_interval_s: 7200, e: 1 });
  });
});

describe("images", () => {
  it("caches images, points the article at the copies, and drops ones it can't fetch", async () => {
    const png = new Uint8Array(20_000).fill(7);
    const web = fakeWeb({ "https://cdn.example/a.png": [200, "image/png", png], "https://cdn.example/page": [200, "text/html", "<html>"] });
    const dir = mkdtempSync(join(tmpdir(), "bs-img-"));
    const html = `<p>Hi</p><img src="https://cdn.example/a.png"><img src="https://cdn.example/a.png"><a href="x"><img src="https://cdn.example/missing.png"></a><img src="https://cdn.example/page">`;
    const r = await cacheImages(html, dir, web.f);
    expect(r.images).toHaveLength(1);
    expect(r.hero).toBe(r.images[0]!.path);
    expect(r.html).not.toMatch(/src="https?:/);
    expect(r.html.match(/data-src="images\/[0-9a-f]{20}\.png"/g)).toHaveLength(2);
    expect(r.html).not.toContain("<a");
    expect(web.requested.filter((u) => u.endsWith("a.png"))).toHaveLength(1); // fetched once
  });
});

describe("publishing the edition", () => {
  it("uploads each article once, then writes a valid edition.json last", async () => {
    const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare("INSERT INTO sources (id, channel, display_name, status, origin, created_at) VALUES ('s', 'email', 'Garden Letter', 'enabled', 'auto', 'x')").run();
    const contentDir = mkdtempSync(join(tmpdir(), "bs-pub-"));
    const add = (id: string, publishedAt: string, extra = "") => {
      db.prepare(`INSERT INTO items (id, source_id, channel, title, published_at, opening, word_count, created_at ${extra ? ", hidden_by" : ""})
                  VALUES (?, 's', 'email', ?, ?, 'Opening…', 460, 'x' ${extra ? ", ?" : ""})`).run(...[id, `Post ${id}`, publishedAt, ...(extra ? [extra] : [])]);
      mkdirSync(join(contentDir, id), { recursive: true });
      writeFileSync(join(contentDir, id, "article.html"), "<p>Body</p>");
    };
    add("new", "2026-11-27T11:00:00Z");
    add("older", "2026-11-25T11:00:00Z");
    add("expired", "2026-11-20T11:00:00Z");
    add("hidden", "2026-11-27T11:00:00Z", "no-promos");

    const puts: string[] = [];
    let edition: unknown;
    const appFolder = {
      put: async (path: string) => (puts.push(path), { id: path, size: 1 }),
      putJson: async (path: string, value: unknown) => {
        puts.push(path);
        edition = value;
        return { id: path, size: 1 };
      },
    };
    const r = await publish({ db, appFolder, config, contentDir, now: NOW, fetchImage: fakeWeb({}).f });
    expect(r).toMatchObject({ items: 2, uploadedItems: 2, errors: [] });
    expect(puts.at(-1)).toBe("edition.json");
    const e = Edition.parse(edition);
    expect(e.items.map((i) => i.id)).toEqual(["new", "older"]);
    expect(e.items[0]).toMatchObject({ status: "pending", source: "Garden Letter", section: "everything-else", readMinutes: 2, content: "items/new.html" });

    puts.length = 0;
    await publish({ db, appFolder, config, contentDir, now: NOW });
    expect(puts).toEqual(["edition.json"]); // articles aren't uploaded twice
  });

  it("scores newest first until Gemma ranks things", () => {
    expect(freshness("2026-11-27T12:00:00Z", NOW, 4)).toBe(1);
    expect(freshness("2026-11-25T12:00:00Z", NOW, 4)).toBe(0.5);
    expect(freshness("2026-11-01T12:00:00Z", NOW, 4)).toBe(0);
  });
});
