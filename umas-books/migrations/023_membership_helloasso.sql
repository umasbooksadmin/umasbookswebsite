-- Membership now signs up and pays through a HelloAsso-hosted "Adhésion"
-- form (see src/routes/helloassoWebhook.js) instead of the old mailto
-- registration form. A payment there isn't tied to one of our own orders
-- rows the way shop/checkout payments are, so it's tracked separately
-- here and matched back to a site account by payer email.

ALTER TABLE users ADD COLUMN IF NOT EXISTS member_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS membership_payments (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  helloasso_order_id  BIGINT NOT NULL UNIQUE,
  payer_email         TEXT NOT NULL,
  amount_cents        INTEGER,
  paid_at             TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
