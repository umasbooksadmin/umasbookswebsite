-- Proof that the buyer accepted the terms of sale (CGV) at checkout: when,
-- and which version (src/lib/legal.js TERMS_OF_SALE_VERSION). NULL for
-- orders placed before this column existed. Not personal data by itself, so
-- it stays on anonymised orders (kept with the order for accounting).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cgv_accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cgv_version TEXT;
