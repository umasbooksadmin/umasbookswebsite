-- Outbox for every customer email. Mail used to be sent fire-and-forget: if
-- Gmail was down, rate-limited or the app password was revoked, a buyer paid
-- and never got a confirmation, and nobody knew. Now a message is stored
-- first (inside the caller's transaction when there is one, so a paid order
-- and its confirmation are queued atomically), sent immediately on a best
-- effort basis, and retried by a background worker with backoff.
-- status: pending (to send), sent, failed (gave up: an admin was alerted),
-- handled (a failed row an admin acknowledged).
-- Sent rows' subject/body/recipient are personal data: lib/privacy.js blanks
-- them after RETENTION.outboxSentDays (failed/handled: outboxFailedDays); the
-- row itself stays as a bare delivery record until the same purge deletes it.

CREATE TABLE IF NOT EXISTS email_outbox (
  id               BIGSERIAL PRIMARY KEY,
  to_email         TEXT NOT NULL,
  subject          TEXT NOT NULL,
  body_text        TEXT NOT NULL,
  body_html        TEXT,
  headers          JSONB NOT NULL DEFAULT '{}'::jsonb,
  lang             TEXT,
  kind             TEXT NOT NULL,
  related_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'handled')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_try_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at          TIMESTAMPTZ,
  failed_at        TIMESTAMPTZ,
  alerted_at       TIMESTAMPTZ,
  handled_at       TIMESTAMPTZ,
  purged_at        TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox (next_try_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_outbox_created ON email_outbox (created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_order ON email_outbox (related_order_id) WHERE related_order_id IS NOT NULL;

-- Set when an order confirmation was actually sent. Orders paid before this
-- migration are assumed confirmed (the old code sent at payment time), so the
-- admin "no confirmation" warning does not fire for history.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;
UPDATE orders SET confirmation_sent_at = COALESCE(paid_at, created_at) WHERE status = 'paid' AND confirmation_sent_at IS NULL;
