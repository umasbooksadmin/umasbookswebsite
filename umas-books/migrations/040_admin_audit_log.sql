-- Append-only record of sensitive admin actions (GDPR accountability).
-- Holds only admin ids/emails and numeric target ids, never member data.
-- No foreign key: rows outlive an erased admin account. Purged after 12 months.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id INTEGER,
  actor_label TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_log_at_idx ON admin_audit_log (at DESC);
