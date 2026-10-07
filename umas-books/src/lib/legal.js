const { formatEuro } = require("./money");

// The association's registered name and the name it trades under (the shop's public name).
const BRAND_LEGAL_NAME = "UMAS BOOKS";
const BRAND_SHORT_NAME = "Uma's Books";

// Version of the terms of sale (views/marketing/terms-of-sale.ejs) that a
// customer accepts when reserving. It is stored on every order
// (orders.cgv_version, with orders.cgv_accepted_at) as proof of acceptance.
// Bump it (to the date of the change, YYYY-MM-DD) whenever the terms of sale
// text changes in a way that matters to buyers.
const TERMS_OF_SALE_VERSION = "2026-10-08";

// Reservation policy ("Reserve online, pay at the shop"): nothing is paid
// online for books and drop-in seats. These numbers are the single source for
// the code AND the customer-facing texts (cart, emails, terms of sale).
//  - RESERVATION_DAYS: how long books are held; the deadline is shown to the
//    customer in the confirmation email. An admin can extend it once.
//  - MAX_RESERVED_COPIES / MAX_ACTIVE_RESERVATIONS: per account, at once.
//  - SEAT_CANCEL_HOURS: a drop-in seat can be cancelled online until this many
//    hours before the session starts.
//  - SEAT_REMINDER_HOURS: the reminder email goes out this long before a session.
//  - RESERVATION_REMINDER_DAYS_BEFORE: the book reminder goes out this many
//    days before the deadline (day 10 of 14).
const RESERVATION_DAYS = 14;
const RESERVATION_EXTENSION_DAYS = 7;
const MAX_RESERVED_COPIES = 10;
const MAX_ACTIVE_RESERVATIONS = 3;
const SEAT_CANCEL_HOURS = 24;
const SEAT_REMINDER_HOURS = 24;
const RESERVATION_REMINDER_DAYS_BEFORE = 4;
// A drop-in seat is held until the class ends (classes.ends_at); when a class
// has no end time, this many hours after it starts.
const SEAT_FALLBACK_SESSION_HOURS = 3;

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

// ---------------------------------------------------------------------------
// Facts shown on several legal pages and emails: ONE place to change each.
// Every helper below reads the constant when it is called (not when the file
// loads), so a test can change one and see every page follow.
// ---------------------------------------------------------------------------

// Membership price in euros as a number or a string ("20", "20.00"), shown on
// the Membership page before the HelloAsso form loads. EMPTY on purpose until
// the association confirms the price on its HelloAsso campaign: while it is
// empty the page shows no price (it keeps the text that says the amount is on
// the HelloAsso form). It must equal the price set on HelloAsso. See
// docs/legal-todos.md ("set the membership price constant").
const MEMBERSHIP_PRICE_EUR = "";

// Street number of the shop (rue Peyrolière, Albi). EMPTY until the
// association gives it: the shop address then reads "Rue Peyrolière" as before;
// once set it reads "12 rue Peyrolière" everywhere (legal notice, emails, visit
// page, structured data). See docs/legal-todos.md ("give the street number").
const SHOP_STREET_NUMBER = "";

// Opening days and hours of the shop. Machine format for structured data, then
// the text printed on pages: English 10:00–19:00, French 10 h–19 h (a no-break
// space between the number and "h").
const SHOP_OPENS = "10:00";
const SHOP_CLOSES = "19:00";
const SHOP_HOURS_EN = "10:00–19:00";
const SHOP_HOURS_FR = "10\u00a0h–19\u00a0h";

// "Rue Peyrolière" or "12 rue Peyrolière". `capital` is for the start of a
// sentence, a line or a field ("Rue Peyrolière, 81000 Albi"); inside a French
// sentence leave it off to get "rue Peyrolière". With a number it is always
// "12 rue Peyrolière" (the number comes first, so the word stays lowercase).
function shopStreet(lang, capital = true) {
  const n = String(module.exports.SHOP_STREET_NUMBER).trim();
  if (n) return `${n} rue Peyrolière`;
  return capital || lang !== "fr" ? "Rue Peyrolière" : "rue Peyrolière";
}

function shopHours(lang) {
  return lang === "fr" ? module.exports.SHOP_HOURS_FR : module.exports.SHOP_HOURS_EN;
}

// The membership price as text for a language ("20,00 €" / "€20.00"), or "".
function membershipPrice(lang) {
  const raw = module.exports.MEMBERSHIP_PRICE_EUR;
  if (raw === "" || raw === null || raw === undefined) return "";
  return formatEuro(raw, lang === "fr" ? "fr" : "en");
}

module.exports = {
  BRAND_LEGAL_NAME, BRAND_SHORT_NAME, TERMS_OF_SALE_VERSION, VAT_NOTICE_ARTICLE, SOCIAL_LINKS,
  RESERVATION_DAYS, RESERVATION_EXTENSION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS,
  SEAT_CANCEL_HOURS, SEAT_REMINDER_HOURS, RESERVATION_REMINDER_DAYS_BEFORE, SEAT_FALLBACK_SESSION_HOURS,
  MEMBERSHIP_PRICE_EUR, SHOP_STREET_NUMBER,
  SHOP_OPENS, SHOP_CLOSES, SHOP_HOURS_EN, SHOP_HOURS_FR,
  shopStreet, shopHours, membershipPrice,
};
