// Version of the terms of sale (views/marketing/terms-of-sale.ejs) that a
// customer accepts when reserving. It is stored on every order
// (orders.cgv_version, with orders.cgv_accepted_at) as proof of acceptance.
// Bump it (to the date of the change, YYYY-MM-DD) whenever the terms of sale
// text changes in a way that matters to buyers.
const TERMS_OF_SALE_VERSION = "2026-10-07";

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

module.exports = {
  TERMS_OF_SALE_VERSION, VAT_NOTICE_ARTICLE, SOCIAL_LINKS,
  RESERVATION_DAYS, RESERVATION_EXTENSION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS,
  SEAT_CANCEL_HOURS, SEAT_REMINDER_HOURS, RESERVATION_REMINDER_DAYS_BEFORE, SEAT_FALLBACK_SESSION_HOURS,
};
