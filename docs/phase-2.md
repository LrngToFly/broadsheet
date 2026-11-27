# Phase 2 — Personalization

Goal (from [PLAN.md §11](../PLAN.md#11-phased-delivery)): the order changes based on your ratings, and you can hide what you don't want, all from the reader on any device.

| # | Milestone | You can… | Status |
|---|---|---|---|
| P1 | **Ratings round-trip:** 👍 👌 👎, Save, Move to section (the email follows) and Mark read in the reader; works offline and syncs later. The agent collects them from OneDrive, applies them, and keeps a long-term *preference record* per rated item (no article text, PLAN.md §7.1). | rate and file things on your phone and see it everywhere | ✅ |
| P2 | **Learning and ranking:** author and tag affinity from your ratings, an exploration bonus for unrated sources, section hints from your moves, and a reader profile that Gemma rebuilds weekly from your ratings | see the order change as you rate | built |
| P3 | **Hiding:** "Don't show things like this" with quick reasons and an optional note, the Hidden list with **Show it again** (the email comes back from Deleted Items) | clear out what you don't want | built |
| P4 | **Your words, rules in plain English:** the Rules page with **In your own words** (the start of your reader profile; Gemma re-scores current items after a change), an optional "why" note on 👍 👌 👎 that feeds the weekly profile, and rules (view, edit, turn off, delete, add), with Gemma-drafted suggestions from what you hide, a preview of what each would catch, and a badge when suggestions are waiting | teach the Broadsheet in your own words, including *why* you rated something | |
| P5 | **Roundups** ([PLAN.md §4.4](../PLAN.md#44-roundup-newsletters)): a per-newsletter format (normal, roundup, multi-section). Roundups split into briefs: Current Events briefs in **News in Brief** on the Front Page, other sections' briefs at the top of their own page; the same story from several roundups shown once. Multi-section newsletters split into separate articles. First roundup: a daily news roundup | read many-story newsletters story by story | |
| P6 | **`broadsheet eval`:** compare models side by side on your own newsletters | judge a newer model before switching | |

Design: [PLAN.md §4.2](../PLAN.md#42-ranking) (ranking), [§4.3](../PLAN.md#43-hiding-things-and-rules-in-plain-english) (hiding and rules), [§4.4](../PLAN.md#44-roundup-newsletters) (roundups), [§7](../PLAN.md#7-data-model) (data).

## How the reader talks to the agent

The reader can only reach its OneDrive App Folder, never the Mac. So every action you take (a rating, a move, a hide) is written as a small file to `ratings/` in the App Folder:

```
ratings/<device>-<time>-<random>.json   { schemaVersion, device, createdAt, actions: [...] }
```

One file per batch means two devices acting at the same moment can't overwrite each other. The agent picks the files up at the start of each run (every 15 minutes), applies them, deletes them, and republishes the edition with your ratings in it. Until then the reader shows your change straight away from its own memory, and if you're offline it keeps the file and sends it later.

## How the ranking learns (P2)

Everything is computed from your *preference records* (P1), so it reflects your latest ratings and could be recomputed if the method improves. Code: [affinity.ts](../apps/agent/src/pipeline/affinity.ts), [ranking.ts](../apps/agent/src/pipeline/ranking.ts), [profile.ts](../apps/agent/src/ai/profile.ts).

- **Your ratings as numbers:** 👍 +1, 👌 0, 👎 −1. A rating counts half as much after 180 days, so the paper follows you as your tastes change.
- **Author affinity:** the average of your ratings for that author, or for the source when you haven't rated the author. It's pulled toward neutral until there are a few ratings (one 👍 isn't a verdict).
- **Topic affinity:** the same, pooled over the item's tags and (at half weight) its section.
- **Relevance:** Gemma's interest score, blended with the topic affinity. The more ratings behind an item's tags, the more the learned part counts, up to half (`ranking.learnedTopics`).
- **Exploration:** sources you've rated fewer than 3 items from get a small bonus (`ranking.exploration`, 0.05), so new newsletters get a fair chance.
- **Section hints:** when you move a source's items to the same section twice in a row, its new items go there by themselves (and their emails are filed there). Move one somewhere else and the hint goes away. An item you moved yourself always stays where you put it, even if Gemma reads it again.
- **Reader profile:** once you've rated 8 articles, Gemma writes a short profile of your tastes from them (titles, sources, tags and ratings, never article text), and rewrites it weekly when there are at least 3 new ratings. It starts from your own `readerProfile` words, which win where the two disagree. The last 4 versions are kept, on the Mac only.
- **See it:** `broadsheet profile` shows the profile and the authors and topics your ratings favor; `broadsheet profile --rebuild` has Gemma rewrite it now. After a big profile change, `broadsheet resummarize --all` has Gemma re-score current items.

## Hiding (P3)

- **In an article:** 🚫 **Don't show things like this** hides it at once and opens a small sheet. Tap a reason (Not an article, Ad or promo, Not my topic, Not this author), type a note if you like, then **Done**, or **Undo**. Both are optional; the item is already hidden.
- **On the Mac:** the item is hidden, its email moves to Deleted Items, and the preference record keeps your reason and note (P4 turns them into rule suggestions). "Not this author" and "Not my topic" also count like a 👎 for that author or those topics in the ranking.
- **The Hidden list** (link at the bottom of every page) shows everything left out of the paper in the retention window, and why: *You hid this*, *Rule: …*, or *Gemma thought this wasn't an article*. **Show it again** puts it back and returns the email from Deleted Items (or the Inbox, if a rule left it there) to its section folder, or _Sorting. After that, neither a rule nor Gemma's "not an article" hides that item again.
- **_Add and _Sorting:** drop an email in **_Add** to include it no matter what (only the last 4 days' mail shows in the paper). **_Sorting** is the agent's own waiting room: mail you put there yourself is ignored.

