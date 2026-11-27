# Phase 2 — Personalization

Goal (from [PLAN.md §11](../PLAN.md#11-phased-delivery)): the order changes based on your ratings, and you can hide what you don't want, all from the reader on any device.

| # | Milestone | You can… | Status |
|---|---|---|---|
| P1 | **Ratings round-trip:** 👍 👌 👎, Save, Move to section (the email follows) and Mark read in the reader; works offline and syncs later. The agent collects them from OneDrive, applies them, and keeps a long-term *preference record* per rated item (no article text, PLAN.md §7.1). | rate and file things on your phone and see it everywhere | built; deploys on push |
| P2 | **Learning and ranking:** author and tag affinity from your ratings, an exploration bonus for unrated sources, section hints from your moves, and a reader profile that Gemma rebuilds weekly from your ratings | see the order change as you rate | |
| P3 | **Hiding:** "Don't show things like this" with quick reasons and an optional note, the Hidden list with **Show it again** (the email comes back from Deleted Items) | clear out what you don't want | |
| P4 | **Rules in plain English:** the Rules page (view, edit, turn off, delete, add), Gemma-drafted suggestions from what you hide, with a preview of what each would catch, and a badge when suggestions are waiting | teach the Broadsheet in your own words | |
| P5 | **`broadsheet eval`:** compare models side by side on your own newsletters | judge a newer model before switching | |

Design: [PLAN.md §4.2](../PLAN.md#42-ranking) (ranking), [§4.3](../PLAN.md#43-hiding-things-and-rules-in-plain-english) (hiding and rules), [§7](../PLAN.md#7-data-model) (data).

## How the reader talks to the agent

The reader can only reach its OneDrive App Folder, never the Mac. So every action you take (a rating, a move, a hide) is written as a small file to `ratings/` in the App Folder:

```
ratings/<device>-<time>-<random>.json   { schemaVersion, device, createdAt, actions: [...] }
```

One file per batch means two devices acting at the same moment can't overwrite each other. The agent picks the files up at the start of each run (every 15 minutes), applies them, deletes them, and republishes the edition with your ratings in it. Until then the reader shows your change straight away from its own memory, and if you're offline it keeps the file and sends it later.
