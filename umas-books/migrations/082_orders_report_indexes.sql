-- The Accounts report (lib/reports.js accountsReport) counts each account's paid
-- orders. It used to match orders to accounts with a per-user EXISTS(...
-- lower(o.buyer_email) = lower(u.email)) that scanned all orders once per
-- account (10 s for 5,000 accounts, headed for the 30 s statement timeout at
-- about 10,000). It now joins on orders.user_id (index idx_orders_user, 058) and
-- uses the buyer email ONLY for older orders that have no user_id, through
-- these two indexes. Additive only (expand).
CREATE INDEX IF NOT EXISTS idx_orders_legacy_buyer_email ON orders (lower(buyer_email)) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (lower(email));
