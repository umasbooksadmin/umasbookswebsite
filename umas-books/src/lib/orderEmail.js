const { emailSafeName } = require("./validation");
const { formatDate, forLocale, LOCALES } = require("./dates");
const { emailTr, normLang } = require("./lang");
const { formatEuro } = require("./money");
const { orderItemLabel, reservationLastDay } = require("./orderItems");
const legal = require("./legal");
const { NO_RETURNS, vatNotice } = require("./legalText");
const { frenchPlainText } = require("./frenchTypography");

// The shop you pick up at (Rue Peyrolière) is NOT the association's
// registered office (siège, 5 rue Hippolyte Savary): customers get the shop
// address for collection and the siège only in the legal identity block.
// The shop's identity block for order emails (French consumer-law
// mentions: who sells, and that VAT does not apply; the VAT line follows
// VAT_NOTICE_ARTICLE in lib/legal.js).
// In French the block is French only (the English email keeps the bilingual
// block: the legal text is French, an English reader gets both).
const sellerLines = (lang = "en") =>
  `Uma's Books — association loi 1901, RNA W811011706, SIRET 109 441 147 00013, 5 rue Hippolyte Savary, 81000 Albi\n${lang === "fr" ? "Tél." : "Tél. / Phone"} : 06 98 95 67 91 — admin@umasbooks.org\n${vatNotice()}`;
const SELLER_LINES = sellerLines();

// A reservation is a free, non-binding hold: the sale is made and paid in the shop
// in person, so the email carries NO distance-selling withdrawal notice and NO
// model withdrawal form (a legal review asked for this; the lawyer is asked to
// confirm, docs/legal-todos.md). What stays: the no-returns notice, the legal
// guarantees, the mediator and the seller identity. The full terms of sale stay
// at /terms-of-sale.html.
const LEGAL_RIGHTS_EN = [
  "YOUR RIGHTS",
  NO_RETURNS.en,
  "Legal guarantees: you keep the legal guarantee of conformity (art. L.217-3 et seq. of the Consumer Code) and the guarantee against hidden defects (arts. 1641 et seq. of the Civil Code). We give no commercial guarantee beyond these.",
  "Complaints: write to admin@umasbooks.org. If we cannot settle it, you may use our free consumer mediator: CM2C, 49 rue de Ponthieu, 75008 Paris, https://www.cm2c.net/declarer-un-litige.php",
];
const LEGAL_RIGHTS_FR = [
  "VOS DROITS",
  NO_RETURNS.fr,
  "Garanties légales : vous conservez la garantie légale de conformité (art. L.217-3 et suivants du Code de la consommation) et la garantie contre les vices cachés (art. 1641 et suivants du Code civil). Nous n’offrons aucune garantie commerciale en plus de celles-ci.",
  "Réclamations : écrivez à admin@umasbooks.org. À défaut de règlement amiable, vous pouvez recourir gratuitement à notre médiateur de la consommation : CM2C, 49 rue de Ponthieu, 75008 Paris, https://www.cm2c.net/declarer-un-litige.php",
];
// English email: the English block, then the French one (as before). French email: French only.
const LEGAL_RIGHTS = [...LEGAL_RIGHTS_EN, "", ...LEGAL_RIGHTS_FR].join("\n\n").replace(/\n\n\n\n/g, "\n\n");
const LEGAL_RIGHTS_FRENCH_ONLY = LEGAL_RIGHTS_FR.join("\n\n");

// Getters: the street number and the hours come from lib/legal.js when used.
const SHOP_LINES = {
  get en() { return `Uma's Books, ${legal.shopStreet("en")}, 81000 Albi. ${legal.shopHoursFirm("en")}`; },
  get fr() { return `Uma's Books, ${legal.shopStreet("fr", false)}, 81000 Albi. ${legal.shopHoursFirm("fr")}`; },
};

// Subject of the reservation e-mail (a reservation, not an order confirmation or proof of purchase), in the order's language (English when unknown).
function orderConfirmationSubject(lang) {
  return emailTr(lang)("Your reservation at Uma's Books", "Votre réservation chez Uma's Books");
}

