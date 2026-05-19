-- 0003_sessions.sql
-- App-issued opaque session rows backing the `__Host-session` cookie.
-- Passwords / hashes / brute-force lockouts live at Zyphr — never here.

CREATE TABLE sessions (
  id                  TEXT    PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zyphr_refresh_token TEXT,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  user_agent          TEXT
);

CREATE INDEX idx_sessions_user    ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
