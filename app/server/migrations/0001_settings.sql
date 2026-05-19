-- 0001_settings.sql
-- Key/value config table. Single source of truth for pet identity, theme,
-- onboarding state, retention windows, and disk-watch thresholds. Read by
-- both backend and frontend through tRPC `settings.get`.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed default rows. INSERT OR IGNORE so re-running an idempotent migration
-- never overwrites a value the admin has tweaked. The set of keys here is
-- the v1 vocabulary; new keys go in a later migration file.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('pet_name',                ''),
  ('pet_emoji',               '🐾'),
  ('theme',                   'bubblegum'),
  ('theme_mode',              'auto'),
  ('read_aloud',              'false'),
  ('auto_rotate',             'false'),
  ('onboarding_complete',     'false'),
  ('snapshot_retention_days', '90'),
  ('timelapse_retention_days','30'),
  ('audit_retention_days',    '365'),
  ('disk_warn_pct',           '85'),
  ('disk_critical_pct',       '95'),
  ('transition_window_ms',    '8000'),
  ('min_dwell_ms',            '2000'),
  ('share_rate_limit_per_hour','10');
