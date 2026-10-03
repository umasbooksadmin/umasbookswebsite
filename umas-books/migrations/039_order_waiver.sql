-- When the buyer ticked the checkout box asking for drop-in session(s) to
-- take place on the booked date (so no withdrawal once a session has taken
-- place). NULL for orders without drop-in seats and for older orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS withdrawal_waiver_at TIMESTAMPTZ;
