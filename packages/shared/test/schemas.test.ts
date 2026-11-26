import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Config, DEFAULT_SECTIONS, enrichmentSchema, enrichmentJsonSchema } from "../src/index.ts";

const example = JSON.parse(readFileSync(new URL("../../../apps/agent/config.example.json", import.meta.url), "utf8"));
const minimal = { microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } };

describe("Config", () => {
  it("accepts the example file", () => {
    const c = Config.parse(example);
    expect(c.rules.map((r) => r.kind)).toEqual(["check", "instruction"]);
  });

  it("fills in defaults from a minimal file", () => {
    const c = Config.parse(minimal);
    expect(c.sections).toEqual(DEFAULT_SECTIONS);
    expect(c.mailbox).toEqual({ mode: "dedicated", rootFolder: "The Broadsheet", markFiledAsRead: false });
    expect(c.ai.model).toBe("gemma4:12b");
    expect(c.politeness.idleMinutes).toBe(10);
    expect(c.retention.days).toBe(4);
  });

  it("rejects references to unknown sections and sources", () => {
    const r = Config.safeParse({
      ...minimal,
      sources: [{ id: "a", channel: "email", match: { sender: "x@y.com" }, section: "nope" }],
      rules: [{ id: "r", kind: "instruction", wording: "w", instruction: "i", source: "missing" }],
    });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain('unknown section "nope"');
    expect(messages).toContain('unknown source "missing"');
  });

  it("requires the fallback section and unique ids", () => {
    const r = Config.safeParse({ ...minimal, sections: [{ id: "a", name: "A" }, { id: "a", name: "B" }] });
    const messages = r.error!.issues.map((i) => i.message);
    expect(messages).toContain('duplicate section id "a"');
    expect(messages).toContain('sections must include "everything-else"');
  });

  it("requires an email source to say how to recognise the sender", () => {
    expect(Config.safeParse({ ...minimal, sources: [{ id: "a", channel: "email", match: {} }] }).success).toBe(false);
  });
});

describe("enrichment schema", () => {
  const schema = enrichmentSchema(["technology", "everything-else"], ["no-course-ads"]);
  const good = {
    is_article: true,
    summary: "A long enough neutral summary of the post.",
    key_points: ["one"],
    section: "technology",
    tags: ["ai"],
    interest: 80,
    why_its_here: "You read a lot about this.",
    read_minutes: 4,
    hidden_by_rule: null,
  };

  it("accepts a good reply and a rule id", () => {
    expect(schema.safeParse(good).success).toBe(true);
    expect(schema.safeParse({ ...good, hidden_by_rule: "no-course-ads" }).success).toBe(true);
  });

  it("rejects unknown sections, rule ids and extra keys", () => {
    expect(schema.safeParse({ ...good, section: "sports" }).success).toBe(false);
    expect(schema.safeParse({ ...good, hidden_by_rule: "made-up" }).success).toBe(false);
    expect(schema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });

  it("produces JSON Schema text for the prompt", () => {
    const text = enrichmentJsonSchema(schema);
    expect(text).toContain('"technology"');
    expect(text).toContain("hidden_by_rule");
  });
});
