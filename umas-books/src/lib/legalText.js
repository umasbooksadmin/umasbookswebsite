// The legal and customer-facing sentences that appear in more than one place
// (terms of sale, cart, book page, order confirmation email), written ONCE
// here in English and French. Views read them through res.locals.legalText
// (see middleware/lang.js); emails and tests require this file directly.
//
// Rules for these texts:
//  - A reservation is a free, non-binding hold; the sale is made and paid in the
//    shop in person (so no distance-selling withdrawal notice or form is shown
//    for books and seats: the lawyer is asked to confirm, docs/legal-todos.md).
//    The shop does not take back second-hand books for a change of mind once
//    bought in the shop, but the legal guarantees still apply. The text must
//    NEVER say that the legal guarantees are waived.
//  - French typography: a no-break space (U+00A0) before ; : ! ? and %.
const { translator } = require("./lang");
const legal = require("./legal"); // read at call time, so one constant drives every page

const NB = " ";

const NO_RETURNS = {
  en: "Reserving is free and commits you to nothing. You pay and the sale is made in the shop, after you have seen the book. Used books are not taken back, exchanged or refunded for a change of mind once bought in the shop; the legal guarantees still apply.",
  fr: `Réserver est gratuit et ne vous engage à rien. Vous payez et la vente est conclue en boutique, après avoir vu le livre. Les livres d’occasion ne sont ni repris, ni échangés, ni remboursés pour simple changement d’avis une fois achetés en boutique${NB}; les garanties légales restent applicables.`,
};

// The SHORT form of the same rule, for small muted lines on the reservation receipt, the
// account's reservations and the reminder / expiry emails (the full sentence above stays on the
// cart, the book page and the confirmation email). New books are not covered: it says "second-hand".
// It ends with a link to the terms of sale: pages use legalFor().noReturnsSee / noReturnsLinkLabel / noReturnsLinkPath, plain-text emails use noReturnsShortPlain().
const NO_RETURNS_SHORT = {
  en: "Second-hand books are not taken back or refunded for a change of mind. Your legal guarantees still apply.",
  fr: `Les livres d’occasion ne sont ni repris ni remboursés pour simple changement d’avis. Vos garanties légales restent applicables.`,
};
// The words around the link, as a pair per language (kept in tr() so the i18n scan sees both sides).
function noReturnsLink(lang) {
  const tr = translator(lang === "fr" ? "fr" : "en");
  return { see: tr("See our", "Voir nos"), label: tr("Terms of sale", "conditions de vente") };
}
const TERMS_PATH = "/terms-of-sale.html";

// The short notice as one plain-text sentence group with the full address of the terms of sale
// (the French page under /fr/ for a French reader). `base` is the site's origin; with none (no public
// address configured) the sentence is given without the link rather than with a relative one.
function noReturnsShortPlain(lang, base) {
  const l = lang === "fr" ? "fr" : "en";
  if (!base) return NO_RETURNS_SHORT[l];
  const url = `${String(base || "").replace(/\/$/, "")}${l === "fr" ? "/fr" : ""}${TERMS_PATH}`;
  const { see, label } = noReturnsLink(l);
  return `${NO_RETURNS_SHORT[l]} ${see} ${label}${l === "fr" ? NB : ""}: ${url}`;
}

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

// Where and when to collect and pay for a reservation of books. Getters, so the
// opening hours and the street (lib/legal.js SHOP_HOURS_*, SHOP_STREET_NUMBER)
// are read when the text is used: callers keep writing PICKUP.en / PICKUP.fr.
const PICKUP = {
  get en() {
    return `We hold your books for ${legal.RESERVATION_DAYS} days. Pay and collect them at the shop, ${legal.shopStreet("en")}, Albi. ${legal.shopHoursFirm("en")}`;
  },
  get fr() {
    return `Nous gardons vos livres ${legal.RESERVATION_DAYS} jours. Réglez-les et retirez-les à la boutique, ${legal.shopStreet("fr", false)}, Albi. ${legal.shopHoursFirm("fr")}`;
  },
};

