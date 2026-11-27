// Stage B (PLAN.md §3.6 steps 9-10 and §6.2): while you're away from the Mac, Gemma reads each pending
// item: summary, key points, section, tags, interest, "why it's here", and your Instruction rules. Then the
// email is filed from _Sorting into its section folder. Between items the agent checks again whether you're
// back, and if you are it finishes that item and stops.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import type { ActivitySample } from "../activity.ts";
import { aiMayRun } from "../activity.ts";
import type { LlmProvider } from "../ai/provider.ts";
import { enrich } from "../ai/enrich.ts";
import type { MailPort } from "./stage-a-email.ts";

export const MAX_AI_ATTEMPTS = 3;

export type StageBOutcome = { title: string; result: string; seconds: number; error?: string };
export type StageBResult = { deferred: string | null; outcomes: StageBOutcome[]; pendingLeft: number; unloaded: boolean };

export async function stageB(opts: {
  db: Db;
  config: Config;
  llm: LlmProvider;
  mail: MailPort;
  contentDir: string;
  sampleActivity: () => Promise<ActivitySample>;
  /** Ignore the idle checks (broadsheet run --force). */
  force?: boolean;
  limit?: number;
  log?: (line: string) => void;
}): Promise<StageBResult> {
  const { db, config, llm, mail } = opts;
  const log = opts.log ?? (() => {});
  const pendingCount = () => (db.prepare("SELECT count(*) n FROM items WHERE ai_status = 'pending' AND hidden_by IS NULL").get() as { n: number }).n;
  const result: StageBResult = { deferred: null, outcomes: [], pendingLeft: pendingCount(), unloaded: false };
  if (result.pendingLeft === 0) return result;

  const mayRun = async () => (opts.force ? ({ ok: true } as const) : aiMayRun(await opts.sampleActivity(), config.politeness));
  const first = await mayRun();
  if (!first.ok) {
    result.deferred = first.reason;
    return result;
  }

  const sections = db.prepare("SELECT id, name, mail_folder_id FROM sections ORDER BY sort_order").all() as { id: string; name: string; mail_folder_id: string | null }[];
  const instructionRules = (db.prepare("SELECT id, instruction, source_id, mail_action FROM rules WHERE kind = 'instruction' AND status = 'active'").all() as any[]).map((r) => ({
    id: r.id as string,
    instruction: r.instruction as string,
    sourceId: r.source_id as string | null,
    mail: r.mail_action as "deleted-items" | "leave",
  }));
  const sortingId = (db.prepare("SELECT value FROM agent_state WHERE key = 'folder:_sorting'").get() as { value: string } | undefined)?.value;
  const wasLoaded = await llm.isLoaded().catch(() => false);

  const items = db
    .prepare(
      `SELECT i.id, i.title, i.author, i.channel, i.message_id, i.mail_folder_id, i.section_id, i.section_source, i.source_id, i.ai_attempts,
              coalesce(s.display_name, s.id) AS source_name
       FROM items i JOIN sources s ON s.id = i.source_id
       WHERE i.ai_status = 'pending' AND i.hidden_by IS NULL
       ORDER BY i.published_at DESC LIMIT ?`,
    )
    .all(opts.limit ?? 1000) as any[];

  try {
    for (const [n, it] of items.entries()) {
      if (n > 0) {
        const again = await mayRun();
        if (!again.ok) {
          result.deferred = again.reason;
          break;
        }
      }
      const fixed = it.section_source === "fixed" ? it.section_id : null;
      let text: string;
      try {
        text = await readFile(join(opts.contentDir, it.id, "article.txt"), "utf8");
      } catch {
        db.prepare("UPDATE items SET ai_status = 'failed' WHERE id = ?").run(it.id);
        result.outcomes.push({ title: it.title, result: "failed", seconds: 0, error: "article text is missing" });
        continue;
      }

      log(`Gemma is reading: ${it.title}`);
      const r = await enrich(llm, { title: it.title, source: it.source_name, author: it.author, text, fixedSection: fixed }, {
        sections, instructionRules, sourceId: it.source_id, readerProfile: config.readerProfile, numCtx: config.ai.numCtx,
      }).catch((e: Error) => ({ ok: false as const, error: e.message, attempts: 1, seconds: 0 }));

      if (!r.ok) {
        const attempts = it.ai_attempts + 1;
        db.prepare("UPDATE items SET ai_attempts = ?, ai_status = ? WHERE id = ?").run(attempts, attempts >= MAX_AI_ATTEMPTS ? "failed" : "pending", it.id);
        result.outcomes.push({ title: it.title, result: attempts >= MAX_AI_ATTEMPTS ? "failed (gave up)" : "failed (will retry)", seconds: r.seconds, error: r.error });
        continue;
      }

      const d = r.data;
      const sectionId = fixed ?? d.section;
      const rule = d.hidden_by_rule ? instructionRules.find((x) => x.id === d.hidden_by_rule) : undefined;
      db.prepare(
        `UPDATE items SET summary = ?, key_points_json = ?, tags_json = ?, interest = ?, why_its_here = ?, read_minutes = ?, is_article = ?,
           section_id = ?, section_source = ?, hidden_by = ?, model = ?, ai_status = 'done', ai_attempts = ai_attempts + 1 WHERE id = ?`,
      ).run(
        d.summary, JSON.stringify(d.key_points), JSON.stringify(d.tags), d.interest, d.why_its_here, d.read_minutes, d.is_article ? 1 : 0,
        sectionId, fixed ? "fixed" : "ai", rule?.id ?? null, llm.id, it.id,
      );

      // File the email: from _Sorting into its section folder, or to Deleted Items if a rule hid it.
      // An email the AI filed earlier is re-filed if the AI changes its mind (re-reading after a prompt change).
      let filed = "";
      const previousAiFolder = it.section_source === "ai" ? sections.find((s) => s.id === it.section_id)?.mail_folder_id : undefined;
      const movable = it.mail_folder_id === sortingId || (previousAiFolder && it.mail_folder_id === previousAiFolder);
      if (it.channel === "email" && it.message_id && it.mail_folder_id && movable) {
        const target = rule ? (rule.mail === "deleted-items" ? "deleteditems" : null) : sections.find((s) => s.id === sectionId)?.mail_folder_id;
        if (target && target !== it.mail_folder_id) {
          try {
            await mail.move(it.message_id, target);
            db.prepare("UPDATE items SET mail_folder_id = ? WHERE id = ?").run(target, it.id);
            filed = target === "deleteditems" ? " → Deleted Items" : ` → ${sections.find((s) => s.id === sectionId)?.name}`;
          } catch (e) {
            filed = ` (couldn't file the email: ${(e as Error).message}; it stays in _Sorting)`;
          }
        }
      }
      const verdict = rule ? `hidden by rule "${rule.id}"` : !d.is_article ? "not an article (left out of the paper)" : `${sections.find((s) => s.id === sectionId)?.name}, interest ${d.interest}`;
      result.outcomes.push({ title: it.title, result: `${verdict}${filed}`, seconds: r.seconds });
    }
  } finally {
    // Give the memory back, unless the model was already loaded for someone else.
    if (!wasLoaded) {
      await llm.unload().catch(() => {});
      result.unloaded = true;
    }
  }
  result.pendingLeft = pendingCount();
  return result;
}
