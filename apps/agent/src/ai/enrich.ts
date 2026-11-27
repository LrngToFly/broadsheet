// Ask the model to summarize, section and score one item (PLAN.md §5). Ollama can't enforce a JSON
// schema for gemma4:12b, so the schema goes in the prompt and the reply is checked in code: one retry
// with the validation error, then the item is marked failed and tried again on a later run.
import { z } from "zod";
import { enrichmentJsonSchema, enrichmentSchema, FALLBACK_SECTION_ID, type Enrichment } from "@broadsheet/shared";
import type { ChatMessage, LlmProvider } from "./provider.ts";
import { SCORING_GUIDE } from "./profile.ts";

export type EnrichInput = {
  title: string;
  source: string;
  author: string | null;
  text: string;
  /** A section the source is fixed to: the model is told, and its choice is ignored. */
  fixedSection: string | null;
  /** One piece of a split newsletter (PLAN.md §4.4): a brief from a roundup, or an article from a multi-section one. */
  piece?: { kind: "brief" | "article"; newsletter: string } | null;
};

export type EnrichContext = {
  sections: { id: string; name: string }[];
  instructionRules: { id: string; instruction: string; sourceId: string | null }[];
  sourceId: string;
  readerProfile: string;
  numCtx: number;
};

export type EnrichResult =
  | { ok: true; data: Enrichment; attempts: number; seconds: number; truncated: boolean }
  | { ok: false; error: string; attempts: number; seconds: number };

/** Roughly how many characters of article fit, leaving room for the instructions and the reply. */
export const maxArticleChars = (numCtx: number) => Math.max(4000, (numCtx - 3000) * 3);

export function buildMessages(item: EnrichInput, ctx: EnrichContext): { messages: ChatMessage[]; schema: ReturnType<typeof enrichmentSchema>; truncated: boolean } {
  const rules = ctx.instructionRules.filter((r) => !r.sourceId || r.sourceId === ctx.sourceId);
  const schema = enrichmentSchema(ctx.sections.map((s) => s.id) as [string, ...string[]], rules.map((r) => r.id));
  const limit = maxArticleChars(ctx.numCtx);
  const truncated = item.text.length > limit;
  const text = truncated ? `${item.text.slice(0, limit)}\n[… the rest of the article is cut for length]` : item.text;

  const system = [
    `You are the editor of "The Broadsheet", a private newspaper built from one reader's newsletters.`,
    `For the item you are given, reply with ONLY a JSON object (no prose, no code fence) matching this JSON Schema:`,
    enrichmentJsonSchema(schema),
    ``,
    `Sections (use the id):`,
    ...ctx.sections.map((s) => `- ${s.id}: ${s.name}`),
    ``,
    `Be accurate and neutral; never invent facts that are not in the text.`,
    `Choose the single most specific section that fits, even loosely. Use ${FALLBACK_SECTION_ID} only when no other section fits at all.`,
    `Set is_article to false ONLY when the email's main purpose is to sell something (a sale, discount or upgrade offer), to ask for money or votes, or to manage an account (receipt, sign-in, welcome).`,
    `Everything else IS an article, including short posts, personal essays, holiday reflections, and video or podcast posts with a description. When unsure, set is_article to true.`,
    `Tags are 1-3 word topics, lower case.`,
    rules.length
      ? [`The reader has these rules. If the item clearly breaks one, set hidden_by_rule to its id; otherwise null:`, ...rules.map((r) => `- ${r.id}: ${r.instruction}`)].join("\n")
      : `Set hidden_by_rule to null.`,
    ``,
    SCORING_GUIDE,
    ``,
    `The reader:`,
    ctx.readerProfile.trim() ||
      `No description or ratings yet. They follow these sections: ${ctx.sections.map((s) => s.name).join(", ")}. Score on substance: original reporting and analysis high, thin or promotional posts low.`,
  ].join("\n");

  const user = [
    `Title: ${item.title}`,
    `Source: ${item.source}${item.author ? ` (by ${item.author})` : ""}`,
    item.fixedSection ? `This source always goes in section "${item.fixedSection}".` : ``,
    item.piece?.kind === "brief"
      ? `This is ONE short story from the roundup newsletter "${item.piece.newsletter}". Judge it on its own. Write the summary in 1-2 sentences; key_points may be empty.`
      : item.piece
        ? `This is one piece of the newsletter "${item.piece.newsletter}", which covers several subjects. Judge it on its own.`
        : ``,
    ``,
    text,
  ].join("\n");

  return { messages: [{ role: "system", content: system }, { role: "user", content: user }], schema, truncated };
}

export function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(body);
}

export async function enrich(llm: LlmProvider, item: EnrichInput, ctx: EnrichContext): Promise<EnrichResult> {
  const { messages, schema, truncated } = buildMessages(item, ctx);
  let seconds = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await llm.chat(messages, { numCtx: ctx.numCtx });
    seconds += reply.seconds;
    let problem: string;
    try {
      const parsed = schema.safeParse(extractJson(reply.text));
      if (parsed.success) return { ok: true, data: parsed.data, attempts: attempt, seconds, truncated };
      problem = z.prettifyError(parsed.error);
    } catch (e) {
      problem = `the reply was not valid JSON (${(e as Error).message})`;
    }
    if (attempt === 2) return { ok: false, error: problem, attempts: attempt, seconds };
    messages.push({ role: "assistant", content: reply.text }, { role: "user", content: `That reply doesn't match the schema:\n${problem}\nReply again with ONLY the corrected JSON object.` });
  }
  throw new Error("unreachable");
}
