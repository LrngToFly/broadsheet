# Phase 3 — Admin & sources

Goal (from [PLAN.md §10](../PLAN.md#10-phased-delivery)): you manage everything without touching config files. **All seven milestones are built** (2026-11-27); the config file now only needs your Microsoft client ID. The Admin console is a native Mac app (SwiftUI) on the Mac mini, with a menu-bar item ([PLAN.md §8.2](../PLAN.md#82-admin-console-swiftui)).

| # | Milestone | You can… | Status |
|---|---|---|---|
| A1 | **The app and the menu bar:** a menu-bar item showing what the agent is doing (**Idle**, **Waiting — you're active**, **Working (3 of 12)**, **Paused**), the last run, the backlog and errors; **Run now** and **Pause for 1 hour / until tomorrow**; an Admin window with a Status page and the log viewer. Built from the command line into `~/Applications/Broadsheet Admin.app` | see and control the agent without Terminal | built |
| A2 | **Sources:** one list (email and feeds) with latest post date, posts in the last 30 days and average rating; rename, fixed section, mute, format (normal, roundup, multi-section) and roundup suggestions; sources silent for a long time highlighted with **Disable**. The database becomes the master copy for sources | manage your newsletters | built |
| A3 | **Sections and folders:** add, rename, reorder or remove sections, with a preview of each Outlook folder change before it's applied | change the paper's sections | built |
| A4 | **Rules and your words:** the reader's Rules page and Hidden list in Admin, plus the full condition editor for Check and include rules with **Test against recent mail** | edit rules precisely | built |
| A5 | **Following and feeds:** **Follow by URL** with a preview, **Switch to feed**, best version (email, feed or web page), staleness, and the unsubscribe helper | follow authors without email | built |
| A6 | **Email:** mailbox mode, New sources, skipped mail with **Include this one**, and emails dropped into `_Add` | catch what was missed | built |
| A7 | **Data, AI and politeness:** export / import, **Forget** ratings, storage sizes; the Ollama model and context size; **Run eval**; idle threshold, limits, backlog behaviour, overnight window | tune it all in one place | built |

## How Admin talks to the agent

The agent (TypeScript, run by launchd every 15 minutes) already does everything that touches Microsoft, Ollama or the rules: sign-in, Graph, folders, Gemma, validation. Admin shouldn't do any of that a second time in Swift. So:

- **Admin reads the database directly**, through SQLite's own C library built into macOS (`import SQLite3`, a small wrapper, no extra packages to download). Reading is safe while the agent runs, because the database is in WAL mode. It opens the database normally with SQLite's `query_only` switched on, so it can't write: a strictly read-only connection can't create WAL's helper files, which don't exist between runs, and every page failed with "unable to open database file" until this was fixed (2026-11-27). Plain SQL tables are the contract, as planned ([PLAN.md §2](../PLAN.md)).
- **For views the agent already builds for the reader** (the Rules page, the Hidden list), Admin asks the agent for the same JSON (`broadsheet rules --json`, `broadsheet hidden --json`) rather than repeating that logic in Swift.
- **Admin changes things by running the agent's command line,** e.g. `broadsheet pause --for 1h` or `broadsheet format <id> roundup`, with `--json` output where Admin needs an answer. Every change goes through the same code and checks as the reader's and Terminal's, and only one program ever writes the database.
- **Where's the agent?** Admin reads it from the launchd job the agent installed (`~/Library/LaunchAgents/com.thebroadsheet.agent.plist`), which names both Node and the agent's `cli.ts`. If the job isn't installed, Admin says so.
- **Live progress:** during Gemma's work the agent writes `progress.json` (item n of N and its title) next to the database, and deletes it when it stops. Admin checks it, the run lock and the database every few seconds.

Compared with WPF: SwiftUI views are like XAML with data binding, an `@Observable` class plays the view-model's part, and a `MenuBarExtra` scene is the tray icon.

## Building it

There's no Xcode project file. Admin is a Swift package (`apps/admin/Package.swift`), so it builds from Terminal, and Xcode can open the same folder (**File → Open… → apps/admin**) for editing and previews.

```bash
apps/admin/build.sh            # builds, and installs ~/Applications/Broadsheet Admin.app
```

The script compiles the package in release mode with Xcode's tools, wraps the program in an `.app` bundle with its `Info.plist` (a menu-bar app with no Dock icon), signs it for this Mac only (ad hoc), and copies it to `~/Applications`. Builds use Xcode through `DEVELOPER_DIR`, so the Mac's `xcode-select` setting doesn't matter.

## A1: the menu bar and Status

- **The menu-bar item** (a newspaper icon) shows what the agent is doing: **Idle**, **Checking mail…**, **Working (3 of 12)** with the title Gemma is reading, **Waiting — you're active** when items are waiting for you to step away, **Paused until …**, or a warning when the agent isn't scheduled. Below that: the last run and what it did, errors, and how many items wait for Gemma.
- **Run now** starts a full run straight away, ignoring the idle checks and any pause (`broadsheet run --force`). Its output goes to the agent's log like a scheduled run.
- **Pause for 1 hour / Pause until tomorrow** (6 a.m.) / **Resume**: scheduled runs do nothing while paused. The same from Terminal: `broadsheet pause 1h|30m|tomorrow|off`.
- **The Admin window** (**Open Admin…**, or ⌘,) has a **Status** page (state, schedule, backlog, the last 20 runs with their errors) and a **Log** page (the end of `~/Library/Logs/Broadsheet/agent.log`).
- **Start it at login:** *System Settings → General → Login Items → +* and choose `~/Applications/Broadsheet Admin.app`. Quitting it doesn't affect the agent, which runs on its own schedule either way.
- **Tests:** `apps/admin/build.sh --test` (Swift Testing: the state logic, reading the launchd job, and reading a database shaped like the agent's).

## A2: Sources

- **The Sources page** lists every newsletter and feed: name, section, format, latest post, posts in the last 30 days and your average rating (👍 +1, 👌 0, 👎 −1, with the number of ratings). Filter by Email or Feeds, search by name or address, and sort by any column. Badges mark newsletters that are **Off**, **New** (found by the agent), **Silent** (nothing for 30 days or more) or look like a **Roundup?**.
- **Editing:** pick one and the panel on the right changes its name, section (or "Gemma chooses"), format, and whether its emails are included. **Apply** runs `broadsheet source <id> …`; the same works from Terminal, e.g. `broadsheet source garden --section gardening --format roundup`.
  - A new **section** also moves its current articles, and their emails in Outlook, except ones you moved yourself.
  - Turned **off**, its emails are left in the Inbox from now on.
  - A silent newsletter offers **Turn it off**; a roundup-looking one offers **Make it a roundup**.
- **The database is now the master copy for sources:** a newsletter in the config file is copied in only when it's new or when its text in the file changes, so changes made in Admin stick. (Rules already worked this way.)
- **Posts per source** are counted in a `source_posts` table filled by the database itself whenever a post arrives (not for briefs), and kept 90 days, since items last only a few days.
- **Opening the window:** opening Broadsheet Admin yourself (Spotlight, Finder, Launchpad), even while it's already running, shows the Admin window; while it's open the app is in the Dock and ⌘-Tab. Started by Login Items, only the menu-bar item appears. (Before 2026-11-27, opening it from Spotlight while it was running showed nothing.)

## A3: Sections and folders

- **The Sections page** lists the sections in the paper's order, each with its current articles and the newsletters always filed there. Rename one in place, move it up or down, add one, or remove one (Everything Else can't be removed).
- **Preview changes** shows, in words, what will happen in the paper and in Outlook, for example *Rename "Financial & Retirement" to "Money", and its Outlook folder* or *Remove "Outdoors": its 12 emails move to the "Everything Else" folder; …; then its empty Outlook folder is deleted*. Nothing changes until **Apply**.
- **Removing never deletes mail:** the section's emails move to Everything Else's folder first, then the empty folder is deleted. Its current articles move to Everything Else, and newsletters that were always filed there go back to Gemma choosing.
- **One change at a time:** each change is made in Outlook first, then in the database. If Outlook fails, it stops there; what was done stays done, and applying the same list again finishes the rest.
- **The database is now the master copy for sections** too: the config file's list is copied in only when it changes.
- **From Terminal:** `broadsheet sections` lists them; `broadsheet sections set '[{"id":"technology","name":"Tech"},{"name":"Cooking"}]' --dry-run` previews (drop `--dry-run` to apply). An entry with no id is a new section.

## A4: Rules, your words and the Hidden list

- **The Rules page** has what the reader's has: **In your own words** (with what Gemma has learned from your ratings), **Suggestions** to approve or dismiss, **Your rules** to turn on or off, edit or delete, and **Add a rule** in plain English for Gemma to draft.
- **Exact rules** (**New exact rule…**, or **Edit** on one): a few words on what it's for; whether matching email is **hidden** (to Deleted Items, or left in the Inbox) or **always included** (into a section); one newsletter or all; and conditions on the sender, domain, subject, list, text, links or length, all of which must match or any one. **Test** shows which emails of the last 90 days it would have caught; **Save** can also hide the current articles it catches.
- **The mail log** makes testing possible: for every email the agent looks at, it keeps the sender, subject, list, length, links and what it decided, for 90 days, but not the text. So a condition on the text can only be tested against the last 4 days, and the test says how many it couldn't check. (Skipped mail is logged from 2026-11-27 on; A6's skipped-mail list will use it too.)
- **The Hidden page** lists what was left out of the paper and why, with **Show it again**.
- **From Terminal:** `broadsheet rules`, `broadsheet hidden`, `broadsheet rule test|save '<json>'`, and `broadsheet act '<json>'`, which applies the same actions the reader sends (your words, approving, hiding, showing again…).

## A5: Following and feeds

- **Follow by URL** (Sources page toolbar): paste a site's address, **Preview** shows its latest posts, then pick a name and section and **Follow**. No email sign-up; the agent checks the feed every hour. From Terminal: `broadsheet follow <url> [--preview] [--name "…"] [--section <id>]`. Sites with no feed (LinkedIn and some company sites, for example) say so; subscribe by email instead where they offer it.
- **Switch to its feed** (in an email newsletter's panel): the agent guesses its website from its posts (or a Substack list), previews the feed, and switches. It stays the same newsletter, with its name, section, ratings and history. Emails still arriving before you unsubscribe count as it, and a post that comes both ways is kept once. Afterwards it offers the unsubscribe link. From Terminal: `broadsheet switch-to-feed <id> [--url <site>] [--preview]`.
- **Unsubscribe helper:** the agent keeps each newsletter's unsubscribe link from its emails (the `List-Unsubscribe` header: a web page if there is one, else an email address). **Unsubscribe…** in its panel opens that page in your browser, or an unsubscribe email in Mail; you confirm it there. Newsletters you rate 👎 more often than not (3 or more ratings) get an **Unsubscribe?** badge, and the **👎 Often** filter lists them. Links are collected from new emails, so they fill in over a few days.
- **Already in place:** the best version of a post (an email and a feed copy of the same post are kept once, the fuller one; a feed teaser is replaced by its web page when that's fuller) and staleness (A2's **Silent** badge with **Turn it off**).
- **Errors** from the agent's commands are now one line (the message), which is what Admin shows; `BROADSHEET_DEBUG=1` adds where it happened.

## A6: Email

- **The Email page** has four parts:
  - **Mailbox:** everything in the Inbox (a mailbox just for newsletters, as yours is) or only what an include rule picks (a shared mailbox), and whether filed emails are marked as read.
  - **New newsletters:** how many the agent found by itself, with **Mark all as looked at**. The Sources page's **New** filter lists them, to rename one, fix its section or turn it off.
  - **Skipped mail:** what was left in the Inbox as account, sign-in, receipt or welcome mail, or from a newsletter you turned off. **Include this one** moves the email into `_Add`, and the next run includes it whatever it looks like.
  - **Dropped into _Add:** the emails you put there yourself.
- **Settings changed in Admin** are kept in the database and win over the config file; **Use the file's** goes back. From Terminal: `broadsheet settings`, `broadsheet set mailbox.mode shared`, `broadsheet set mailbox.mode --reset`. A7 adds the AI and politeness settings the same way.
- **From Terminal:** `broadsheet mail` (the lists), `broadsheet mail include <key>`, `broadsheet mail approve [<id>]`, and `broadsheet mail backfill`, which adds what the agent had left in the Inbox before the mail log started (run once on 2026-11-27: nothing was left by then).

## A7: Settings and Data

- **The Settings page:**
  - **AI:** the Ollama model (from those installed; another one is downloaded first with `ollama pull <name>`) and the context size.
  - **Compare models:** save a new test set from today's paper, run the comparison (your model alone, or against another installed one) in the background, and open the latest comparison page. It's `broadsheet eval` (P6).
  - **Sharing the Mac:** idle minutes before Gemma works, whether a locked screen counts as idle, the load above which AI work waits, what happens to a backlog while you're at the Mac, and an optional overnight window for the weekly profile rewrite.
  - **The paper:** days in the paper (1–14) and the ranking weights.
  - Each change is saved straight away and wins over the config file; **Use the file's** goes back.
- **Backlog "trickle"** now works (the setting existed but wasn't used): when items have waited longer than the set hours and the only reason Gemma is waiting is that you're at the Mac, it reads one item per run. It still waits when the Mac is busy, warm or short of memory.
- **Memory warnings** (changed 2026-11-27): once you've been away for the idle time, Gemma keeps working through a macOS memory *warning* and stops only at *critical*. Loading the model itself was setting off the warning, so the paper stalled with a growing backlog while nobody was at the Mac. While you're at the Mac, a warning still stops it.
- **The overnight window** (e.g. 1 to 5, or 22 to 6 across midnight): when set, the weekly profile rewrite waits for it.
- **The Data page:** what's stored and how big it is; **Export…** and **Import…** (one JSON file with your newsletters, sections, rules, settings, own words, and everything you rated, moved or hid: no article text; importing updates and adds, never deletes, and shows what it would bring in first); and what the Broadsheet has learned from you, with **Forget** for one item or for everything (your own words and rules stay).
- **From Terminal:** `broadsheet ai`, `storage`, `export <file>`, `import <file> [--dry-run]`, `forget <item id> | --all`, and `set <key> <value>` for every setting (`broadsheet settings` lists them).

## Crash safety and backups (2026-11-27)

The Mac mini is also a personal computer, so a run can be cut off by a power cut or a restart.

- **Already safe:** the database is SQLite in WAL mode with full sync, and related changes are saved together in transactions, so a cut-off run leaves each change either done or not done. An article is marked read only once Gemma's whole answer is saved, so a cut-off one is read again. A crashed run's lock is taken over by the next run. On OneDrive each file uploads whole, and `edition.json` goes last, so the reader never sees half an edition. Outlook moves happen on Microsoft's side.
- **Backups:** at the start of the first run each day, a compressed copy of the database goes to `~/Library/Application Support/Broadsheet/backups/` (the last 7 are kept; about 200 KB each today), and once a week a copy goes to `backups/` in the OneDrive App Folder (the last 4). Articles aren't included: they expire after a few days anyway. Admin's **Data** page lists them, with **Back up now** and **Restore…**; from Terminal: `broadsheet backups`, `backup`, `restore <date> --yes`.
- **Integrity check:** each run starts with SQLite's quick check. If the database is damaged, the run stops before changing anything, the menu bar says so, and it names the newest backup to restore. Restoring keeps the damaged database beside it (`broadsheet.damaged-<time>.db`); it's never deleted.
- **Article files** are written to a temporary file and then renamed into place, so a cut can't leave half an article.
- **An email stranded by a cut** (recorded, but the cut came before it was moved out of the Inbox, or before its text was written) is repaired on a later run: filed where its record says, or read again from scratch if its text is missing. Only emails recorded in the last day, and only once each, so an email you drag back to the Inbox yourself is left alone.
- **Time Machine** isn't set up on this Mac; setting it up with any external drive would protect everything else on it too.

