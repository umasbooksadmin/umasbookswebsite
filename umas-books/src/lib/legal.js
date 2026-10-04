// Version of the terms of sale (views/marketing/terms-of-sale.ejs) that a
// buyer accepts at checkout. It is stored on every order
// (orders.cgv_version, with orders.cgv_accepted_at) as proof of acceptance.
// Bump it (to the date of the change, YYYY-MM-DD) whenever the terms of sale
// text changes in a way that matters to buyers.
const TERMS_OF_SALE_VERSION = "2026-10-04";

module.exports = { TERMS_OF_SALE_VERSION };
