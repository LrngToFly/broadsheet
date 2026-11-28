// Find and read RSS, Atom and JSON Feed feeds (PLAN.md §3.3; JSON Feed: https://jsonfeed.org/version/1.1).
import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";

export const USER_AGENT = "Mozilla/5.0 (Macintosh) TheBroadsheet/1.0 (+personal feed reader)";

export type FeedEntry = {
  /** The entry's id (guid), or its link if it has none. */
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  publishedAt: string; // ISO
  html: string;
};
export type Feed = { title: string; siteUrl: string | null; entries: FeedEntry[] };

const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"] ?? "");
  return "";
};
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const iso = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/** Feed types a site's <link rel="alternate"> can name, and what the agent asks a server for. */
const FEED_TYPE = /rss|atom|feed\+json|application\/json/i;
export const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/xml, application/json;q=0.9, text/html;q=0.8";

const isJsonFeed = (body: string) => /^\s*\{/.test(body) && /jsonfeed\.org\/version\//i.test(body.slice(0, 2000));

export function looksLikeFeed(body: string): boolean {
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(body.slice(0, 2000)) || isJsonFeed(body);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A JSON Feed (1.0 or 1.1): content_html, or content_text turned into paragraphs, or the summary. */
function parseJsonFeed(body: string): Feed {
  let doc: any;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("not a valid JSON Feed");
  }
  if (!Array.isArray(doc?.items)) throw new Error("not a valid JSON Feed (no items)");
  const authorOf = (x: any) => str((Array.isArray(x?.authors) ? x.authors[0] : x?.author)?.name) || null;
  return {
    title: str(doc.title),
    siteUrl: str(doc.home_page_url) || null,
    entries: doc.items.map((it: any) => {
      const url = str(it.url) || str(it.external_url) || null;
      const textBody = str(it.content_text);
      const html =
        str(it.content_html) ||
        (textBody ? textBody.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join("") : "") ||
        (str(it.summary) ? `<p>${escapeHtml(str(it.summary))}</p>` : "");
      return {
        guid: str(it.id) || url || str(it.title),
        url,
        title: str(it.title) || "(untitled)",
        author: authorOf(it) ?? authorOf(doc),
        publishedAt: iso(str(it.date_published) || str(it.date_modified)),
        html: str(it.image) && !html.includes(str(it.image)) ? `<p><img src="${escapeHtml(str(it.image))}" alt=""></p>${html}` : html,
      };
    }),
  };
}

export function parseFeed(xml: string): Feed {
  if (/^\s*\{/.test(xml)) return parseJsonFeed(xml);
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" }).parse(xml);

  if (doc.rss?.channel || doc["rdf:RDF"]) {
    const ch = doc.rss?.channel ?? doc["rdf:RDF"].channel;
    const items = list(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    return {
      title: text(ch?.title),
      siteUrl: text(ch?.link) || null,
      entries: items.map((it: any) => {
        const url = text(it.link) || null;
        return {
          guid: text(it.guid) || url || text(it.title),
          url,
          title: text(it.title) || "(untitled)",
          author: text(it["dc:creator"] ?? it.author) || null,
          publishedAt: iso(text(it.pubDate ?? it["dc:date"])),
          html: text(it["content:encoded"]) || text(it.description),
        };
      }),
    };
  }

  if (doc.feed) {
    const f = doc.feed;
    const linkOf = (links: any) => {
      const all = list(links);
      const alt = all.find((l: any) => !l["@rel"] || l["@rel"] === "alternate");
      return alt?.["@href"] ?? null;
    };
    return {
      title: text(f.title),
      siteUrl: linkOf(f.link),
      entries: list(f.entry).map((e: any) => ({
        guid: text(e.id) || linkOf(e.link) || text(e.title),
        url: linkOf(e.link),
        title: text(e.title) || "(untitled)",
        author: text(list(e.author)[0] && (list(e.author)[0] as any).name) || null,
        publishedAt: iso(text(e.published ?? e.updated)),
        html: text(e.content) || text(e.summary),
      })),
    };
  }
  throw new Error("not an RSS, Atom or JSON feed");
}

/** Find the feed for a site or feed address: the address itself, the page's <link rel="alternate">, or the usual paths. */
export async function discoverFeed(url: string, doFetch: typeof fetch = fetch): Promise<{ feedUrl: string; feed: Feed }> {
  const get = async (u: string) => {
    const res = await doFetch(u, { headers: { "User-Agent": USER_AGENT, Accept: FEED_ACCEPT }, signal: AbortSignal.timeout(20_000), redirect: "follow" });
    return { ok: res.ok, url: res.url || u, body: res.ok ? await res.text() : "" };
  };

  const first = await get(url);
  if (first.ok && looksLikeFeed(first.body)) return { feedUrl: first.url, feed: parseFeed(first.body) };

  const candidates: string[] = [];
  if (first.ok) {
    const { document } = parseHTML(first.body);
    for (const l of document.querySelectorAll('link[rel="alternate"]')) {
      const type = l.getAttribute("type") ?? "";
      const href = l.getAttribute("href");
      if (href && FEED_TYPE.test(type)) candidates.push(new URL(href, first.url).toString());
    }
  }
  const base = new URL(first.url);
  for (const path of ["/feed", "/rss/", "/feed/", "/rss.xml", "/atom.xml", "/index.xml", "/feed.json", "/index.json"]) candidates.push(new URL(path, base.origin).toString());

  for (const c of [...new Set(candidates)]) {
    const r = await get(c).catch(() => null);
    if (r?.ok && looksLikeFeed(r.body)) return { feedUrl: r.url, feed: parseFeed(r.body) };
  }
  throw new Error(`No feed found for ${url}. If the site has a newsletter, subscribe by email instead.`);
}
