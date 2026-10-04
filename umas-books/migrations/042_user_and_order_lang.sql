-- The language a member/customer chose ('en' or 'fr'), so emails sent later
-- (order confirmations, password resets...) can use it. NULL = unknown
-- (admin-created accounts, orders from before this column): treated as English.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lang TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_lang_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_lang_check CHECK (lang IN ('en', 'fr'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_lang_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_lang_check CHECK (lang IN ('en', 'fr'));
  END IF;
END $$;
