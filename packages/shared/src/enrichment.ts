// What Gemma returns for each item (PLAN.md §5). The JSON Schema in the prompt is generated from this,
// and the reply is validated against it in code because Ollama can't enforce schemas for gemma4:12b.
import { z } from "zod";

export function enrichmentSchema(sectionIds: readonly [string, ...string[]], instructionRuleIds: readonly string[] = []) {
  return z
    .object({
      is_article: z.boolean().describe("false for promotions, receipts, sign-in links, welcome or thank-you notes with no real content"),
      summary: z.string().min(20).max(1200).describe("3-5 sentence neutral summary"),
      key_points: z.array(z.string().min(1)).max(5),
      section: z.enum(sectionIds).describe("the single best section"),
      tags: z.array(z.string().min(1).max(40)).max(6),
      interest: z.number().int().min(0).max(100).describe("how likely this reader wants to read it"),
      why_its_here: z.string().min(1).max(200).describe("one short line explaining the interest score to the reader"),
      read_minutes: z.number().int().min(1).max(120),
      hidden_by_rule: (instructionRuleIds.length
        ? z.enum(instructionRuleIds as [string, ...string[]]).nullable()
        : z.null()
      ).describe("the id of the reader's rule this item breaks, or null"),
    })
    .strict();
}

export type Enrichment = z.infer<ReturnType<typeof enrichmentSchema>>;

/** JSON Schema text to embed in the prompt. */
export function enrichmentJsonSchema(schema: ReturnType<typeof enrichmentSchema>): string {
  return JSON.stringify(z.toJSONSchema(schema));
}
