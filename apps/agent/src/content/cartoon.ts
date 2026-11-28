// A cartoon of the day in a newsletter ("Today's Cartoon, by A. N. Artist", the cartoon, then its caption in a
// separate line of text, not in the image), for newsletters set to show cartoons (sources.cartoon). Shown at the top
// of Everything Else.
import { parseHTML } from "linkedom";

export type Cartoon = {
  imageUrl: string;
  /** The image's description, for screen readers. */
  alt: string | null;
  /** The caption, when it's text under the image (many cartoons have none, or it's part of the drawing). */
  caption: string | null;
  artist: string | null;
};

const HEADING = /\btoday['’]s cartoon\b/i;
const STOP = /see more cartoons|more in humor|cartoons from this week/i;

/** The cartoon after a "Today's Cartoon" heading, its caption and artist; null if the email has none. */
export function extractCartoon(html: string): Cartoon | null {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const all = [...document.querySelectorAll("*")];
  const start = all.findIndex((el) => /^H[1-6]$|^P$|^STRONG$|^SPAN$/.test(el.tagName) && HEADING.test(el.textContent ?? "") && (el.textContent ?? "").length < 120);
  if (start < 0) return null;
  const heading = (all[start]!.textContent ?? "").replace(/\s+/g, " ").trim();
  const artist = heading.match(/\bby\s+(.+)$/i)?.[1]?.trim() ?? null;

  // The first image after the heading is the cartoon; text after it, before "See more cartoons" or the next heading,
  // is the caption.
  let image: Element | null = null;
  const captionParts: string[] = [];
  for (const el of all.slice(start + 1)) {
    if (!image) {
      if (el.tagName === "IMG" && el.getAttribute("src")) image = el;
      continue;
    }
    if (/^H[1-6]$/.test(el.tagName) || STOP.test(el.textContent ?? "") && el.tagName === "A") break;
    if (el.tagName === "P") {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (STOP.test(t)) break;
      if (t) captionParts.push(t);
    }
  }
  if (!image) return null;
  return {
    imageUrl: image.getAttribute("src")!,
    alt: image.getAttribute("alt")?.trim() || null,
    caption: captionParts.join(" ").slice(0, 500) || null,
    artist,
  };
}
