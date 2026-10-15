-- Quote requests submitted from the Contact page.
CREATE TABLE IF NOT EXISTS quotes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  division      TEXT    NOT NULL,
  details       TEXT    NOT NULL,
  ip_hash       TEXT    NOT NULL,
  user_agent    TEXT,
  email_status  TEXT    NOT NULL DEFAULT 'pending',  -- pending | sent | failed | not_configured
  email_error   TEXT
);

CREATE INDEX IF NOT EXISTS quotes_ip_time ON quotes (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS quotes_time    ON quotes (created_at);
