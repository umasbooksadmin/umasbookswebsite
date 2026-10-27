-- Review F, F1: a membership payment that HelloAsso later refunds or loses in a dispute used to be DELETED
-- (lib/membership.js), so an accounting month already given to the treasurer lost its Membership row
-- afterwards and the month of the refund showed no reversal. The row is now KEPT (French law: 10 years)
-- and marked:
--   reversed_at            when we first saw the refund / dispute; NULL = the payment stands. Set once.
--   reversed_amount_cents  the amount reversed (the whole payment; NULL when the payment has no amount recorded).
-- The accounting export adds a NEGATIVE Membership row dated reversed_at; membership validity ignores reversed rows.
-- Both columns are nullable with no default: adds no row rewrite.
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE membership_payments ADD COLUMN IF NOT EXISTS reversed_amount_cents INTEGER;

-- Review F, F4: a reservation collected with "Mark collected and paid" (or at the till) marked its copies sold
-- WITHOUT sold_at / sold_via, so the inventory export's "Date sold" was blank. The code now sets them
-- (sold_via 'reservation'). One-off backfill of copies already sold that way: the date is the order's paid_at,
-- sold_via is set only for orders that were collected in person (collected_at set; an old online-checkout order
-- keeps sold_via NULL = online). Idempotent: only copies with sold_at still NULL are touched.
UPDATE book_copies c
SET sold_at = x.paid_at,
    sold_via = CASE WHEN x.collected THEN 'reservation' ELSE c.sold_via END
FROM (
  SELECT oi.book_copy_id, MAX(o.paid_at) AS paid_at, bool_or(o.collected_at IS NOT NULL) AS collected
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.status = 'paid' AND o.paid_at IS NOT NULL AND oi.book_copy_id IS NOT NULL
  GROUP BY oi.book_copy_id
) x
WHERE c.id = x.book_copy_id AND c.status = 'sold' AND c.sold_at IS NULL;
