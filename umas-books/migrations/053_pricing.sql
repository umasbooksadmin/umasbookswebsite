-- Suggested prices. The shop prices a used book from what it is worth online
-- (in euros), whatever its condition: mass market -> mass_market_price; Rule A (under a_max) -> a_price, Rule B (under b_max) -> b_price,
-- Rule C (under c_max) -> c_factor of the market value; above that, or with no
-- ISBN, a person decides. The numbers live in ONE row (id = 1) so volunteers
-- can change them on /admin/pricing. Market lookups (the optional AI check)
-- are cached per ISBN so the same book is never looked up twice in a month.

CREATE TABLE IF NOT EXISTS pricing_settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  -- Standard prices a volunteer can pick by hand (clearance and custom are extra).
  levels                    JSONB NOT NULL DEFAULT '[3,5,8,10]',
  mass_market_price         NUMERIC(8,2) NOT NULL DEFAULT 5.00,   -- EUR, whatever it is worth online
  hardcover_min_price       NUMERIC(8,2) NOT NULL DEFAULT 10.00,  -- EUR: hardcovers are never suggested below this
  hardcover_min_applies_to_clearance BOOLEAN NOT NULL DEFAULT false,  -- true: clearance hardcovers are raised to the minimum too
  a_max                     NUMERIC(8,2) NOT NULL DEFAULT 6.00,   -- EUR (market value)
  a_price                   NUMERIC(8,2) NOT NULL DEFAULT 5.00,   -- EUR
  b_max                     NUMERIC(8,2) NOT NULL DEFAULT 20.00,  -- EUR (market value)
  b_price                   NUMERIC(8,2) NOT NULL DEFAULT 8.00,   -- EUR
  c_max                     NUMERIC(8,2) NOT NULL DEFAULT 50.00,  -- EUR (market value): at or above = manual review
  c_factor                  NUMERIC(4,2) NOT NULL DEFAULT 0.75,   -- share of the market value
  used_fraction             NUMERIC(4,2) NOT NULL DEFAULT 0.35,   -- used value as a share of the publisher's price
  rounding_step             NUMERIC(5,2) NOT NULL DEFAULT 0.50,
  -- Typical used value in EUR when nothing at all is known, by binding.
  fallback_hardcover        NUMERIC(8,2) NOT NULL DEFAULT 12.00,
  fallback_paperback        NUMERIC(8,2) NOT NULL DEFAULT 8.00,
  fallback_mass_market      NUMERIC(8,2) NOT NULL DEFAULT 4.00,
  fallback_unknown          NUMERIC(8,2) NOT NULL DEFAULT 8.00,
  usd_eur                   NUMERIC(7,4) NOT NULL DEFAULT 0.92,   -- 1 USD in EUR
  gbp_eur                   NUMERIC(7,4) NOT NULL DEFAULT 1.15,   -- 1 GBP in EUR
  -- Clearance: when a book already has this many copies in stock, further
  -- copies are sold at clearance_price ('extra'), or all of them are ('all').
  -- clearance_applies_to: only Rule A books ('set_a') or every rule ('all_sets').
  clearance_after_copies    INTEGER NOT NULL DEFAULT 2 CHECK (clearance_after_copies BETWEEN 1 AND 20),
  clearance_price           NUMERIC(8,2) NOT NULL DEFAULT 1.00,
  clearance_scope           TEXT NOT NULL DEFAULT 'extra' CHECK (clearance_scope IN ('extra', 'all')),
  clearance_applies_to      TEXT NOT NULL DEFAULT 'set_a' CHECK (clearance_applies_to IN ('set_a', 'all_sets')),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO pricing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- One row per ISBN-13. state: 'ok' (found something), 'empty' (searched,
-- found nothing usable) or 'failed' (the AI call failed; kept for a short
-- while so a broken service is not hammered). Rows also count toward the
-- daily cap on AI lookups (PRICING_AI_DAILY_MAX), which is why the cap
-- survives restarts.
CREATE TABLE IF NOT EXISTS price_lookups (
  isbn        TEXT PRIMARY KEY,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data        JSONB,
  state       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_price_lookups_fetched_at ON price_lookups (fetched_at);
