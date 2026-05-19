-- 0008_audit_log.sql
-- Append-only audit trail. Written by the `adminProcedure` tRPC middleware
-- after every successful mutation. Read-only admin tab surfaces this. There
-- is intentionally no audit.delete / audit.update endpoint.

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  details       TEXT,
  at            INTEGER NOT NULL
);

CREATE INDEX idx_audit_at    ON audit_log(at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, at DESC);