// The same without the hold period: the cart already says "We hold your books for 14 days" in
// NOTHING_PAID_ONLINE right above it, so this line adds only where and when.
const PICKUP_WHERE = {
  get en() {
    return `Pay and collect them at the shop, ${legal.shopStreet("en")}, Albi. ${legal.shopHoursFirm("en")}`;
  },
  get fr() {
    return `Réglez-les et retirez-les à la boutique, ${legal.shopStreet("fr", false)}, Albi. ${legal.shopHoursFirm("fr")}`;
  },
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
    noReturnsShort: NO_RETURNS_SHORT[l],
    noReturnsSee: noReturnsLink(l).see,
    noReturnsLinkLabel: noReturnsLink(l).label,
    noReturnsLinkPath: (l === "fr" ? "/fr" : "") + TERMS_PATH,
    bookFriendly: BOOK_FRIENDLY[l],
    gradeNote: GRADE_NOTE[l],
    pickup: PICKUP[l],
    pickupWhere: PICKUP_WHERE[l],
    nothingPaidOnline: NOTHING_PAID_ONLINE[l],
    vatNotice: vatNotice(),
    priceLine: priceLine(l),
    shopStreet: legal.shopStreet(l),
    shopStreetInline: legal.shopStreet(l, false),
    shopPhone: legal.SHOP_PHONE_DISPLAY,
    shopPhoneTel: legal.SHOP_PHONE_TEL,
    contactEmail: legal.CONTACT_EMAIL,
    siren: legal.SIREN,
    siret: legal.SIRET,
    rna: legal.RNA,
    registeredOffice: legal.REGISTERED_OFFICE,
    registeredOfficeFormal: legal.REGISTERED_OFFICE_FORMAL,
    shopHours: legal.shopHours(l),
    shopDays: legal.shopDays(l),
    shopDaysShort: legal.shopDaysShort(l),
    shopHoursShort: legal.shopHoursShort(l, true),
    shopHoursFirm: legal.shopHoursFirm(l),
    shopOpenDays: legal.SHOP_OPEN_DAYS,
    shopOpens: legal.SHOP_OPENS,
    shopCloses: legal.SHOP_CLOSES,
    membershipPrice: legal.membershipPrice(l),
  };
}

// Fills the placeholders in a page dictionary: {vat} (VAT_NOTICE_ARTICLE),
// {shopStreet} ("Rue Peyrolière" or "12 rue Peyrolière"), {shopStreetInline}
// (the same, "rue" lowercase in the middle of a French sentence), {shopHours}
// (SHOP_HOURS_EN / SHOP_HOURS_FR), {shopDays} / {shopDaysShort} (SHOP_DAYS_*), {shopHoursShort} / {shopHoursFirm} (the two "extra openings" texts) and {membershipPrice} (MEMBERSHIP_PRICE_EUR,
// "" when not set), the identity facts {contactEmail}, {siren}, {siret}, {rna}, {registeredOffice} (plain) and
// {registeredOfficeFormal} (the legal notice's spelling), plus the reservation policy numbers {days}, {extension},
// {copies}, {reservations}, {hours} and {guestHours} (lib/legal.js). `lang` defaults to
// English: pass the dictionary's language so the shop tokens come out right.
function fillVat(dict, lang = "en") {
  const l = lang === "fr" ? "fr" : "en";
  const fills = {
    "{vat}": vatNotice(), "{days}": legal.RESERVATION_DAYS, "{extension}": legal.RESERVATION_EXTENSION_DAYS,
    "{copies}": legal.MAX_RESERVED_COPIES, "{reservations}": legal.MAX_ACTIVE_RESERVATIONS, "{hours}": legal.SEAT_CANCEL_HOURS, "{guestHours}": legal.GUEST_CONFIRM_HOURS,
    "{shopPhoneTel}": legal.SHOP_PHONE_TEL, "{shopPhone}": legal.SHOP_PHONE_DISPLAY,
    "{contactEmail}": legal.CONTACT_EMAIL, "{siren}": legal.SIREN, "{siret}": legal.SIRET, "{rna}": legal.RNA,
    "{registeredOfficeFormal}": legal.REGISTERED_OFFICE_FORMAL, "{registeredOffice}": legal.REGISTERED_OFFICE,
    "{shopStreetInline}": legal.shopStreet(l, false), "{shopStreet}": legal.shopStreet(l),
    "{shopHours}": legal.shopHours(l), "{shopDaysShort}": legal.shopDaysShort(l), "{shopDays}": legal.shopDays(l),
    "{shopHoursShort}": legal.shopHoursShort(l, true), "{shopHoursFirm}": legal.shopHoursFirm(l), "{membershipPrice}": legal.membershipPrice(l),
  };
  const out = {};
  for (const [k, v] of Object.entries(dict)) {
    out[k] = typeof v === "string" ? Object.entries(fills).reduce((t, [token, value]) => t.split(token).join(String(value)), v) : v;
  }
  return out;
}

module.exports = { NO_RETURNS, NO_RETURNS_SHORT, noReturnsShortPlain, BOOK_FRIENDLY, GRADE_NOTE, PICKUP, PICKUP_WHERE, NOTHING_PAID_ONLINE, vatNotice, priceLine, legalFor, fillVat };
