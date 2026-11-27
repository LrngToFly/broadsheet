// Stage A for email (PLAN.md §3.6 steps 2, 3, 5 and 7): fetch new newsletters, decide what to do with
// each, file them in Outlook, and save the cleaned article for Gemma. Feeds and publishing come in M4.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "@broadsheet/shared";
import type { Db } from "../db/db.ts";
import { transaction } from "../db/db.ts";
import { parseEmail, platformOf } from "../content/email.ts";
import { cleanArticle } from "../content/clean.ts";
import type { Mail, MessageSummary } from "../microsoft/mail.ts";
import { classify, matchSource, newSourceFor, splitSenderName, type Decision, type RuleRow, type SourceRow } from "./classify.ts";

export type MailPort = Pick<Mail, "list" | "mime" | "move" | "markRead">;

export type EmailOutcome = {
  subject: string;
  from: string;
  decision: Decision;
  /** Where the email goes: a section name, "_Sorting", "Deleted Items" or "stays in Inbox". */
  destination: string;
  source: string;
  newSource: boolean;
  words: number;
  error?: string;
};

export type StageAEmailResult = { outcomes: EmailOutcome[]; counts: Record<string, number> };

export const itemIdFor = (messageId: string) => createHash("sha256").update(messageId).digest("base64url").slice(0, 16);
const seenKey = (messageId: string) => `mail:${messageId}`;

function loadSources(db: Db): SourceRow[] {
  return (db.prepare("SELECT id, match_json, status, fixed_section_id FROM sources WHERE channel = 'email'").all() as any[]).map((r) => ({
    id: r.id,
    match: r.match_json ? JSON.parse(r.match_json) : null,
    status: r.status,
    fixedSectionId: r.fixed_section_id,
  }));
}

function loadRules(db: Db): RuleRow[] {
  const rows = db.prepare("SELECT * FROM rules WHERE status = 'active' AND kind IN ('check', 'include')").all() as any[];
  return rows.map((r) =>
    r.kind === "check"
      ? { id: r.id, kind: "check", match: r.match_mode, conditions: JSON.parse(r.conditions_json), sourceId: r.source_id, mail: r.mail_action }
      : { id: r.id, kind: "include", match: r.match_mode, conditions: JSON.parse(r.conditions_json), sourceId: r.source_id, sectionId: r.section_id },
  );
}

