-- WhatsApp Auto-Answer DB schema (v2)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chats (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  is_group        INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_last_message_at ON chats(last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  from_me     INTEGER NOT NULL,
  author      TEXT,
  body        TEXT,
  type        TEXT,
  timestamp   INTEGER NOT NULL,
  is_auto     INTEGER NOT NULL DEFAULT 0,
  has_media   INTEGER NOT NULL DEFAULT 0,
  transcript  TEXT,                              -- whisper transcript for voice notes
  raw_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp DESC);

-- Personas: built-in (is_builtin=1, not deletable) + user-created.
CREATE TABLE IF NOT EXISTS personas (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  prompt       TEXT NOT NULL,
  is_builtin   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id              TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  auto_reply           INTEGER NOT NULL DEFAULT 0,
  reply_delay_ms       INTEGER NOT NULL DEFAULT 15000,
  context_messages     INTEGER NOT NULL DEFAULT 20,
  persona_id           TEXT REFERENCES personas(id) ON DELETE SET NULL,
  style_mimic_strength INTEGER NOT NULL DEFAULT 50,    -- 0..100
  persona_prompt       TEXT,                            -- custom additional instruction
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  trigger_msg_id  TEXT NOT NULL,
  fire_at         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  result          TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reply_queue_status ON reply_queue(status, fire_at);
CREATE INDEX IF NOT EXISTS idx_reply_queue_chat ON reply_queue(chat_id);

CREATE TABLE IF NOT EXISTS analyses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  tips        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analyses_chat ON analyses(chat_id, created_at DESC);

-- Media files attached to messages. file_path is relative to project root.
CREATE TABLE IF NOT EXISTS media (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  mime_type   TEXT,
  file_name   TEXT,                              -- original name from sender (may be null)
  file_path   TEXT NOT NULL,                     -- relative path on disk
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'file',      -- image|audio|video|document|sticker|file
  timestamp   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_chat_ts ON media(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_media_message ON media(message_id);

-- Per-chat triggers: when a pattern matches an incoming message body, fire an action.
-- Triggers belong to a single chat; they never apply to other chats.
CREATE TABLE IF NOT EXISTS triggers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id           TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  name              TEXT,                              -- optional label
  pattern           TEXT NOT NULL,
  match_mode        TEXT NOT NULL DEFAULT 'substring', -- substring|word|exact|regex
  case_sensitive    INTEGER NOT NULL DEFAULT 0,
  action_type       TEXT NOT NULL DEFAULT 'reply',     -- reply|prompt|skip
  action_value      TEXT,                              -- fixed reply text or prompt override
  delay_override_ms INTEGER,                           -- null -> use chat reply_delay_ms
  priority          INTEGER NOT NULL DEFAULT 0,        -- higher fires first
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_chat ON triggers(chat_id, enabled, priority DESC);

-- Pending AI-generated suggestions awaiting user approval.
CREATE TABLE IF NOT EXISTS suggestions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id        TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  trigger_msg_id TEXT,                      -- which incoming msg triggered this
  variants       TEXT NOT NULL,             -- JSON array of strings
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|sent|discarded|edited
  picked_index   INTEGER,                   -- which variant was used
  sent_body      TEXT,                      -- actually sent text (may differ from variant if edited)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_chat_status ON suggestions(chat_id, status, created_at DESC);

-- Single-row user profile (the human running the bot). All fields nullable.
CREATE TABLE IF NOT EXISTS user_profile (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT,
  bio_short       TEXT,                              -- ~150 chars, always in prompt
  bio_full        TEXT,                              -- full Markdown-ish description
  mood_today      TEXT,                              -- e.g. "müde", "fit", "busy"
  energy_today    TEXT,                              -- low|medium|high
  current_focus   TEXT,                              -- "arbeite an Projekt X"
  mood_set_at     INTEGER,                           -- ms timestamp; daily-reset checks this
  updated_at      INTEGER NOT NULL
);

-- Recurring + ad-hoc schedule entries.
CREATE TABLE IF NOT EXISTS user_schedule (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL DEFAULT 'once',      -- once|recurring
  title           TEXT NOT NULL,
  notes           TEXT,
  -- once: start_ts / end_ts are absolute ms timestamps; recurrence ignored.
  -- recurring: start_time / end_time are "HH:MM"; recurrence is a comma list
  --   of weekday tokens (MON,TUE,WED,THU,FRI,SAT,SUN) or "DAILY".
  start_ts        INTEGER,
  end_ts          INTEGER,
  start_time      TEXT,
  end_time        TEXT,
  recurrence      TEXT,
  busy            INTEGER NOT NULL DEFAULT 1,        -- 1 = blocks, 0 = informational
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_schedule_enabled ON user_schedule(enabled, kind);

-- AI-suggested bio entries awaiting user confirmation.
-- target='user'  -> applies to user_profile.bio_full
-- target='chat'  -> applies to chat_memory (auto-extracted facts about a contact)
CREATE TABLE IF NOT EXISTS bio_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target          TEXT NOT NULL,                     -- user|chat
  chat_id         TEXT REFERENCES chats(id) ON DELETE CASCADE,
  note            TEXT NOT NULL,
  evidence        TEXT,                              -- short snippet from the source chat
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted|dismissed
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bio_suggestions_status ON bio_suggestions(status, target);

-- Quality scores per AI reply (audited after-the-fact).
CREATE TABLE IF NOT EXISTS quality_scores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   TEXT,
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  too_long     INTEGER NOT NULL DEFAULT 0,
  too_formal   INTEGER NOT NULL DEFAULT 0,
  hallucination INTEGER NOT NULL DEFAULT 0,
  needless_question INTEGER NOT NULL DEFAULT 0,
  overall_score INTEGER NOT NULL DEFAULT 0,    -- 0..100
  notes        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quality_chat ON quality_scores(chat_id, created_at DESC);

-- Scheduled messages: cron- or event-based AI-generated nachrichten.
-- chat_id NULL = global (selects targets at run-time via target_filter).
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT REFERENCES chats(id) ON DELETE CASCADE,   -- null = global
  name          TEXT NOT NULL,
  schedule_kind TEXT NOT NULL DEFAULT 'cron',  -- cron|once|after_silence
  schedule_spec TEXT NOT NULL,                  -- cron string OR ISO ts OR seconds-of-silence
  prompt        TEXT NOT NULL,                  -- AI instruction (or fixed text if mode='fixed')
  mode          TEXT NOT NULL DEFAULT 'ai',     -- ai|fixed
  target_filter TEXT,                           -- when chat_id null: JSON {auto_reply?, persona_id?, has_persona?}
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   INTEGER,
  next_run_at   INTEGER,                        -- cached evaluation
  last_result   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_active ON scheduled_messages(enabled, next_run_at);

-- Persistent memory notes per chat — facts that should always be in the AI prompt.
CREATE TABLE IF NOT EXISTS chat_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual|analysis|auto
  pinned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_memory_chat ON chat_memory(chat_id, pinned DESC, created_at DESC);

-- Full-text search index over message bodies + voice transcripts.
-- `content=''` means external content; we write to the FTS table from migrations + triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  chat_id    UNINDEXED,
  from_me    UNINDEXED,
  timestamp  UNINDEXED,
  body,
  transcript,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Triggers keep FTS in sync with the messages table.
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts(message_id, chat_id, from_me, timestamp, body, transcript)
  VALUES (new.id, new.chat_id, new.from_me, new.timestamp,
          COALESCE(new.body, ''), COALESCE(new.transcript, ''));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages
BEGIN
  UPDATE messages_fts SET
    body = COALESCE(new.body, ''),
    transcript = COALESCE(new.transcript, '')
  WHERE message_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- AI-Session: goal-driven autonomous dialog driven by an `initial_prompt`.
-- Only one row per chat may be `active` at any time (enforced in repo helpers).
CREATE TABLE IF NOT EXISTS ai_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  initial_prompt  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',   -- active|paused|completed|stopped|failed
  turns_count     INTEGER NOT NULL DEFAULT 0,
  max_turns       INTEGER NOT NULL DEFAULT 20,
  stop_keywords   TEXT,                              -- comma-separated; when other side says any of these → end
  started_at      INTEGER NOT NULL,
  last_run_at     INTEGER,
  ended_at        INTEGER,
  ended_reason    TEXT                               -- max_turns|manual_stop|manual_pause|stop_keyword|ai_completed|user_replied
);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_chat ON ai_sessions(chat_id, status);

-- Folders for grouping summaries (Plan / Roadmap view).
CREATE TABLE IF NOT EXISTS summary_folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- AI-generated Markdown summaries of chat histories. May aggregate one chat or
-- span a date range; chat_id is nullable to leave room for cross-chat summaries.
CREATE TABLE IF NOT EXISTS summaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id     INTEGER REFERENCES summary_folders(id) ON DELETE SET NULL,
  chat_id       TEXT,                                       -- nullable; some summaries may aggregate
  title         TEXT NOT NULL,
  template      TEXT NOT NULL DEFAULT 'general',
  range_kind    TEXT NOT NULL DEFAULT 'last_n',             -- last_n | range
  range_value   TEXT NOT NULL,                              -- "100" or "<from_ms>,<to_ms>"
  system_prompt TEXT,                                       -- the system prompt used (saved for reproducibility)
  content_md    TEXT NOT NULL,                              -- the generated markdown
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_folder ON summaries(folder_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_chat   ON summaries(chat_id, created_at DESC);
