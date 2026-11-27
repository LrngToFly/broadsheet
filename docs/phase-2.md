# Phase 2 — Personalization

Goal (from [PLAN.md §11](../PLAN.md#11-phased-delivery)): the order changes based on your ratings, and you can hide what you don't want, all from the reader on any device.

| # | Milestone | You can… | Status |
|---|---|---|---|
| P1 | **Ratings round-trip:** 👍 👌 👎, Save, Move to section (the email follows) and Mark read in the reader; works offline and syncs later. The agent collects them from OneDrive, applies them, and keeps a long-term *preference record* per rated item (no article text, PLAN.md §7.1). | rate and file things on your phone and see it everywhere | ✅ |
| P2 | **Learning and ranking:** author and tag affinity from your ratings, an exploration bonus for unrated sources, section hints from your moves, and a reader profile that Gemma rebuilds weekly from your ratings | see the order change as you rate | built |
| P3 | **Hiding:** "Don't show things like this" with quick reasons and an optional note, the Hidden list with **Show it again** (the email comes back from Deleted Items) | clear out what you don't want | built |
| P4 | **Your words, rules in plain English:** the Rules page with **In your own words** (the start of your reader profile; Gemma re-scores current items after a change), an optional "why" note on 👍 👌 👎 that feeds the weekly profile, and rules (view, edit, turn off, delete, add), with Gemma-drafted suggestions from what you hide, a preview of what each would catch, and a badge when suggestions are waiting | teach the Broadsheet in your own words, including *why* you rated something | built |
| P5 | **Roundups** ([PLAN.md §4.4](../PLAN.md#44-roundup-newsletters)): a per-newsletter format (normal, roundup, multi-section). Roundups split into briefs: Current Events briefs in **News in Brief** on the Front Page, other sections' briefs at the top of their own page; the same story from several roundups shown once. Multi-section newsletters split into separate articles. First roundup: a daily news roundup | read many-story newsletters story by story | built |
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

## Your words and rules (P4)

- **The Rules page** (the **Rules** link at the top, with a red badge when suggestions are waiting) has four parts: **In your own words**, **Suggestions**, **Add a rule** and **Your rules**, with a link to the Hidden list.
- **In your own words:** what you write here replaces `readerProfile` in the config file. Gemma reads it with every article, ahead of the profile it learns from your ratings. When you change it, Gemma re-scores the current articles from their summaries (a few seconds each) the next time the Mac is free. "What Gemma has learned from your ratings" shows the learned profile, read-only.
- **A why on ratings:** after 👍 👌 👎, **Say why you rated it** opens a one-line box. The note goes into the weekly profile rewrite, with an instruction that a reason matters more than the subject. A rating with a note counts for half in the author and topic statistics.
- **Suggestions:** each item you hide is queued for Gemma. While you're away it drafts a rule from the item's sender, list, subject, links, length and opening text, plus your reason and note, or answers that it's a one-off (no suggestion). Rules you type are drafted the same way, and a rule that names a newsletter applies only to that one. Each suggestion shows which current articles it would hide. **Approve** turns it on and hides those articles (their emails go to Deleted Items); **Edit** sends new wording for Gemma to redraft; **Dismiss** drops it.
- **Your rules:** turn each on or off, reword it (Gemma redrafts it in place, and it stays on), or delete it. Each shows how many items it hid in the last 30 days. Changes from the reader now stick: a rule from the config file is copied in again only when its text in the file changes.
- **Privacy:** to draft from a hidden item, the agent copies its opening text (up to 2,500 characters) into the request. The copy is deleted as soon as Gemma has drafted, or when the article itself expires.

## Roundups (P5)

Code: [split.ts (content)](../apps/agent/src/content/split.ts), [split.ts (pipeline)](../apps/agent/src/pipeline/split.ts).

- **Setting a format:** `broadsheet sources` lists your newsletters with their formats, and suggests the ones laid out like a roundup (five or more pieces with a median of 60–200 words). `broadsheet format <id> roundup` (or `multi-section`, or `normal`) sets one and applies it to its current emails straight away. A source in the config file can say `"format": "roundup"` instead; where the file says nothing, the command's choice stands. The first roundup newsletter is set to roundup.
- **Splitting, without AI:** the newsletter is cut at the heading level it uses most (at least three times), or failing that at short bold lines. What comes before the first heading (masthead, greeting) is left out, as is a table of contents (mostly short list lines) and anything under 40 words (sponsor slots, sign-offs). Fewer than two pieces left means it stays one article. A real roundup splits into its 10 stories.
- **Each piece is an item of its own,** with its own text and images, so it can be rated, moved, saved and hidden like any article. Gemma reads each piece separately and is told it's one story from a roundup (summary in 1–2 sentences). The newsletter itself is kept, not shown, as **Read the whole newsletter** at the end of each piece.
- **The email** waits in _Sorting until every piece is read, then goes to the section where most pieces landed. Hiding a piece never moves the email, because the rest of the newsletter is still in the paper.
- **In the reader:** Current Events briefs are **News in Brief** on the Front Page, under the lead story (8 at most, with a link to the rest). Other sections' briefs are an **In brief** list at the top of that section's page. A brief opens like an article.
- **The same story twice:** pieces from different newsletters are treated as one story when their headlines share most of their words, or when they link to the same page (not either newsletter's own site, and not social media). The best-scored one is shown, with "also in …". This is deliberately cautious: two very differently worded headlines about one event are still shown twice.
- **Multi-section** works the same way, but each piece is a full article card. No newsletter is set to it yet.
- **Privacy:** links lose any query value that is an email address (some newsletters put yours in every link), as well as `utm_` tracking.
- **Not yet:** a story's own web page as its "Open the original" link (some roundups' links go to the sources they cite, so a brief links to its newsletter instead).

