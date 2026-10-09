-- Daily cap on paid Anthropic calls (lib/aiLimits.js).
--
-- One row per (Paris day, scope): scope 'all' counts EVERY Anthropic call of the site (descriptions, translations,
-- genres, cover photos, price checks) against AI_DAILY_MAX_CALLS; scope 'price' counts the price checks against
-- PRICING_AI_DAILY_MAX. A call takes its slot with ONE atomic statement
--   INSERT ... ON CONFLICT DO UPDATE SET calls = calls + 1 WHERE calls < cap RETURNING calls
-- so concurrent requests can never exceed the cap. Counts only (no text, title, ISBN or person).
-- Old days are pruned by the daily job (pruneAiDailyCap).
--
-- Additive only (expand): nothing existing is changed.

CREATE TABLE IF NOT EXISTS ai_daily_cap (
  day   DATE    NOT NULL,
  scope TEXT    NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope)
);