function folderIds(db: Db) {
  const state = (key: string) => (db.prepare("SELECT value FROM agent_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  const sections = new Map((db.prepare("SELECT id, name, mail_folder_id FROM sections").all() as any[]).map((s) => [s.id as string, s as { id: string; name: string; mail_folder_id: string | null }]));
  return { sorting: state("folder:_sorting"), add: state("folder:_add"), sections };
}

export async function stageAEmail(opts: {
  mail: MailPort;
  db: Db;
  config: Config;
  contentDir: string;
  dryRun: boolean;
  now?: Date;
  log?: (line: string) => void;
}): Promise<StageAEmailResult> {
  const { mail, db, config, dryRun } = opts;
  const now = opts.now ?? new Date();
  const folders = folderIds(db);
  if (!folders.sorting || !folders.add) throw new Error("The Outlook folders aren't set up yet. Run: broadsheet folders --create");

  const sources = loadSources(db);
  const rules = loadRules(db);
  const since = new Date(now.getTime() - config.retention.days * 24 * 3600 * 1000);
  const isSeen = (messageId: string) => Boolean(db.prepare("SELECT 1 FROM seen WHERE key = ?").get(seenKey(messageId)));

  const queue: { m: MessageSummary; fromAdd: boolean }[] = [
    ...(await mail.list(folders.add)).map((m) => ({ m, fromAdd: true })),
    ...(await mail.list("inbox", since)).filter((m) => !isSeen(m.internetMessageId)).map((m) => ({ m, fromAdd: false })),
  ];

  const outcomes: EmailOutcome[] = [];
  const counts: Record<string, number> = { included: 0, skipped: 0, hidden: 0, errors: 0, newSources: 0 };

  for (const { m, fromAdd } of queue) {
    const from = m.from?.emailAddress?.address?.toLowerCase() ?? "";
    try {
      const email = await parseEmail(await mail.mime(m.id));
      const article = cleanArticle(email.html, email.text, { title: email.subject, listPost: email.listPost });
      const facts = {
        sender: email.from.address || from,
        senderName: email.from.name,
        subject: email.subject,
        listId: email.listId,
        hasListUnsubscribe: email.hasListUnsubscribe,
        platform: platformOf(email),
        text: article.text,
        wordCount: article.wordCount,
        links: article.links,
        fromAddFolder: fromAdd,
      };

      let source = matchSource(facts, sources);
      let created: ReturnType<typeof newSourceFor> | null = null;
      if (!source) {
        created = newSourceFor(facts, new Set(sources.map((s) => s.id)));
        source = { id: created.id, match: created.match, status: "new", fixedSectionId: null };
      }

      const decision = classify(facts, { mode: config.mailbox.mode, source, rules });
      const sectionName = (id: string | null) => (id ? (folders.sections.get(id)?.name ?? id) : "_Sorting");
      const destination =
        decision.action === "include" ? sectionName(decision.sectionId)
        : decision.action === "hide" ? (decision.mail === "deleted-items" ? "Deleted Items" : "stays in Inbox")
        : "stays in Inbox";
      // A skipped email doesn't create a source.
      if (decision.action === "skip") created = null;

      outcomes.push({ subject: email.subject, from: facts.sender, decision, destination, source: source.id, newSource: Boolean(created), words: article.wordCount });
      counts[decision.action === "include" ? "included" : decision.action === "skip" ? "skipped" : "hidden"]!++;
      if (created) {
        counts.newSources!++;
        sources.push(source);
      }
      if (dryRun) continue;

      // Record first, then move. If the move fails, undo the record so the next run tries again.
      const nowIso = now.toISOString();
      const itemId = itemIdFor(email.messageId);
      // The same post may already be here from a feed you follow (PLAN.md §3.4): keep the fuller version.
      const dupe = article.canonicalUrl
        ? (db.prepare("SELECT id, word_count FROM items WHERE url = ? AND channel = 'feed'").get(article.canonicalUrl) as { id: string; word_count: number } | undefined)
        : undefined;
      const keep = decision.action !== "skip" && !(dupe && dupe.word_count > article.wordCount);
      const targetFolder =
        decision.action === "include" ? (decision.sectionId ? folders.sections.get(decision.sectionId)?.mail_folder_id : folders.sorting)
        : decision.action === "hide" && decision.mail === "deleted-items" ? "deleteditems"
        : fromAdd ? folders.sorting // a skipped/kept-in-Inbox decision never applies to _Add, but be safe
        : null;
      if (decision.action === "include" && !targetFolder) throw new Error(`no Outlook folder for section ${decision.sectionId}`);

      transaction(db, () => {
        if (created) {
          db.prepare("INSERT INTO sources (id, channel, display_name, match_json, platform, status, origin, created_at, last_post_at) VALUES (?, 'email', ?, ?, ?, 'new', 'auto', ?, ?)")
            .run(created.id, created.displayName, JSON.stringify(created.match), facts.platform, nowIso, m.receivedDateTime);
        } else if (keep) {
          db.prepare("UPDATE sources SET last_post_at = max(coalesce(last_post_at, ''), ?) WHERE id = ?").run(m.receivedDateTime, source.id);
        }
        if (keep && dupe) db.prepare("DELETE FROM items WHERE id = ?").run(dupe.id);
        if (keep) {
          const { author } = splitSenderName(email.from.name);
          db.prepare(
            `INSERT OR REPLACE INTO items (id, source_id, channel, message_id, internet_message_id, mail_folder_id, title, author, published_at, url,
               content_origin, opening, word_count, section_id, section_source, hidden_by, ai_status, created_at)
             VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            itemId, source.id, m.id, email.messageId, targetFolder ?? null, email.subject, author, m.receivedDateTime, article.canonicalUrl,
            article.opening, article.wordCount,
            decision.action === "include" ? decision.sectionId : null,
            decision.action === "include" && decision.sectionFrom ? "fixed" : null,
            decision.action === "hide" ? decision.ruleId : null,
            decision.action === "hide" ? "skipped" : "pending",
            nowIso,
          );
        }
        db.prepare("INSERT OR IGNORE INTO seen (key, first_seen_at) VALUES (?, ?)").run(seenKey(email.messageId), nowIso);
      });

      const dir = join(opts.contentDir, itemId);
      try {
        if (keep) {
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, "article.html"), article.html);
          await writeFile(join(dir, "article.txt"), article.text);
        }
        if (targetFolder) {
          await mail.move(m.id, targetFolder);
          if (config.mailbox.markFiledAsRead && decision.action === "include" && !m.isRead) await mail.markRead(m.id);
        }
      } catch (e) {
        transaction(db, () => {
          db.prepare("DELETE FROM items WHERE id = ?").run(itemId);
          db.prepare("DELETE FROM seen WHERE key = ?").run(seenKey(email.messageId));
          if (created) db.prepare("DELETE FROM sources WHERE id = ?").run(created.id);
        });
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
    } catch (e) {
      counts.errors!++;
      outcomes.push({ subject: m.subject, from, decision: { action: "skip", why: "error" }, destination: "stays where it is", source: "-", newSource: false, words: 0, error: (e as Error).message });
    }
  }
  return { outcomes, counts };
}
