-- Buying now requires an account. orders.user_id links an order to the
-- account that placed it (NULL for orders placed before this change, and
-- after the account is erased: the order itself is kept for accounting, its
-- buyer_* columns are anonymised by src/lib/privacy.js).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- A person who is sent to sign up from the cart must come back to the cart
-- after confirming their email and choosing a password, possibly in another
-- browser. The (validated, local-path-only) destination travels inside the
-- single-use tokens, never as a trusted URL parameter on the later steps.
ALTER TABLE email_verification_tokens ADD COLUMN IF NOT EXISTS return_to TEXT;
ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS return_to TEXT;