const hasBooks = (items) => items.some((i) => i.class_dropin_seat_id == null);
const hasSeats = (items) => items.some((i) => i.class_dropin_seat_id != null);

// Plain-text body of the reservation confirmation. Pure (no I/O) so it can be
// tested. Written in the order's language (order.lang; English when missing).
// The legal blocks (rights, seller identity) are bilingual FR/EN in every
// language, so they are never reduced to one language.
function buildOrderConfirmationText(order, items, base) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const fmt = forLocale(LOCALES[lang]);
  const root = base ? base.replace(/\/$/, "") : "";
  const accountUrl = root ? `${root}/account` : "/account";
  const books = hasBooks(items);
  const seats = hasSeats(items);
  const termsLine = base
    ? tr(`Terms of sale: ${root}/terms-of-sale.html\n\n`, `Conditions de vente : ${root}/terms-of-sale.html\n\n`)
    : "";
  // Proof of acceptance of the terms of sale, as stored when the reservation was made.
  const cgvLine = order.cgv_accepted_at
    ? tr(
        `Terms of sale accepted on ${forLocale(LOCALES.en).formatDateLong(order.cgv_accepted_at)} (version ${order.cgv_version}).\n\n`,
        `Conditions générales de vente acceptées le ${forLocale(LOCALES.fr).formatDateLong(order.cgv_accepted_at)} (version ${order.cgv_version}).\n\n`
      )
    : "";
  const lines = items.map((i) => `- ${orderItemLabel(i, order.lang)} — ${formatEuro(i.price, lang)}`).join("\n");
  const orderDate = formatDate(order.created_at || new Date());
  const name = emailSafeName(order.buyer_name);
  const total = formatEuro(order.total_amount, lang);
  const last = reservationLastDay(order);
  const deadline = books && last
    ? tr(
        `We hold your books until the end of ${fmt.formatDateLong(last)} (Paris time). After that they go back on sale.\n`,
        `Nous gardons vos livres jusqu’à la fin de la journée du ${fmt.formatDateLong(last)} (heure de Paris). Passé ce délai, ils sont remis en vente.\n`
      )
    : "";
  const seatNote = seats
    ? tr(
        `Drop-in seats: you pay at the session. A seat can be cancelled online until ${legal.SEAT_CANCEL_HOURS} hours before the session; we release it once the session has passed.\n`,
        `Places « drop-in » : vous réglez sur place, à la séance. Une place peut être annulée en ligne jusqu’à ${legal.SEAT_CANCEL_HOURS} heures avant la séance ; nous la libérons une fois la séance passée.\n`
      )
    : "";
  const head = tr(
    `Hi ${name},\n\nThanks for your reservation. Nothing has been paid online: you pay at the shop when you collect.\n\nReservation #${order.id} — ${orderDate}\n\n${lines}\n\nTotal to pay at the shop: ${total}\n\nPAY AT THE SHOP WHEN YOU COLLECT\n${deadline}${seatNote}${SHOP_LINES.en} Please quote reservation #${order.id}. You pay in cash or by card, after checking the book: you are free to decline it.\n\nTO CANCEL\nLog in and open your account page, then press “Cancel reservation”: ${accountUrl}\n\n`,
    `Bonjour ${name},\n\nMerci pour votre réservation. Rien n’a été payé en ligne : vous réglez à la boutique au moment du retrait.\n\nRéservation n° ${order.id} — ${orderDate}\n\n${lines}\n\nTotal à régler à la boutique : ${total}\n\nÀ RÉGLER À LA BOUTIQUE AU RETRAIT\n${deadline}${seatNote}${SHOP_LINES.fr} Merci d’indiquer la réservation n° ${order.id}. Vous payez en espèces ou par carte, après avoir vérifié le livre : vous êtes libre de le refuser.\n\nPOUR ANNULER\nConnectez-vous, ouvrez votre page de compte puis appuyez sur « Annuler la réservation » : ${accountUrl}\n\n`
  );
  const text = `${head}${termsLine}${cgvLine}${lang === "fr" ? LEGAL_RIGHTS_FRENCH_ONLY : LEGAL_RIGHTS}\n\n${sellerLines(lang)}`;
  // The fixed legal blocks are not written through tr(): give the French mail the same no-break spaces.
  return lang === "fr" ? frenchPlainText(text) : text;
}

