// Rules (PLAN.md §3.2 and §4.3).
//   include      shared-mailbox mode only: which emails to process
//   check        simple conditions tested in Stage A, before any AI
//   instruction  plain-English text that Gemma applies in Stage B
import { z } from "zod";

export const ConditionField = z.enum([
  "sender", // full sender address
  "domain", // sender's domain
  "subject",
  "listId", // the List-Id header
  "body", // the cleaned plain text
  "linksTo", // any link URL in the body
  "wordCount", // words in the cleaned plain text
]);

export const Condition = z.union([
  z.object({
    field: ConditionField.exclude(["wordCount"]),
    op: z.enum(["contains", "equals", "matches"]), // matches = regular expression, case-insensitive
    value: z.string().min(1),
  }),
  z.object({
    field: z.literal("wordCount"),
    op: z.enum(["lessThan", "greaterThan"]),
    value: z.number().int().nonnegative(),
  }),
]);
export type Condition = z.infer<typeof Condition>;

const common = {
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** What you said, in your own words. Shown in the reader and Admin. */
  wording: z.string().min(1).max(500),
  /** Limit the rule to one source (by source id). Omit for all sources. */
  source: z.string().optional(),
  status: z.enum(["active", "off"]).default("active"),
};

export const IncludeRule = z.object({
  ...common,
  kind: z.literal("include"),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(Condition).min(1),
  /** Send matching items straight to this section. */
  section: z.string().optional(),
});

export const CheckRule = z.object({
  ...common,
  kind: z.literal("check"),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(Condition).min(1),
  /** What happens to a matching email: Deleted Items, or left in the Inbox. */
  mail: z.enum(["deleted-items", "leave"]).default("deleted-items"),
});

export const InstructionRule = z.object({
  ...common,
  kind: z.literal("instruction"),
  /** The text Gemma is given, e.g. "Skip posts that are mostly an ad for the author's course." */
  instruction: z.string().min(1).max(500),
  mail: z.enum(["deleted-items", "leave"]).default("deleted-items"),
});

export const Rule = z.discriminatedUnion("kind", [IncludeRule, CheckRule, InstructionRule]);
export type Rule = z.infer<typeof Rule>;
export type CheckRule = z.infer<typeof CheckRule>;
export type InstructionRule = z.infer<typeof InstructionRule>;
