// What the reader sends the agent: files in ratings/ in the OneDrive App Folder (docs/phase-2.md).
// The reader can only write to its App Folder, so this is the whole channel from your phone to the Mac.
import { z } from "zod";

export const ACTIONS_SCHEMA_VERSION = 1;

const at = z.iso.datetime();
const itemId = z.string().min(1).max(64);

export const Rating = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
export type Rating = z.infer<typeof Rating>;

export const HideReason = z.enum(["not-article", "ad", "topic", "author"]);
export type HideReason = z.infer<typeof HideReason>;

export const ReaderAction = z.discriminatedUnion("type", [
  /** 👍 = 1, 👌 = 0, 👎 = -1; null takes a rating back. */
  z.object({ type: z.literal("rate"), itemId, rating: Rating.nullable(), at }),
  /** Move to another section; the email follows in Outlook. */
  z.object({ type: z.literal("move"), itemId, section: z.string().min(1), at }),
  /** Saved items are kept past the retention window. */
  z.object({ type: z.literal("save"), itemId, saved: z.boolean(), at }),
  /** "Don't show things like this" (P3). */
  z.object({ type: z.literal("hide"), itemId, reason: HideReason.nullable(), note: z.string().max(1000).nullable(), at }),
  /** "Show it again" from the Hidden list (P3). */
  z.object({ type: z.literal("unhide"), itemId, at }),
]);
export type ReaderAction = z.infer<typeof ReaderAction>;

export const ActionsFile = z.object({
  schemaVersion: z.literal(ACTIONS_SCHEMA_VERSION),
  /** A random id per browser or home-screen app, so files from two devices never collide. */
  device: z.string().regex(/^[a-z0-9]{6,32}$/),
  createdAt: at,
  actions: z.array(ReaderAction).min(1).max(500),
});
export type ActionsFile = z.infer<typeof ActionsFile>;
