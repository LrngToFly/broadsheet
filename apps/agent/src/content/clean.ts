// Turn a newsletter's HTML into a clean article (PLAN.md §3.6 step 5):
//   - keep the article, drop the email "chrome": tracking pixels, icons, the "forwarded this email?" banner,
//     Like/Comment/Restack buttons and everything from the unsubscribe footer down
//     (Mozilla Readability, Firefox's Reader View engine, is kept for web pages: it throws away images in
//     table-based email layouts)
//   - remove tracking pixels and scripts, keep a safe set of tags (sanitize-html)
//   - drop utm_* tracking parameters from links
//   - plain text for word counts, the opening paragraphs and (later) Gemma
import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";
import { convert } from "html-to-text";

export type CleanArticle = {
  html: string;
  text: string;
  wordCount: number;
  /** The first paragraph or two, shown on the card until Gemma has summarized it. */
  opening: string;
  /** Every link in the original email (for "links to" rules). */
  links: string[];
  /** The post's web address, when the email gives one. */
  canonicalUrl: string | null;
  heroImage: string | null;
  images: string[];
};

const ALLOWED_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code",
  "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "sub", "sup", "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td", "div", "span",
];

const FOOTER = /^\s*(unsubscribe|manage (your )?(subscription|preferences|email settings)|you('re| are) (receiving|subscribed)|update your (email )?preferences|forwarded this email\?)/i;

export function stripTracking(href: string): string {
  try {
    const u = new URL(href);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return href;
  }
}

/** The post's web address: "open.substack.com/pub/NAME/p/SLUG" becomes "https://NAME.substack.com/p/SLUG";
 *  any other "https://site/p/SLUG" link (Substack custom domains, Ghost, beehiiv) loses its query string. */
export function canonicalFrom(links: string[]): string | null {
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l);
    } catch {
      continue;
    }
    const open = u.hostname === "open.substack.com" ? u.pathname.match(/^\/pub\/([\w-]+)\/p\/([\w-]+)/) : null;
    if (open) return `https://${open[1]}.substack.com/p/${open[2]}`;
    const post = u.pathname.match(/^\/p\/([\w-]+)\/?$/);
    if (post && u.hostname !== "substack.com") return `https://${u.hostname}/p/${post[1]}`;
  }
  return null;
}

/** Tracking pixels, hidden images, and small icons and avatars. */
function isChromeImage(img: Element): boolean {
  const w = Number(img.getAttribute("width"));
  const h = Number(img.getAttribute("height"));
  const style = img.getAttribute("style") ?? "";
  return (w > 0 && w <= 48) || (h > 0 && h <= 48) || /display\s*:\s*none/i.test(style);
}

const ACTION_LINKS = /^(like|comment|restack|share|leave a comment|reply|forward|subscribe|upgrade to paid|read in app|view in browser)$/i;
const BANNER = /^\s*forwarded this email\?/i;
const FOOTER_START = /unsubscribe|manage (your )?(subscription|preferences)|©\s*\d{4}|you('re| are) (currently )?(receiving|subscribed)/i;

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) out.push(n as Text);
    else n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

