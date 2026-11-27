// Split a roundup or multi-section newsletter into its pieces (PLAN.md §4.4), from the email's own structure
// and without AI: the headings over each story, or failing that, short bold lead-in lines. Gemma then reads
// each piece on its own, which is quicker and more reliable than asking it to take a whole newsletter apart.
import { parseHTML } from "linkedom";
import { countWords, htmlToText, isChromeImage, opening, stripTracking } from "./clean.ts";

export type Piece = {
  title: string;
  html: string;
  text: string;
  wordCount: number;
  opening: string;
  /** Its links (tracking already removed by the cleaner), to spot the same story in another newsletter. */
  links: string[];
};

/** A piece shorter than this is a heading with a line under it (a sponsor slot, a sign-off), not a story. */
const MIN_WORDS = 40;
/** A heading longer than this is a paragraph in a heading tag. */
const MAX_HEADING_WORDS = 20;
const BLOCK = new Set(["P", "UL", "OL", "BLOCKQUOTE", "FIGURE", "IMG", "FIGCAPTION", "PRE", "H1", "H2", "H3", "H4", "H5", "H6"]);
const CONTAINER = new Set(["DIV", "TD", "TH", "SPAN", "A", "TABLE", "TBODY", "THEAD", "TR", "CENTER", "SECTION", "ARTICLE"]);

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** How the pieces are marked: the heading level used most (at least 3 times), else bold lead-in paragraphs. */
function boundaryTest(body: Element): ((el: Element) => boolean) | null {
  let best: { tag: string; n: number } | null = null;
  for (const tag of ["H2", "H3", "H4", "H1"]) {
    const n = [...body.querySelectorAll(tag)].filter((h) => {
      const w = words(h.textContent ?? "");
      return w > 0 && w <= MAX_HEADING_WORDS;
    }).length;
    if (n >= 3 && (!best || n > best.n)) best = { tag, n };
  }
  if (best) {
    const tag = best.tag;
    return (el) => el.tagName === tag && words(el.textContent ?? "") > 0 && words(el.textContent ?? "") <= MAX_HEADING_WORDS;
  }
  // A paragraph that is only a short bold line ("**Markets slide**"), used as a heading.
  const boldLine = (el: Element) => {
    if (el.tagName !== "P") return false;
    const text = (el.textContent ?? "").trim();
    const bold = [...el.querySelectorAll("strong, b")].map((b) => (b.textContent ?? "").trim()).join(" ").trim();
    return Boolean(text) && bold === text && words(text) <= 12;
  };
  return [...body.querySelectorAll("p")].filter(boldLine).length >= 3 ? boldLine : null;
}

/** A list of short lines that make up most of a piece: the newsletter's table of contents. */
function isContents(blocks: Element[], total: number): boolean {
  let inShortItems = 0;
  for (const b of blocks) for (const li of b.tagName === "LI" ? [b] : [...b.querySelectorAll("li")]) {
    const w = words(li.textContent ?? "");
    if (w <= 8) inShortItems += w;
  }
  return total > 0 && inShortItems / total >= 0.6;
}

/**
 * The newsletter's pieces, in order. What comes before the first heading (the masthead, an intro) stays in the
 * whole newsletter only. Returns null when it doesn't split into at least two pieces, so it's kept as one article.
 */
export function splitPieces(html: string): Piece[] | null {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body as unknown as Element;
  // Tidy what an older cleaner let through: share-button images, and your address in links.
  for (const img of [...body.querySelectorAll("img")]) if (isChromeImage(img)) img.remove();
  for (const a of [...body.querySelectorAll("a[href]")]) a.setAttribute("href", stripTracking(a.getAttribute("href")!));
  const isBoundary = boundaryTest(body);
  if (!isBoundary) return null;

  const raw: { title: string; blocks: Element[] }[] = [];
  let current: { title: string; blocks: Element[] } | null = null;
  const hasBoundary = (el: Element) => [...el.querySelectorAll("*")].some(isBoundary);
  // In document order: each boundary starts a piece; each outermost block goes to the piece it's in.
  // Layout tables and divs are walked through, unless they hold text of their own and no boundary.
  const walk = (el: Element) => {
    if (isBoundary(el)) {
      current = { title: (el.textContent ?? "").replace(/\s+/g, " ").trim(), blocks: [] };
      raw.push(current);
      return;
    }
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && words(n.textContent ?? "") >= 3);
    if ((BLOCK.has(el.tagName) || (CONTAINER.has(el.tagName) && ownText)) && !hasBoundary(el)) {
      current?.blocks.push(el);
      return;
    }
    for (const child of [...el.children]) walk(child);
  };
  for (const child of [...body.children]) walk(child);

  const pieces: Piece[] = [];
  for (const r of raw) {
    const html = r.blocks.map((b) => b.outerHTML).join("\n");
    const text = htmlToText(html);
    const wordCount = countWords(text);
    if (!r.title || wordCount < MIN_WORDS || isContents(r.blocks, wordCount)) continue;
    const links = [...new Set(r.blocks.flatMap((b) => [...(b.tagName === "A" ? [b] : []), ...b.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "")))].filter((h) => /^https?:/i.test(h));
    pieces.push({ title: r.title, html, text, wordCount, opening: opening(text, r.title, 60), links });
  }
  return pieces.length >= 2 ? pieces : null;
}

/** "This looks like a roundup": five or more pieces of a paragraph or two each (a median of 60–200 words). A suggestion only;
 *  you confirm it, because a long essay with subheadings can look the same to a program. */
export function looksLikeRoundup(html: string): boolean {
  const pieces = splitPieces(html);
  if (!pieces || pieces.length < 5) return false;
  const sorted = pieces.map((p) => p.wordCount).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return median >= 60 && median <= 200;
}
