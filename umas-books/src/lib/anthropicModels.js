"use strict";
// The Anthropic models the site uses and what they cost: ONE place (pure data, no requires, so aiUsageStats.js can read
// it without a cycle). lib/anthropic.js re-exports MODELS; every AI feature names a model by its key here
// (MODELS.text, MODELS.vision, MODELS.priceLookup), never by a string of its own.
//
// To retire or change a model: edit its definition below (or point a feature key at another definition) and, if the new
// model costs something else, its usdPerMTok. The usage report's cost estimate reads the same table.
//
// Prices are an ESTIMATE ONLY. Check Anthropic's price list (https://www.anthropic.com/pricing) when you change a model.
// Last updated: 2026-10-09. Source: the Claude API model reference available when this was written
// (claude-haiku-4-5: 1.00 USD per million input tokens, 5.00 USD per million output tokens).
const PRICES_UPDATED = "2026-10-09";

const HAIKU_4_5 = { id: "claude-haiku-4-5-20251001", usdPerMTok: { input: 1.0, output: 5.0 } };

const MODELS = {
  text: HAIKU_4_5, // descriptions, French translations, genres, collection suggestions and translations
  vision: HAIKU_4_5, // reading a book from a cover or barcode photo
  priceLookup: HAIKU_4_5, // the AI price check (PRICING_AI_MODEL in the environment overrides the id; its price is then unknown)
};

module.exports = { MODELS, PRICES_UPDATED };
