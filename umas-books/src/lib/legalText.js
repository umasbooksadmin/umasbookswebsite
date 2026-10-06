// The legal and customer-facing sentences that appear in more than one place
// (terms of sale, cart, book page, order confirmation email), written ONCE
// here in English and French. Views read them through res.locals.legalText
// (see middleware/lang.js); emails and tests require this file directly.
//
// Rules for these texts:
//  - The shop does not take back second-hand books for a change of mind in the
//    shop, but the legal guarantees still apply, and so does the statutory
//    right of withdrawal wherever the law provides for it (whether a
//    reservation paid in the shop is a distance contract is an open legal
//    question: docs/legal-todos.md). The text must NEVER say that those rights
//    are waived.
//  - French typography: a no-break space (U+00A0) before ; : ! ? and %.
const legal = require("./legal"); // read at call time, so one constant drives every page

const NB = " ";

const NO_RETURNS = {
  en: "Used books: no returns or exchanges for a change of mind in the shop. The legal guarantees still apply, and so does the statutory right of withdrawal where the law provides for it.",
  fr: `Livres d’occasion${NB}: pas de reprise ni d’échange pour simple changement d’avis en boutique. Les garanties légales de conformité et des vices cachés restent applicables, ainsi que le droit légal de rétractation lorsque la loi le prévoit.`,
};

// Shown on the book page next to the price, before the NO_RETURNS notice.
const BOOK_FRIENDLY = {
  en: "Our second-hand books are sold as described, so please read the condition grade, and ask us if you have any question.",
  fr: `Nos livres d’occasion sont vendus tels que décrits${NB}: lisez bien l’état indiqué, et posez-nous toutes vos questions.`,
};

// On the condition-grades legend of the book page.
const GRADE_NOTE = {
  en: "The grade is the description of the book: please read it before you buy.",
  fr: `L’état indiqué est la description du livre${NB}: merci de le lire avant d’acheter.`,
};

// Where and when to collect and pay for a reservation of books.
const PICKUP = {
  en: `We hold your books for ${legal.RESERVATION_DAYS} days. Pay and collect them at the shop, Tuesday to Saturday, 10:00–19:00, Rue Peyrolière, Albi.`,
  fr: `Nous gardons vos livres ${legal.RESERVATION_DAYS} jours. Réglez-les et retirez-les à la boutique, du mardi au samedi, 10h–19h, rue Peyrolière, Albi.`,
};

// Under the cart's "Reserve" button: nothing is paid online.
const NOTHING_PAID_ONLINE = {
  en: `Nothing is paid online. We hold your books for ${legal.RESERVATION_DAYS} days: come to the shop and pay when you collect them.`,
  fr: `Rien n’est payé en ligne. Nous gardons vos livres ${legal.RESERVATION_DAYS} jours${NB}: passez à la boutique et réglez-les au moment du retrait.`,
};

// "TVA non applicable" (+ ", art. <article> du CGI" once the accountant has
// said which article). French in both languages: it is a legal mention.
function vatNotice() {
  return legal.VAT_NOTICE_ARTICLE ? `TVA non applicable, art. ${legal.VAT_NOTICE_ARTICLE} du CGI` : "TVA non applicable";
}

// Next to the cart total and the book price.
function priceLine(lang) {
  return lang === "fr" ? `Prix TTC, ${vatNotice()}` : `Price incl. tax, ${vatNotice()}`;
}

// The strings for one language ("fr" or English), for views.
function legalFor(lang) {
  const l = lang === "fr" ? "fr" : "en";
  return {
    noReturns: NO_RETURNS[l],
    bookFriendly: BOOK_FRIENDLY[l],
    gradeNote: GRADE_NOTE[l],
    pickup: PICKUP[l],
    nothingPaidOnline: NOTHING_PAID_ONLINE[l],
    vatNotice: vatNotice(),
    priceLine: priceLine(l),
  };
}

// Fills the {vat} placeholder in a page dictionary (the terms of sale put the
// VAT line in their dictionaries as "{vat}" so it follows VAT_NOTICE_ARTICLE).
// {days}, {copies}, {reservations} and {hours} carry the reservation policy
// numbers of lib/legal.js the same way.
function fillVat(dict) {
  const out = {};
  const fills = {
    "{vat}": vatNotice(), "{days}": legal.RESERVATION_DAYS, "{extension}": legal.RESERVATION_EXTENSION_DAYS,
    "{copies}": legal.MAX_RESERVED_COPIES, "{reservations}": legal.MAX_ACTIVE_RESERVATIONS, "{hours}": legal.SEAT_CANCEL_HOURS,
  };
  for (const [k, v] of Object.entries(dict)) {
    out[k] = typeof v === "string" ? Object.entries(fills).reduce((t, [token, value]) => t.split(token).join(String(value)), v) : v;
  }
  return out;
}

module.exports = { NO_RETURNS, BOOK_FRIENDLY, GRADE_NOTE, PICKUP, NOTHING_PAID_ONLINE, vatNotice, priceLine, legalFor, fillVat };
