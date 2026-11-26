// The agent's configuration file (Phase 1, until the Admin app exists).
// Location: ~/Library/Application Support/Broadsheet/broadsheet.config.json
import { z } from "zod";
import { DEFAULT_SECTIONS, FALLBACK_SECTION_ID, Section } from "./sections.ts";
import { Rule } from "./rules.ts";

const Id = z.string().regex(/^[a-z0-9-]+$/, "use lower-case letters, digits and dashes");

export const EmailSource = z.object({
  id: Id,
  channel: z.literal("email"),
  name: z.string().min(1).optional(),
  /** At least one of these identifies the sender. */
  match: z
    .object({
      sender: z.string().optional(),
      domain: z.string().optional(),
      listId: z.string().optional(),
    })
    .refine((m) => m.sender || m.domain || m.listId, "give a sender, domain or listId"),
  /** Always file into this section, without asking the AI. */
  section: Id.optional(),
  enabled: z.boolean().default(true),
});

export const FeedSource = z.object({
  id: Id,
  channel: z.literal("feed"),
  name: z.string().min(1).optional(),
  /** The site or feed address, e.g. https://example.substack.com */
  url: z.url({ protocol: /^https?$/ }),
  section: Id.optional(),
  enabled: z.boolean().default(true),
});

export const Source = z.discriminatedUnion("channel", [EmailSource, FeedSource]);
export type Source = z.infer<typeof Source>;

export const Config = z
  .object({
    $schema: z.string().optional(),
    microsoft: z.object({
      /** Application (client) ID of your Entra app registration. Not a secret. */
      clientId: z.guid(),
    }),
    mailbox: z
      .object({
        mode: z.enum(["dedicated", "shared"]).default("dedicated"),
        /** The Outlook folder that holds the section folders. */
        rootFolder: z.string().min(1).default("The Broadsheet"),
        markFiledAsRead: z.boolean().default(false),
      })
      .prefault({}),
    sections: z.array(Section).min(1).default(DEFAULT_SECTIONS),
    sources: z.array(Source).default([]),
    rules: z.array(Rule).default([]),
    ai: z
      .object({
        baseUrl: z.url().default("http://127.0.0.1:11434"),
        model: z.string().default("gemma4:12b"),
        /** Context window in tokens. Ollama's default would silently cut long newsletters. */
        numCtx: z.number().int().min(2048).max(262144).default(16384),
        temperature: z.number().min(0).max(2).default(0.2),
      })
      .prefault({}),
    politeness: z
      .object({
        /** Minutes without keyboard or mouse input before AI work starts. */
        idleMinutes: z.number().min(1).max(240).default(10),
        /** A locked screen counts as idle straight away. */
        lockedCountsAsIdle: z.boolean().default(true),
        /** Skip AI work while the 5-minute load average is above this. */
        maxLoad5m: z.number().positive().default(6),
        backlog: z.enum(["never-while-active", "trickle"]).default("never-while-active"),
        backlogHours: z.number().positive().default(6),
      })
      .prefault({}),
    retention: z.object({ days: z.number().int().min(1).max(14).default(4) }).prefault({}),
    ranking: z
      .object({
        content: z.number().min(0).default(0.45),
        author: z.number().min(0).default(0.35),
        freshness: z.number().min(0).default(0.2),
      })
      .prefault({}),
    /** A few sentences about what you like to read. Phase 2 learns this from your ratings. */
    readerProfile: z.string().max(4000).default(""),
  })
  .superRefine((c, ctx) => {
    const sectionIds = new Set(c.sections.map((s) => s.id));
    const sourceIds = new Set<string>();
    const ruleIds = new Set<string>();

    const dup = (ids: string[], what: string) => {
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate ${what} id "${id}"` });
        seen.add(id);
      }
    };
    dup(c.sections.map((s) => s.id), "section");
    dup(c.sources.map((s) => s.id), "source");
    dup(c.rules.map((r) => r.id), "rule");
    c.sources.forEach((s) => sourceIds.add(s.id));
    c.rules.forEach((r) => ruleIds.add(r.id));

    if (!sectionIds.has(FALLBACK_SECTION_ID)) {
      ctx.addIssue({ code: "custom", path: ["sections"], message: `sections must include "${FALLBACK_SECTION_ID}"` });
    }
    c.sources.forEach((s, i) => {
      if (s.section && !sectionIds.has(s.section)) {
        ctx.addIssue({ code: "custom", path: ["sources", i, "section"], message: `unknown section "${s.section}"` });
      }
    });
    c.rules.forEach((r, i) => {
      if (r.source && !sourceIds.has(r.source)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "source"], message: `unknown source "${r.source}"` });
      }
      if (r.kind === "include" && r.section && !sectionIds.has(r.section)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "section"], message: `unknown section "${r.section}"` });
      }
    });
  });

/** The config file as written (defaults may be left out). */
export type ConfigInput = z.input<typeof Config>;
/** The config after defaults are filled in. */
export type Config = z.output<typeof Config>;
