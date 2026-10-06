-- A membership payment whose payer email matches no confirmed account used to
-- be only console.warn'ed. It is now recorded with user_id NULL and
-- unmatched_at set, so the admin sees it (/admin/members, "Unmatched
-- membership payments"), is alerted, and can link it to an account (typo in
-- the email typed on HelloAsso's own form, or paid with another address).
-- unmatched_reason: 'no_account' | 'unverified'.
-- alerted_at: when the admin alert covering this payment was sent.
-- Rows with user_id NULL and unmatched_at NULL are payments of erased
-- accounts (lib/privacy.js) and are not shown.

ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS unmatched_at TIMESTAMPTZ;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS unmatched_reason TEXT;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_membership_payments_unmatched ON membership_payments (unmatched_at)
  WHERE user_id IS NULL AND unmatched_at IS NOT NULL;
