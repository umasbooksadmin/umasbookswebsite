// The legal and customer-facing sentences that appear in more than one place
// (terms of sale, cart, book page, order confirmation email), written ONCE
// here in English and French. Views read them through res.locals.legalText
// (see middleware/lang.js); emails and tests require this file directly.
//
// Rules for these texts:
//  - The shop does not take back second-hand books for a change of mind in the
//    shop, but the law still gives online buyers a 14-day right of withdrawal
//    (Consumer Code art. L.221-18) and the legal guarantees. The text must
//    NEVER say that those rights are waived.
//  - French typography: a no-break space (U+00A0) before ; : ! ? and %.
const legal = require("./legal"); // read at call time, so one constant drives every page

const NB = " ";

const NO_RETURNS = {
  en: "Used books: no returns or exchanges for a change of mind in the shop. For online orders, your statutory 14-day right of withdrawal and the legal guarantees still apply.",
  fr: `Livres d’occasion${NB}: pas de reprise ni d’échange pour simple changement d’avis en boutique. Pour les achats en ligne, votre droit légal de rétractation de 14 jours (art. L.221-18) et les garanties légales de conformité et des vices cachés restent applicables.`,
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

// Where and when to collect an order of books. Getters, so the opening hours
// and the street (lib/legal.js SHOP_HOURS_*, SHOP_STREET_NUMBER) are read when
// the text is used: callers keep writing PICKUP.en / PICKUP.fr.
const PICKUP = {
  get en() {
    return `Pick up within 14 days, Tuesday to Saturday, ${legal.shopHours("en")}, ${legal.shopStreet("en")}, Albi.`;
  },
  get fr() {
    return `À retirer sous 14 jours, du mardi au samedi, ${legal.shopHours("fr")}, ${legal.shopStreet("fr", false)}, Albi.`;
  },
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
    vatNotice: vatNotice(),
    priceLine: priceLine(l),
    shopStreet: legal.shopStreet(l),
    shopStreetInline: legal.shopStreet(l, false),
    shopHours: legal.shopHours(l),
    shopOpens: legal.SHOP_OPENS,
    shopCloses: legal.SHOP_CLOSES,
    membershipPrice: legal.membershipPrice(l),
  };
}

// Fills the placeholders in a page dictionary: {vat} (VAT_NOTICE_ARTICLE),
// {shopStreet} ("Rue Peyrolière" or "12 rue Peyrolière"), {shopStreetInline}
// (the same, "rue" lowercase in the middle of a French sentence), {shopHours}
// (SHOP_HOURS_EN / SHOP_HOURS_FR) and {membershipPrice} (MEMBERSHIP_PRICE_EUR,
// "" when not set). Terms of sale, legal notice, visit and membership put them
// in their dictionaries so one constant in lib/legal.js drives every page.
// `lang` defaults to English: pass the dictionary's language for the last four.
function fillVat(dict, lang = "en") {
  const l = lang === "fr" ? "fr" : "en";
  const fills = {
    "{vat}": vatNotice(),
    "{shopStreetInline}": legal.shopStreet(l, false),
    "{shopStreet}": legal.shopStreet(l),
    "{shopHours}": legal.shopHours(l),
    "{membershipPrice}": legal.membershipPrice(l),
  };
  const out = {};
  for (const [k, v] of Object.entries(dict)) {
    let t = v;
    if (typeof t === "string") for (const [token, text] of Object.entries(fills)) t = t.split(token).join(text);
    out[k] = t;
  }
  return out;
}

module.exports = { NO_RETURNS, BOOK_FRIENDLY, GRADE_NOTE, PICKUP, vatNotice, priceLine, legalFor, fillVat };
