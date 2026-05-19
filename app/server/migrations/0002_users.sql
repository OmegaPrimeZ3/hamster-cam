-- 0002_users.sql
-- Local mirror of the Zyphr.dev account directory. Credentials live at Zyphr;
-- this table carries the role + display name + the `zyphr_user_id` linkage.
-- The presence of a row here is the authorization gate: a valid Zyphr login
-- with no local row returns 403 `not_provisioned` (PLAN §7.6.2).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  zyphr_user_id TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin','child')),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  created_by    INTEGER REFERENCES users(id)
);

CREATE INDEX idx_users_email ON users(email);