// Day-10 reminder (RESERVATION_REMINDER_DAYS_BEFORE days before the deadline).
function buildReservationReminder(order, items) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const fmt = forLocale(LOCALES[lang]);
  const name = emailSafeName(order.buyer_name);
  const lines = items.filter((i) => i.class_dropin_seat_id == null).map((i) => `- ${orderItemLabel(i, lang)}`).join("\n");
  const last = fmt.formatDateLong(reservationLastDay(order));
  return {
    subject: tr(`Your reserved books are waiting at the shop (reservation #${order.id})`, `Vos livres réservés vous attendent à la boutique (réservation n° ${order.id})`),
    text: tr(
      `Hi ${name},\n\nYour reservation #${order.id} is waiting for you at Uma's Books:\n\n${lines}\n\nWe hold it until the end of ${last} (Paris time). Come by to pay and collect: ${SHOP_LINES.en}\n\nIf you no longer want the books, you can cancel from your account page. If you need more time, write to us at admin@umasbooks.org.\n\nUma's Books`,
      `Bonjour ${name},\n\nVotre réservation n° ${order.id} vous attend à Uma's Books :\n\n${lines}\n\nNous la gardons jusqu’à la fin de la journée du ${last} (heure de Paris). Passez la régler et la retirer : ${SHOP_LINES.fr}\n\nSi vous ne souhaitez plus ces livres, vous pouvez annuler depuis votre page de compte. Si vous avez besoin de plus de temps, écrivez-nous à admin@umasbooks.org.\n\nUma's Books`
    ),
  };
}

// Sent once when a reservation was released because its deadline passed (or its
// session did): no penalty, the items are simply back on sale.
function buildReservationExpiredNotice(order, items) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const name = emailSafeName(order.buyer_name);
  const lines = items.map((i) => `- ${orderItemLabel(i, lang)}`).join("\n");
  return {
    subject: tr(`Your reservation #${order.id} has ended`, `Votre réservation n° ${order.id} est terminée`),
    text: tr(
      `Hi ${name},\n\nYour reservation #${order.id} was not collected in time, so we have put the items back on sale:\n\n${lines}\n\nThere is nothing to pay and no penalty. If you still want them and they are available, you can reserve them again on our website.\n\nUma's Books`,
      `Bonjour ${name},\n\nVotre réservation n° ${order.id} n’a pas été retirée à temps ; nous avons donc remis les articles en vente :\n\n${lines}\n\nIl n’y a rien à payer et aucune pénalité. Si vous les souhaitez encore et qu’ils sont disponibles, vous pouvez les réserver de nouveau sur notre site.\n\nUma's Books`
    ),
  };
}

// Sent once, SEAT_REMINDER_HOURS before a reserved drop-in session.
function buildSeatReminder(order, seatItem) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const name = emailSafeName(order.buyer_name);
  const label = orderItemLabel(seatItem, lang);
  return {
    subject: tr(`Reminder: your drop-in seat tomorrow (reservation #${order.id})`, `Rappel : votre place « drop-in » demain (réservation n° ${order.id})`),
    text: tr(
      `Hi ${name},\n\nA reminder of your reserved drop-in seat: ${label}.\n\nYou pay at the session. If you can no longer come, please cancel from your account page, or write to admin@umasbooks.org, so someone else can have the seat.\n\nUma's Books`,
      `Bonjour ${name},\n\nPetit rappel pour votre place « drop-in » réservée : ${label}.\n\nVous réglez sur place, à la séance. Si vous ne pouvez plus venir, merci d’annuler depuis votre page de compte, ou d’écrire à admin@umasbooks.org, afin qu’une autre personne puisse en profiter.\n\nUma's Books`
    ),
  };
}

module.exports = {
  buildOrderConfirmationText, orderConfirmationSubject, buildReservationReminder, buildReservationExpiredNotice, buildSeatReminder,
  SELLER_LINES, LEGAL_RIGHTS, LEGAL_RIGHTS_FRENCH_ONLY, SHOP_LINES, sellerLines,
};
