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
];
