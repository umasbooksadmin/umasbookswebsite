-- Guest reservations (approved 2026-10-28): a signed-out visitor can reserve with a
-- name, an email and an optional phone, without an account (src/lib/guestOrders.js).
--
-- orders.is_guest: the reservation was made without an account. It stays TRUE when the
-- order is later attached to an account (orders.user_id is then set, only once that
-- account has CONFIRMED the same email, see attachGuestOrders), so the admin pages can
-- still say how it was made.
-- orders.guest_confirmed_at: when the guest opened the link in the confirmation email.
-- Until then the hold lasts 2 hours (orders.reserved_until) and is released by the
-- usual reservation expiry (lib/reservations.js expireOrderReservations).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_confirmed_at TIMESTAMPTZ;

-- The guest's links. Only the SHA-256 of a random 32-byte token is stored, never the
-- token. One purpose per token: 'confirm' (single use, expires with the 2-hour hold)
-- or 'manage' (view and cancel the reservation without an account; expires).
CREATE TABLE IF NOT EXISTS guest_order_tokens (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('confirm', 'manage')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guest_order_tokens_order ON guest_order_tokens(order_id);

-- The per-email limits (at most MAX_RESERVED_COPIES books and MAX_ACTIVE_RESERVATIONS
-- open reservations held at once for one guest address) read this.
CREATE INDEX IF NOT EXISTS idx_orders_guest_email_open ON orders (lower(buyer_email)) WHERE is_guest AND status = 'reserved';
