import { describe, expect, it } from "vitest";
import { Config } from "@broadsheet/shared";
import { openDb, syncConfig } from "../src/db/db.ts";
import { applySections, describePlan, planSections, type FolderPort } from "../src/pipeline/sections.ts";

const config = Config.parse({ microsoft: { clientId: "11111111-2222-3333-4444-555555555555" } });
const current = () => [
  { id: "current-events", name: "Current Events" }, { id: "financial", name: "Financial & Retirement" }, { id: "technology", name: "Technology" },
  { id: "gardening", name: "Gardening" }, { id: "outdoors", name: "Outdoors" }, { id: "everything-else", name: "Everything Else" },
];

function setup() {
  const db = openDb(":memory:");
  syncConfig(db, config);
  db.prepare("UPDATE sections SET mail_folder_id = 'F-' || id").run();
  db.prepare("INSERT INTO sources (id, channel, status, origin, created_at, fixed_section_id) VALUES ('trail', 'email', 'enabled', 'auto', 'x', 'outdoors')").run();
  for (const [id, from] of [["hike", "ai"], ["camp", "user"]] as const) {
    db.prepare("INSERT INTO items (id, source_id, channel, message_id, mail_folder_id, title, published_at, section_id, section_source, created_at) VALUES (?, 'trail', 'email', ?, 'F-outdoors', 't', '2026-11-27', 'outdoors', ?, 'x')").run(id, `m-${id}`, from);
  }
  const calls: string[] = [];
  const folders: FolderPort = {
    create: async (name) => (calls.push(`create ${name}`), `F-new-${name}`),
    rename: async (id, name) => void calls.push(`rename ${id} ${name}`),
    moveAll: async (from, to) => (calls.push(`move ${from} → ${to}`), 7),
    remove: async (id) => void calls.push(`remove ${id}`),
  };
  return { db, folders, calls };
}

describe("changing sections", () => {
  it("plans adds, renames, removals and the new order, and says what will happen", () => {
    const { db } = setup();
    const want = current().filter((s) => s.id !== "outdoors").map((s) => (s.id === "financial" ? { ...s, name: "Money" } : s));
    want.splice(1, 0, { name: "Cooking & Food" } as any);
    const plan = planSections(db, want);
    expect(plan.problems).toEqual([]);
    expect(plan.add).toEqual([{ id: "cooking-and-food", name: "Cooking & Food" }]);
    expect(plan.rename).toEqual([{ id: "financial", from: "Financial & Retirement", to: "Money" }]);
    expect(plan.remove).toEqual([{ id: "outdoors", name: "Outdoors", articles: 2, sources: 1 }]);
    expect(plan.order).toEqual(["current-events", "cooking-and-food", "financial", "technology", "gardening", "everything-else"]);
    expect(describePlan(plan, db, new Map([["outdoors", 7]]))).toEqual([
      'Add "Cooking & Food", with a new Outlook folder of that name',
      'Rename "Financial & Retirement" to "Money", and its Outlook folder',
      'Remove "Outdoors": its 7 emails move to the "Everything Else" folder; 2 current articles move to Everything Else; 1 newsletter fixed to it goes back to Gemma choosing; then its empty Outlook folder is deleted',
    ]);
    expect(planSections(db, current())).toEqual({ add: [], rename: [], remove: [], order: null, problems: [] });
    expect(planSections(db, [...current()].reverse()).order).toEqual(current().map((s) => s.id).reverse());
  });

  it("refuses what can't work", () => {
    const { db } = setup();
    const problems = (w: any[]) => planSections(db, w).problems;
    expect(problems(current().filter((s) => s.id !== "everything-else"))).toEqual(['"Everything Else" can\'t be removed: it\'s where everything without a section goes.']);
    expect(problems([...current(), { name: "technology" }])).toEqual(['There are two sections called "technology".']);
    expect(problems([...current(), { name: "_Sorting" }])[0]).toMatch(/Broadsheet's own folders/);
    expect(problems([...current(), { name: "A/B" }])[0]).toMatch(/can't contain/);
    expect(problems([...current(), { name: "  " }])).toEqual(["A section needs a name."]);
    expect(problems([...current(), { id: "nope", name: "Nope" }])).toEqual(['There\'s no section with the id "nope".']);
  });

  it("applies it to Outlook and the database, keeping every email", async () => {
    const { db, folders, calls } = setup();
    const want = [{ name: "Cooking" }, ...current().filter((s) => s.id !== "outdoors").map((s) => (s.id === "financial" ? { ...s, name: "Money" } : s))];
    const r = await applySections(db, planSections(db, want), folders);
    expect(r.errors).toEqual([]);
    expect(calls).toEqual(["create Cooking", "rename F-financial Money", "move F-outdoors → F-everything-else", "remove F-outdoors"]);
    expect(db.prepare("SELECT id, name, mail_folder_id FROM sections ORDER BY sort_order").all()).toEqual([
      { id: "cooking", name: "Cooking", mail_folder_id: "F-new-Cooking" },
      { id: "current-events", name: "Current Events", mail_folder_id: "F-current-events" },
      { id: "financial", name: "Money", mail_folder_id: "F-financial" },
      { id: "technology", name: "Technology", mail_folder_id: "F-technology" },
      { id: "gardening", name: "Gardening", mail_folder_id: "F-gardening" },
      { id: "everything-else", name: "Everything Else", mail_folder_id: "F-everything-else" },
    ]);
    expect(db.prepare("SELECT id, section_id, section_source, mail_folder_id FROM items ORDER BY id").all()).toEqual([
      { id: "camp", section_id: "everything-else", section_source: "user", mail_folder_id: "F-everything-else" },
      { id: "hike", section_id: "everything-else", section_source: "ai", mail_folder_id: "F-everything-else" },
    ]);
    expect(db.prepare("SELECT fixed_section_id FROM sources WHERE id = 'trail'").get()).toEqual({ fixed_section_id: null });

    // The config file's (unchanged) list doesn't undo it.
    syncConfig(db, config);
    expect(db.prepare("SELECT count(*) n FROM sections WHERE id = 'outdoors'").get()).toEqual({ n: 0 });
  });

  it("stops at the first Outlook failure, leaving the rest for next time", async () => {
    const { db, folders } = setup();
    folders.rename = async () => {
      throw new Error("Graph is down");
    };
    const want = [{ name: "Cooking" }, ...current().map((s) => (s.id === "financial" ? { ...s, name: "Money" } : s))];
    const r = await applySections(db, planSections(db, want), folders);
    expect(r).toEqual({ done: ['added "Cooking"'], errors: ['renamed "Financial & Retirement" to "Money": Graph is down'] });
    expect(db.prepare("SELECT name FROM sections WHERE id = 'financial'").get()).toEqual({ name: "Financial & Retirement" });
    // Applying the same list again finishes it.
    folders.rename = async () => {};
    const again = await applySections(db, planSections(db, [...want.slice(1), { id: "cooking", name: "Cooking" }]), folders);
    expect(again.errors).toEqual([]);
    expect(db.prepare("SELECT name FROM sections WHERE id = 'financial'").get()).toEqual({ name: "Money" });
  });
});
