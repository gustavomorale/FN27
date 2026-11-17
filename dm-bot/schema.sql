-- FN DM automation, D1 schema
CREATE TABLE IF NOT EXISTS contacts (
  channel       TEXT NOT NULL,              -- 'ig' | 'wa'
  id            TEXT NOT NULL,              -- Instagram-scoped id or WhatsApp number
  name          TEXT,
  username      TEXT,
  tags          TEXT NOT NULL DEFAULT '[]', -- JSON array
  mode          TEXT NOT NULL DEFAULT 'bot',-- 'bot' | 'human'
  human_until   INTEGER,                    -- ms epoch, bot resumes after this
  needs_human   INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  opted_out     INTEGER NOT NULL DEFAULT 0, -- broadcasts only
  last_inbound  INTEGER,
  last_outbound INTEGER,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  direction  TEXT NOT NULL,   -- 'in' | 'out'
  kind       TEXT NOT NULL,   -- dm | comment | comment_reply | private_reply | template | system
  text       TEXT,
  source     TEXT,            -- user | flow:<id> | ai | human | human_app | broadcast | system
  meta       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(channel, contact_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);

CREATE TABLE IF NOT EXISTS flows (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,   -- JSON
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- webhook de-duplication and ids of messages we sent (to spot replies typed in the IG app)
CREATE TABLE IF NOT EXISTS seen (
  event_id   TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
