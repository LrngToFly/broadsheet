import { z } from "zod";

/** A newspaper section. Its Outlook folder lives under the root folder with the same name. */
export const Section = z.object({
  /** Stable id used in data files, e.g. "financial". Never shown to the reader. */
  id: z.string().regex(/^[a-z0-9-]+$/, "use lower-case letters, digits and dashes"),
  /** Display name, also the Outlook folder name, e.g. "Financial & Retirement". */
  name: z.string().min(1).max(60),
});
export type Section = z.infer<typeof Section>;

/** The catch-all section. Every configuration must include it. */
export const FALLBACK_SECTION_ID = "everything-else";

export const DEFAULT_SECTIONS: Section[] = [
  { id: "current-events", name: "Current Events" },
  { id: "financial", name: "Financial & Retirement" },
  { id: "technology", name: "Technology" },
  { id: "gardening", name: "Gardening" },
  { id: "outdoors", name: "Outdoors" },
  { id: FALLBACK_SECTION_ID, name: "Everything Else" },
];

/** Working folders under the root folder that are not sections (PLAN.md §4.1). */
export const SYSTEM_FOLDERS = {
  sorting: "_Sorting",
  add: "_Add",
} as const;
