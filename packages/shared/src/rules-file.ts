// rules.json in the OneDrive App Folder: what the reader's Rules page shows (PLAN.md §4.3, §8.1).
// SQLite on the Mac is the master copy; the reader changes rules only by sending actions (actions.ts).
import { z } from "zod";

export const RULES_FILE_SCHEMA_VERSION = 1;

const ItemRef = z.object({ id: z.string(), title: z.string(), source: z.string() });

export const RuleCard = z.object({
  id: z.string(),
  /** What the rule says, in plain words. */
  wording: z.string(),
  /** check: simple conditions, free and instant. instruction: plain English that Gemma applies. */
  kind: z.enum(["include", "check", "instruction"]),
  /** For a check rule, its conditions in words, e.g. 'subject contains "is live"'. */
  detail: z.string().nullable(),
  /** The one newsletter it's limited to, or null for all. */
  source: z.string().nullable(),
  status: z.enum(["active", "off"]),
  mail: z.enum(["deleted-items", "leave"]).nullable(),
  /** Items it hid in the last 30 days. */
  hits30d: z.number().int().nonnegative(),
  /** Gemma is redrafting it after you changed the wording. */
  redrafting: z.boolean().default(false),
});
export type RuleCard = z.infer<typeof RuleCard>;

export const Suggestion = z.object({
  /** The rule id it would get, or the request id while Gemma is still drafting. */
  id: z.string(),
  status: z.enum(["drafting", "ready", "failed"]),
  /** What started it: an item you hid, or words you typed. */
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hidden-item"), title: z.string(), reason: z.string().nullable(), note: z.string().nullable() }),
    z.object({ kind: z.literal("typed"), text: z.string() }),
  ]),
  wording: z.string().nullable(),
  ruleKind: z.enum(["check", "instruction"]).nullable(),
  detail: z.string().nullable(),
  source: z.string().nullable(),
  /** Current items it would hide (the last few days): so you can see whether it's too broad. */
  wouldHide: z.array(ItemRef),
  error: z.string().nullable(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const RulesFile = z.object({
  schemaVersion: z.literal(RULES_FILE_SCHEMA_VERSION),
  generatedAt: z.iso.datetime(),
  /** "In your own words", as last saved. */
  ownWords: z.object({ text: z.string(), updatedAt: z.iso.datetime().nullable() }),
  /** The profile Gemma wrote from your ratings, if any (read-only in the reader). */
  learnedProfile: z.object({ text: z.string(), builtAt: z.iso.datetime() }).nullable(),
  suggestions: z.array(Suggestion),
  rules: z.array(RuleCard),
});
export type RulesFile = z.infer<typeof RulesFile>;
