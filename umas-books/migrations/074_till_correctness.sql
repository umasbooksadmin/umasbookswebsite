-- Till correctness and money safety (second review).
--
-- till_sales.entered_at: when the sale was TYPED IN. created_at is the time the
-- sale happened (it can be set earlier for a sale written on paper), so a late
-- entry is recognised by entered_at, never by created_at.
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ;
UPDATE till_sales SET entered_at = created_at WHERE entered_at IS NULL;
ALTER TABLE till_sales ALTER COLUMN entered_at SET DEFAULT now();
ALTER TABLE till_sales ALTER COLUMN entered_at SET NOT NULL;

-- A hash of the basket (items and payment method) stored with the sale token: a
-- retry with the same token but different items is refused, not answered with the
-- first sale.
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS basket_hash TEXT;

-- Why the sale was entered with an earlier time (required for every backdated sale).
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS backdate_reason TEXT;

-- A voided CARD sale must be refunded on the card reader by hand; staff tick
-- "I refunded the card". Voided card sales not ticked yet are shown in Needs attention.
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS refund_confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS refund_confirmed_at TIMESTAMPTZ;
ALTER TABLE till_sales ADD COLUMN IF NOT EXISTS refund_confirmed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- A closed day can be reopened by an admin (with a reason) to record a late sale.
ALTER TABLE till_days ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE till_days ADD COLUMN IF NOT EXISTS reopened_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE till_days ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

-- The "Till" role: a volunteer who can use /admin/till without being an admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_till BOOLEAN NOT NULL DEFAULT false;
