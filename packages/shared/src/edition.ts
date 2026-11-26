// edition.json in the OneDrive App Folder: what the reader shows (PLAN.md §7.3).
// The agent writes item files first, then replaces edition.json in one step.
import { z } from "zod";
import { Section } from "./sections.ts";

export const EDITION_SCHEMA_VERSION = 1;

export const ItemCard = z.object({
  id: z.string(),
  title: z.string(),
  /** Display name of the source, e.g. the publication. */
  source: z.string(),
  author: z.string().nullable(),
  channel: z.enum(["email", "feed"]),
  publishedAt: z.iso.datetime(),
  /** Link to the post on the web, if there is one. */
  url: z.url().nullable(),
  section: z.string(),
  /** "pending" until Gemma has read it; the card then shows the opening paragraphs. */
  status: z.enum(["pending", "summarized"]),
  opening: z.string(),
  summary: z.string().nullable(),
  keyPoints: z.array(z.string()),
  tags: z.array(z.string()),
  whyItsHere: z.string().nullable(),
  readMinutes: z.number().int().positive(),
  score: z.number(),
  /** Path of the hero image in the App Folder, e.g. "images/ab12.webp". */
  image: z.string().nullable(),
  /** Path of the full article, e.g. "items/<id>.html". */
  content: z.string(),
});
export type ItemCard = z.infer<typeof ItemCard>;

export const Edition = z.object({
  schemaVersion: z.literal(EDITION_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  sections: z.array(Section),
  /** Sorted by score, highest first. The Front Page and each section tab filter this list. */
  items: z.array(ItemCard),
});
export type Edition = z.infer<typeof Edition>;
