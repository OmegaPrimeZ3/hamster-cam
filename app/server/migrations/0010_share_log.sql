-- 0010_share_log.sql
-- Send-a-Clip audit + rate-limit ledger. `share.send` consults this table
-- (rows for this user within the past hour) before kicking off the ffmpeg
-- + Zyphr-email job.

CREATE TABLE share_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id    INTEGER NOT NULL REFERENCES share_recipients(id) ON DELETE CASCADE,
  diary_entry_id  INTEGER NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  status          TEXT    NOT NULL CHECK (status IN ('queued','sent','failed')),
  sent_at         INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_share_log_user_time   ON share_log(user_id, created_at DESC);
CREATE INDEX idx_share_log_status      ON share_log(status, created_at DESC);