/** Remove the email's own chrome, leaving the post. Works on the DOM in place. */
function removeChrome(document: Document) {
  for (const el of document.querySelectorAll("script, style, noscript, iframe, form, head")) el.remove();
  // Hidden "preview text" that email apps show in the inbox list.
  for (const el of document.querySelectorAll("[style]")) {
    if (/display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all/i.test(el.getAttribute("style") ?? "")) el.remove();
  }
  for (const img of document.querySelectorAll("img")) if (isChromeImage(img)) img.remove();
  for (const a of document.querySelectorAll("a")) if (ACTION_LINKS.test((a.textContent ?? "").trim())) a.remove();

  const nodes = textNodes(document.body).filter((t) => (t.textContent ?? "").trim());
  const total = nodes.reduce((n, t) => n + (t.textContent ?? "").length, 0);

  // The "Forwarded this email? Subscribe here" banner near the top.
  for (const t of nodes.slice(0, 15)) if (BANNER.test(t.textContent ?? "")) t.parentElement?.remove();

  // Footer: the first unsubscribe/copyright line in the second half; drop it and everything after it.
  let seen = 0;
  for (const t of nodes) {
    seen += (t.textContent ?? "").length;
    if (seen < total * 0.5 || !FOOTER_START.test(t.textContent ?? "")) continue;
    const el = t.parentElement;
    if (!el) break;
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      while (n.nextSibling) n.nextSibling.remove();
    }
    el.remove();
    break;
  }

  // Containers left with no text and no image (deepest first, so emptied parents go too).
  const containers = [...document.querySelectorAll("div, span, p, td, tr, table, a")].reverse();
  for (const el of containers) if (!(el.textContent ?? "").trim() && !el.querySelector("img")) el.remove();
}

/** Zero-width and soft characters that email preview padding is made of. */
const INVISIBLE = /[\u034F\u00AD\u200B-\u200F\u2060\uFEFF]/g;

function opening(text: string, title: string, maxWords = 70): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const t = norm(title);
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .map((p) => (t && norm(p).startsWith(t) ? p.slice(Math.min(p.length, title.length)).trim() : p)) // drop a repeated title
    .filter((p) => p.split(" ").length >= 6);
  let out = "";
  for (const p of paras) {
    out = out ? `${out}\n\n${p}` : p;
    if (out.split(/\s+/).length >= maxWords / 2) break;
  }
  const words = out.split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : out;
}

export function cleanArticle(rawHtml: string | null, fallbackText: string, opts: { title?: string; listPost?: string | null } = {}): CleanArticle {
  const title = opts.title ?? "";
  if (!rawHtml) {
    const text = fallbackText.trim();
    return {
      html: text.split(/\n\s*\n/).map((p) => `<p>${sanitizeHtml(p, { allowedTags: [] })}</p>`).join("\n"),
      text,
      wordCount: countWords(text),
      opening: opening(text, title),
      links: [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]),
      canonicalUrl: null,
      heroImage: null,
      images: [],
    };
  }

  const { document } = parseHTML(`<!doctype html><html><body>${bodyOf(rawHtml)}</body></html>`);
  const links = [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!).filter((h) => /^https?:/i.test(h));
  removeChrome(document as unknown as Document);
  const chosen = document.body.innerHTML;

  const html = sanitizeHtml(chosen, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href"], img: ["src", "alt", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["https", "http", "mailto"],
    transformTags: {
      a: (tag, attribs) => ({ tagName: tag, attribs: attribs.href ? { href: stripTracking(attribs.href) } : ({} as Record<string, string>) }),
    },
  }).trim();

  let text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "table", format: "block" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => ({ selector: h, options: { uppercase: false } })),
    ],
  });
  const lines = text.split("\n");
  const cut = lines.findIndex((l, i) => i > lines.length * 0.5 && FOOTER.test(l));
  if (cut > 0) text = lines.slice(0, cut).join("\n");
  text = text.replace(INVISIBLE, "").replace(/\u00A0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const images = [...html.matchAll(/<img[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((m) => ({ src: m[1]!, tag: m[0] }));
  const hero = images.find(({ tag }) => {
    const w = Number(tag.match(/width="(\d+)"/)?.[1] ?? 0);
    return w === 0 || w >= 300;
  });

  return {
    html,
    text,
    wordCount: countWords(text),
    opening: opening(text, title),
    links,
    canonicalUrl: opts.listPost ? stripTracking(opts.listPost).replace(/\?$/, "") : canonicalFrom(links),
    heroImage: hero?.src ?? null,
    images: images.map((i) => i.src),
  };
}

export const countWords = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

function bodyOf(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1]! : html;
}

