-- Refunds, withdrawals and pickup tracking for online orders.
--
-- orders.status is plain TEXT (no CHECK constraint), so the new value
-- 'refunded' needs no schema change: an order is 'refunded' once an admin has
-- refunded the payment in the HelloAsso dashboard and then marked it here
-- (/admin/orders/:id). Values now: pending, paid, expired, cancelled, refunded.
-- (class_dropin_seats.status is also unconstrained TEXT: in_cart, sold, released.)
--
-- Every column is added with IF NOT EXISTS, so the file is safe to re-run.

-- When the admin recorded the refund, and why (free text, never customer data).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_note TEXT;

-- Pickup: when the books were handed over, and by which admin account
-- (NULL after that account is erased).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- The 6-hourly sweep found, by asking HelloAsso, that a PAID order's payment
-- was refunded or cancelled there. Nothing is restocked automatically: the
-- admin marks the order refunded. refund_alert_sent_at: the one alert email.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_detected_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_alert_sent_at TIMESTAMPTZ;

-- Pickup reminders, each sent at most once per order: the customer's (day 10)
-- and the admin digest (day 12).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_pickup_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_reminder_sent_at TIMESTAMPTZ;

-- The HelloAsso payment-page link of a pending order, so a buyer who backed
-- out can resume paying from the cart page while the link is still valid
-- (about 15 minutes). Not personal data; only used for a pending order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_redirect_url TEXT;

-- "Paid and not collected" lists and the pickup sweeps.
CREATE INDEX IF NOT EXISTS idx_orders_awaiting_pickup ON orders (paid_at) WHERE status = 'paid' AND collected_at IS NULL;
