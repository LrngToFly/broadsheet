# Phase 3 — Admin & sources

Goal (from [PLAN.md §11](../PLAN.md#11-phased-delivery)): you manage everything without touching config files. The Admin console is a native Mac app (SwiftUI) on the Mac mini, with a menu-bar item ([PLAN.md §8.2](../PLAN.md#82-admin-console-swiftui)).

| # | Milestone | You can… | Status |
|---|---|---|---|
| A1 | **The app and the menu bar:** a menu-bar item showing what the agent is doing (**Idle**, **Waiting — you're active**, **Working (3 of 12)**, **Paused**), the last run, the backlog and errors; **Run now** and **Pause for 1 hour / until tomorrow**; an Admin window with a Status page and the log viewer. Built from the command line into `~/Applications/Broadsheet Admin.app` | see and control the agent without Terminal | built |
| A2 | **Sources:** one list (email and feeds) with latest post date, posts in the last 30 days and average rating; rename, fixed section, mute, format (normal, roundup, multi-section) and roundup suggestions; sources silent for a long time highlighted with **Disable**. The database becomes the master copy for sources | manage your newsletters | built |
| A3 | **Sections and folders:** add, rename, reorder or remove sections, with a preview of each Outlook folder change before it's applied | change the paper's sections | built |
| A4 | **Rules and your words:** the reader's Rules page and Hidden list in Admin, plus the full condition editor for Check and include rules with **Test against recent mail** | edit rules precisely | |
| A5 | **Following and feeds:** **Follow by URL** with a preview, **Switch to feed**, best version (email, feed or web page), staleness, and the unsubscribe helper | follow authors without email | |
| A6 | **Email:** mailbox mode, New sources, skipped mail with **Include this one**, and emails dropped into `_Add` | catch what was missed | |
| A7 | **Data, AI and politeness:** export / import, **Forget** ratings, storage sizes; the Ollama model and context size; **Run eval**; idle threshold, limits, backlog behaviour, overnight window | tune it all in one place | |

## How Admin talks to the agent

The agent (TypeScript, run by launchd every 15 minutes) already does everything that touches Microsoft, Ollama or the rules: sign-in, Graph, folders, Gemma, validation. Admin shouldn't do any of that a second time in Swift. So:

- **Admin reads the database directly**, read-only, through SQLite's own C library built into macOS (`import SQLite3`, a small wrapper, no extra packages to download). Reading is safe while the agent runs, because the database is in WAL mode. Plain SQL tables are the contract, as planned ([PLAN.md §2](../PLAN.md)).
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
- **Open the window directly:** `open -a "Broadsheet Admin" --args --admin` starts the app with the Admin window open (otherwise only the menu-bar item appears).

## A3: Sections and folders

- **The Sections page** lists the sections in the paper's order, each with its current articles and the newsletters always filed there. Rename one in place, move it up or down, add one, or remove one (Everything Else can't be removed).
- **Preview changes** shows, in words, what will happen in the paper and in Outlook, for example *Rename "Financial & Retirement" to "Money", and its Outlook folder* or *Remove "Outdoors": its 12 emails move to the "Everything Else" folder; …; then its empty Outlook folder is deleted*. Nothing changes until **Apply**.
- **Removing never deletes mail:** the section's emails move to Everything Else's folder first, then the empty folder is deleted. Its current articles move to Everything Else, and newsletters that were always filed there go back to Gemma choosing.
- **One change at a time:** each change is made in Outlook first, then in the database. If Outlook fails, it stops there; what was done stays done, and applying the same list again finishes the rest.
- **The database is now the master copy for sections** too: the config file's list is copied in only when it changes.
- **From Terminal:** `broadsheet sections` lists them; `broadsheet sections set '[{"id":"technology","name":"Tech"},{"name":"Cooking"}]' --dry-run` previews (drop `--dry-run` to apply). An entry with no id is a new section.

