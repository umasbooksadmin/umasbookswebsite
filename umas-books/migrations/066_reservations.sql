-- Reserve online, pay at the shop (replaces online payment for books and
-- class seats; membership stays on HelloAsso).
--
-- orders.status is plain TEXT (no CHECK), so the new status 'reserved' needs no
-- schema change. Values now: reserved, paid, refunded, expired, cancelled and
-- (legacy, from the old online checkout) pending. Reserved books are
-- book_copies.status = 'reserved' (cart_order_id points at the order), reserved
-- seats are class_dropin_seats.status = 'reserved'. Every change here is
-- additive: nothing is dropped (the HelloAsso columns of old orders stay).

-- The deadline: now + 14 days for books (extendable once by 7 days); for an
-- order with only a drop-in seat, the end of the session.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_extended_at TIMESTAMPTZ;

-- How a reservation ended without a sale: released_at + release_reason
-- ('customer', 'admin', 'expired', 'no_show', 'account_erased').
ALTER TABLE orders ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS release_reason TEXT;
-- The one "your reservation has lapsed" email per order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expiry_notice_sent_at TIMESTAMPTZ;

-- Payment taken in the shop (set when an admin presses "Mark collected and
-- paid"): how, how much was actually received, and a note when it is less
-- than the reserved total. reserved_total keeps the original total when the
-- amount received was lower (total_amount then holds what was received).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS amount_received NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_total NUMERIC(10,2);

-- A partial pickup splits an order: the items left behind move to a new
-- reserved order that points back at the one that was paid.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_from_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;

-- The 24-hour-before reminder of a reserved drop-in seat, sent once.
ALTER TABLE class_dropin_seats ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_reserved_until ON orders (reserved_until) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_orders_user_reserved ON orders (user_id) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_class_dropin_seats_reserved ON class_dropin_seats (class_id) WHERE status = 'reserved';
