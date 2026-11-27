import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { follow, guessSite, normaliseUrl, switchToFeed, unsubscribeLink } from "../src/pipeline/following.ts";
import { parseEmail } from "../src/content/email.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
const rss = (title: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title><link>https://garden.example/</link>
  ${[1, 2, 3].map((n) => `<item><title>Post ${n}</title><link>https://garden.example/p/${n}</link><guid>g${n}</guid><pubDate>Wed, 2${n} Nov 2026 10:00:00 GMT</pubDate><description>Words</description></item>`).join("")}
</channel></rss>`;

/** A pretend web: the site's page links to its feed. */
const web = (pages: Record<string, string>): typeof fetch =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = pages[url];
    return body === undefined ? new Response("", { status: 404 }) : Object.defineProperty(new Response(body, { status: 200 }), "url", { value: url });
  }) as typeof fetch;

const site = web({
  "https://garden.example/": `<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body>Hi</body></html>`,
  "https://garden.example/feed": rss("The Garden Letter"),
});

describe("following by URL", () => {
  it("previews, follows once, and names it from the feed", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    expect(normaliseUrl("garden.example")).toBe("https://garden.example/");
    const r = await follow(db, "garden.example", { section: "gardening", now: "2026-11-27T12:00:00Z", doFetch: site });
    expect(r).toMatchObject({ id: "the-garden-letter", name: "The Garden Letter" });
    expect(r.preview.entries.map((e) => e.title)).toEqual(["Post 3", "Post 2", "Post 1"]);
    expect(db.prepare("SELECT channel, site_url, feed_url, fixed_section_id, origin, status FROM sources WHERE id = 'the-garden-letter'").get()).toEqual({
      channel: "feed", site_url: "https://garden.example/", feed_url: "https://garden.example/feed", fixed_section_id: "gardening", origin: "auto", status: "enabled",
    });
    await expect(follow(db, "https://garden.example/", { now: "x", doFetch: site })).rejects.toThrow(/already follow this as "The Garden Letter"/);
    await expect(follow(db, "nothing.example", { now: "x", doFetch: web({}) })).rejects.toThrow(/No feed found/);
    await expect(follow(db, "garden.example/other", { section: "cooking", now: "x", doFetch: web({ "https://garden.example/other": rss("Other") }) })).rejects.toThrow(/No section "cooking"/);
  });

  it("switches an email newsletter to its feed, keeping the source", async () => {
    const db = openDb(":memory:");
    syncConfig(db, config);
    db.prepare(`INSERT INTO sources (id, channel, display_name, match_json, status, origin, created_at, unsubscribe_url) VALUES ('garden', 'email', 'Garden', '{"listId":"garden.substack.com"}', 'new', 'auto', 'x', 'https://garden.example/unsub?u=1')`).run();
    expect(guessSite(db, "garden")).toBe("https://garden.substack.com/");
    db.prepare("INSERT INTO items (id, source_id, channel, title, published_at, created_at, url) VALUES ('i', 'garden', 'email', 't', '2026-11-27', 'x', 'https://garden.example/p/tomatoes')").run();
    expect(guessSite(db, "garden")).toBe("https://garden.example/");
    const r = await switchToFeed(db, "garden", { doFetch: site });
    expect(r.unsubscribe).toBe("https://garden.example/unsub?u=1");
    expect(db.prepare("SELECT channel, feed_url, match_json, status FROM sources WHERE id = 'garden'").get()).toEqual({
      channel: "feed", feed_url: "https://garden.example/feed", match_json: '{"listId":"garden.substack.com"}', status: "enabled",
    });
    await expect(switchToFeed(db, "garden", { doFetch: site })).rejects.toThrow(/already followed/);
  });

  it("finds the unsubscribe link in an email, preferring a web page", async () => {
    expect(unsubscribeLink("<mailto:leave@x.example?subject=unsub>, <https://x.example/u/1>")).toBe("https://x.example/u/1");
    expect(unsubscribeLink("<mailto:leave@x.example>")).toBe("mailto:leave@x.example");
    expect(unsubscribeLink(undefined)).toBeNull();
    const e = await parseEmail(["From: A <a@x.example>", "Subject: Hi", "Message-ID: <1@x>", "List-Unsubscribe: <mailto:u@x.example>, <https://x.example/unsub>", "Content-Type: text/plain", "", "Hello"].join("\r\n"));
    expect(e.listUnsubscribe).toBe("https://x.example/unsub");
  });
});
