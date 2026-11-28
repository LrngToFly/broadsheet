// Database migrations, applied in order. PRAGMA user_version records how many have run.
// Never edit a migration that has shipped; add a new one instead.
// Table design: PLAN.md §7.2. Content tables (items) are short-lived; the rest is long-term data (§7.1).

export const migrations: string[] = [
  /* 1: Phase 1 tables */ `
  CREATE TABLE sections (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    sort_order      INTEGER NOT NULL,
    mail_folder_id  TEXT
  ) STRICT;

  CREATE TABLE sources (
    id              TEXT PRIMARY KEY,
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'feed')),
    display_name    TEXT,
    match_json      TEXT,                 -- email: {sender?, domain?, listId?}
    feed_url        TEXT,                 -- feed: the resolved feed address
    site_url        TEXT,
    platform        TEXT,                 -- substack, beehiiv, ghost, ...
    status          TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('new', 'enabled', 'muted')),
    fixed_section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
    origin          TEXT NOT NULL CHECK (origin IN ('config', 'auto')),
    last_post_at    TEXT,
    created_at      TEXT NOT NULL
  ) STRICT;

  CREATE TABLE rules (
    id              TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('include', 'check', 'instruction')),
    wording         TEXT NOT NULL,
    match_mode      TEXT CHECK (match_mode IN ('all', 'any')),
    conditions_json TEXT,
    instruction     TEXT,
    source_id       TEXT REFERENCES sources(id) ON DELETE CASCADE,
    mail_action     TEXT CHECK (mail_action IN ('deleted-items', 'leave')),
    section_id      TEXT REFERENCES sections(id) ON DELETE SET NULL,
    status          TEXT NOT NULL CHECK (status IN ('suggested', 'active', 'off')),
    origin          TEXT NOT NULL CHECK (origin IN ('config', 'hidden-item', 'typed', 'admin')),
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL
  ) STRICT;

  CREATE TABLE feed_state (
    source_id       TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    etag            TEXT,
    last_modified   TEXT,
    next_poll_at    TEXT,
    poll_interval_s INTEGER NOT NULL DEFAULT 3600,
    last_error      TEXT
  ) STRICT;

  CREATE TABLE items (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'feed')),
    message_id      TEXT,                 -- Graph message id (email)
    internet_message_id TEXT,             -- RFC 5322 Message-ID (email), stable across folder moves
    mail_folder_id  TEXT,
    title           TEXT NOT NULL,
    author          TEXT,
    published_at    TEXT NOT NULL,
    url             TEXT,
    content_origin  TEXT CHECK (content_origin IN ('email', 'feed', 'web')),
    is_teaser       INTEGER NOT NULL DEFAULT 0,
    opening         TEXT NOT NULL DEFAULT '',
    word_count      INTEGER NOT NULL DEFAULT 0,
    section_id      TEXT REFERENCES sections(id) ON DELETE SET NULL,
    section_source  TEXT CHECK (section_source IN ('fixed', 'ai', 'user')),
    tags_json       TEXT NOT NULL DEFAULT '[]',
    summary         TEXT,
    key_points_json TEXT NOT NULL DEFAULT '[]',
    interest        INTEGER,
    why_its_here    TEXT,
    read_minutes    INTEGER,
    is_article      INTEGER,
    score           REAL NOT NULL DEFAULT 0,
    model           TEXT,
    ai_status       TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'done', 'failed', 'skipped')),
    ai_attempts     INTEGER NOT NULL DEFAULT 0,
    hidden_by       TEXT,                 -- rule id, or 'user'
    saved           INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  ) STRICT;
  CREATE INDEX items_published ON items(published_at);
  CREATE INDEX items_ai_status ON items(ai_status);

  -- "Already seen" keys (message ids, URL hashes) so nothing is processed twice. Kept 90 days.
  CREATE TABLE seen (
    key             TEXT PRIMARY KEY,
    first_seen_at   TEXT NOT NULL
  ) STRICT;

  CREATE TABLE runs (
    id              INTEGER PRIMARY KEY,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    stage           TEXT NOT NULL,
    counts_json     TEXT NOT NULL DEFAULT '{}',
    deferred_reason TEXT,
    errors_json     TEXT NOT NULL DEFAULT '[]',
    model           TEXT
  ) STRICT;

  -- Small pieces of agent state, e.g. the mail delta link.
  CREATE TABLE agent_state (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL
  ) STRICT;
  `,

  /* 2: publishing to OneDrive (M4) */ `
  ALTER TABLE items ADD COLUMN image TEXT;                                 -- hero image path in the App Folder
  ALTER TABLE items ADD COLUMN content_published INTEGER NOT NULL DEFAULT 0; -- items/<id>.html and its images are uploaded
  ALTER TABLE items ADD COLUMN feed_guid TEXT;                             -- feed entry id (feed items)
  CREATE INDEX items_url ON items(url);
  `,

  /* 3: remember each item's cached images, so unused ones can be deleted from OneDrive (M5) */ `
  ALTER TABLE items ADD COLUMN images_json TEXT;
  `,

  /* 4: ratings and preference records (Phase 2) */ `
  ALTER TABLE items ADD COLUMN rating INTEGER CHECK (rating IN (-1, 0, 1));
  ALTER TABLE items ADD COLUMN rated_at TEXT;

  -- Long-term (PLAN.md §7.1 row 5): what each rated, moved or hidden item was, without its text.
  -- Kept after the item itself expires; the ranking learns from it.
  CREATE TABLE preference_records (
    item_id          TEXT PRIMARY KEY,
    source_id        TEXT NOT NULL,
    author           TEXT,
    section_id       TEXT,
    tags_json        TEXT NOT NULL DEFAULT '[]',
    title            TEXT NOT NULL,
    url              TEXT,
    published_at     TEXT NOT NULL,
    rating           INTEGER CHECK (rating IN (-1, 0, 1)),
    moved_to_section TEXT,
    hidden_reason    TEXT,
    hidden_note      TEXT,
    updated_at       TEXT NOT NULL
  ) STRICT;
  CREATE INDEX preference_records_source ON preference_records(source_id);
  `,

  /* 5: section hints and the reader profile (Phase 2 P2) */ `
  -- items.section_source gains 'learned': filed by a hint from your moves. SQLite can't change a CHECK
  -- constraint in place, so the table is rebuilt with the same columns in the same order.
  CREATE TABLE items_new (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('email', 'feed')),
    message_id      TEXT,                 -- Graph message id (email)
    internet_message_id TEXT,             -- RFC 5322 Message-ID (email), stable across folder moves
    mail_folder_id  TEXT,
    title           TEXT NOT NULL,
    author          TEXT,
    published_at    TEXT NOT NULL,
    url             TEXT,
    content_origin  TEXT CHECK (content_origin IN ('email', 'feed', 'web')),
    is_teaser       INTEGER NOT NULL DEFAULT 0,
    opening         TEXT NOT NULL DEFAULT '',
    word_count      INTEGER NOT NULL DEFAULT 0,
    section_id      TEXT REFERENCES sections(id) ON DELETE SET NULL,
    section_source  TEXT CHECK (section_source IN ('fixed', 'ai', 'user', 'learned')),
    tags_json       TEXT NOT NULL DEFAULT '[]',
    summary         TEXT,
    key_points_json TEXT NOT NULL DEFAULT '[]',
    interest        INTEGER,
    why_its_here    TEXT,
    read_minutes    INTEGER,
    is_article      INTEGER,
    score           REAL NOT NULL DEFAULT 0,
    model           TEXT,
    ai_status       TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'done', 'failed', 'skipped')),
    ai_attempts     INTEGER NOT NULL DEFAULT 0,
    hidden_by       TEXT,                 -- rule id, or 'user'
    saved           INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    image           TEXT,
    content_published INTEGER NOT NULL DEFAULT 0,
    feed_guid       TEXT,
    images_json     TEXT,
    rating          INTEGER CHECK (rating IN (-1, 0, 1)),
    rated_at        TEXT
  ) STRICT;
  INSERT INTO items_new SELECT * FROM items;
  DROP TABLE items;
  ALTER TABLE items_new RENAME TO items;
  CREATE INDEX items_published ON items(published_at);
  CREATE INDEX items_ai_status ON items(ai_status);
  CREATE INDEX items_url ON items(url);

  -- Long-term (PLAN.md §7.1 row 6): the profile Gemma writes from your ratings. The last 4 are kept.
  CREATE TABLE reader_profiles (
    version         INTEGER PRIMARY KEY,
    text            TEXT NOT NULL,
    built_at        TEXT NOT NULL,
    model           TEXT NOT NULL,
    ratings_used    INTEGER NOT NULL
  ) STRICT;
  `,

  /* 6: hiding from the reader (Phase 2 P3) */ `
  ALTER TABLE items ADD COLUMN hidden_reason TEXT;  -- your quick reason, when hidden_by = 'user'
  ALTER TABLE items ADD COLUMN hidden_note TEXT;    -- what you typed, if anything
  ALTER TABLE items ADD COLUMN hidden_at TEXT;
  -- You said "Show it again": rules and Gemma's "not an article" no longer hide it.
  ALTER TABLE items ADD COLUMN shown_anyway INTEGER NOT NULL DEFAULT 0;
  `,

  /* 7: your own words, notes on ratings, and rules from the reader (Phase 2 P4) */ `
  ALTER TABLE items ADD COLUMN sender TEXT;      -- sender address and List-Id, so a draft Check rule can be previewed
  ALTER TABLE items ADD COLUMN list_id TEXT;
  ALTER TABLE items ADD COLUMN rescore INTEGER NOT NULL DEFAULT 0;  -- your words changed: Gemma re-scores interest
  ALTER TABLE preference_records ADD COLUMN rating_note TEXT;       -- why you rated it, if you said
  ALTER TABLE rules ADD COLUMN preview_json TEXT NOT NULL DEFAULT '[]'; -- suggestions: current items it would hide

  -- Gemma's drafting queue: an item you hid, words you typed, or new wording for a rule.
  CREATE TABLE rule_requests (
    id              INTEGER PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('hidden-item', 'typed', 'edit')),
    item_id         TEXT,
    source_id       TEXT,
    -- hidden-item: what Gemma needs, copied in case the item expires first. The excerpt is cleared once drafted.
    facts_json      TEXT,
    excerpt         TEXT,
    reason          TEXT,
    note            TEXT,
    text            TEXT,                 -- typed words, or the new wording
    rule_id         TEXT,                 -- edit: the rule; otherwise the suggestion it produced
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'dismissed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  ) STRICT;

  -- Which items each rule hid, for "hid N in the last 30 days". Kept 30 days.
  CREATE TABLE rule_hits (
    rule_id         TEXT NOT NULL,
    item_id         TEXT NOT NULL,
    at              TEXT NOT NULL,
    PRIMARY KEY (rule_id, item_id)
  ) STRICT;
  `,

  /* 8: roundup and multi-section newsletters (Phase 2 P5, PLAN.md §4.4) */ `
  ALTER TABLE sources ADD COLUMN format TEXT NOT NULL DEFAULT 'normal' CHECK (format IN ('normal', 'roundup', 'multi-section'));
  ALTER TABLE sources ADD COLUMN looks_like TEXT;  -- 'roundup' when a normal newsletter is laid out like one (a suggestion)
  -- A split newsletter is kept as kind 'newsletter' (not shown; it holds the email and "Read the whole newsletter").
  -- Each piece is an item of its own: 'brief' (from a roundup) or 'article' (from a multi-section newsletter).
  ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT 'article' CHECK (kind IN ('article', 'brief', 'newsletter'));
  ALTER TABLE items ADD COLUMN parent_id TEXT REFERENCES items(id) ON DELETE SET NULL;
  ALTER TABLE items ADD COLUMN piece INTEGER;      -- its place in the newsletter, from 1
  ALTER TABLE items ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]'; -- a piece's links, to spot the same story elsewhere
  CREATE INDEX items_parent ON items(parent_id);
  `,

  /* 9: posts per source over time, for Admin's Sources list (Phase 3 A2) */ `
  -- One row per email or feed post (not per brief), kept 90 days: items themselves last only a few days.
  CREATE TABLE source_posts (
    item_id         TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    published_at    TEXT NOT NULL
  ) STRICT;
  CREATE INDEX source_posts_source ON source_posts(source_id, published_at);
  INSERT OR IGNORE INTO source_posts SELECT id, source_id, published_at FROM items WHERE parent_id IS NULL;
  -- Recorded by the database itself whenever a post arrives, whichever code adds it.
  CREATE TRIGGER items_count_posts AFTER INSERT ON items WHEN NEW.parent_id IS NULL
  BEGIN
    INSERT OR IGNORE INTO source_posts (item_id, source_id, published_at) VALUES (NEW.id, NEW.source_id, NEW.published_at);
  END;
  `,

  /* 10: the mail log, for testing rules against recent mail (Phase 3 A4) and the skipped-mail list (A6) */ `
  -- One row per email Stage A looked at, kept 90 days: who sent it, its subject, list, length and links, and what was
  -- decided. No article text (rules on body text are tested against the current items only).
  CREATE TABLE mail_log (
    message_key     TEXT PRIMARY KEY,     -- the RFC 5322 Message-ID
    message_id      TEXT,                 -- Graph's id, to find the email again
    received_at     TEXT NOT NULL,
    sender          TEXT NOT NULL,
    sender_name     TEXT,
    subject         TEXT NOT NULL,
    list_id         TEXT,
    word_count      INTEGER NOT NULL DEFAULT 0,
    links_json      TEXT NOT NULL DEFAULT '[]',
    source_id       TEXT,
    decision        TEXT NOT NULL CHECK (decision IN ('include', 'skip', 'hide')),
    why             TEXT,
    rule_id         TEXT,
    item_id         TEXT
  ) STRICT;
  CREATE INDEX mail_log_received ON mail_log(received_at);
  INSERT OR IGNORE INTO mail_log (message_key, message_id, received_at, sender, subject, list_id, word_count, source_id, decision, why, rule_id, item_id)
    SELECT coalesce(internet_message_id, id), message_id, published_at, coalesce(sender, ''), title, list_id, word_count, source_id,
           CASE WHEN hidden_by IS NOT NULL AND hidden_by != 'user' AND ai_status = 'skipped' THEN 'hide' ELSE 'include' END,
           NULL, CASE WHEN ai_status = 'skipped' THEN hidden_by END, id
    FROM items WHERE channel = 'email' AND parent_id IS NULL;
  `,

  /* 11: unsubscribe links (Phase 3 A5) */ `
  -- From the newsletter's List-Unsubscribe header: a web page, or an email address. For Admin's unsubscribe helper.
  ALTER TABLE sources ADD COLUMN unsubscribe_url TEXT;
  `,

  /* 12: split only some of a newsletter's emails (2026-11-27) */ `
  -- For a roundup or multi-section newsletter: JSON {subject?, weekend?, looksLike?}; any one matching splits the
  -- email. NULL: every email is split (as before).
  ALTER TABLE sources ADD COLUMN split_when TEXT;
  `,

  /* 13: what you've read, on any device (2026-11-27) */ `
  -- Set when you open an article in the reader; it goes with the item when the item expires (no reading history).
  ALTER TABLE items ADD COLUMN read_at TEXT;
  `,

  /* 14: the same story in several newsletters, matched by Gemma (2026-11-27) */ `
  ALTER TABLE items ADD COLUMN story_id TEXT;      -- items Gemma found telling the same story share one id
  ALTER TABLE items ADD COLUMN story_checked INTEGER NOT NULL DEFAULT 0; -- compared with the others once
  CREATE INDEX items_story ON items(story_id);
  `,

  /* 15: newsletters you always want shown, and the cartoon of the day (2026-11-27) */ `
  ALTER TABLE sources ADD COLUMN always_show INTEGER NOT NULL DEFAULT 0; -- its newest post is pinned until you've read it
  ALTER TABLE items ADD COLUMN cartoon_json TEXT;  -- {imageUrl, alt, caption, artist} when the email has a cartoon of the day
  `,

  /* 16: the cartoon of the day is a per-newsletter setting (2026-11-28) */ `
  ALTER TABLE sources ADD COLUMN cartoon INTEGER NOT NULL DEFAULT 0; -- its emails' "Today's Cartoon" goes at the top of Everything Else
  UPDATE sources SET cartoon = 1 WHERE id IN (SELECT DISTINCT source_id FROM items WHERE cartoon_json IS NOT NULL);
  `,
];
