-- 0009_share_recipients.sql
-- Pre-approved Send-a-Clip allowlist. Admins add each recipient once in
-- Settings → Sharing; children pick from this list — they cannot type
-- arbitrary addresses (PLAN §5.4 Send-a-Clip).

CREATE TABLE share_recipients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT    NOT NULL,
  email        TEXT    NOT NULL,
  -- added_by is preserved for audit-trail visibility, but the recipient
  -- itself (a family contact) outlives the admin who first added it; mirror
  -- the audit_log pattern of SET NULL on user deletion.
  added_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_share_recipients_email ON share_recipients(email);
