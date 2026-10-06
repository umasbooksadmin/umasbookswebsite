// Version of the terms of sale (views/marketing/terms-of-sale.ejs) that a
// buyer accepts at checkout. It is stored on every order
// (orders.cgv_version, with orders.cgv_accepted_at) as proof of acceptance.
// Bump it (to the date of the change, YYYY-MM-DD) whenever the terms of sale
// text changes in a way that matters to buyers.
const TERMS_OF_SALE_VERSION = "2026-10-06";

// The article of the Code général des impôts (CGI) that exempts the
// association from VAT, shown after "TVA non applicable" when it is set,
// e.g. "261-7-1°" or "293 B" (WITHOUT "art." and WITHOUT "du CGI").
// Left EMPTY on purpose until the association's accountant says which one
// applies: while it is empty the line reads just "TVA non applicable".
// See docs/runbook.md ("The VAT line").
const VAT_NOTICE_ARTICLE = "";

// Social network pages shown as icons in the site footer. Leave a value
// empty until the real page exists: an empty one is not shown at all.
const SOCIAL_LINKS = { instagram: "", facebook: "" };

module.exports = { TERMS_OF_SALE_VERSION, VAT_NOTICE_ARTICLE, SOCIAL_LINKS };
