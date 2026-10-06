const { emailSafeName } = require("./validation");
const { formatDate, forLocale, LOCALES } = require("./dates");
const { emailTr, normLang } = require("./lang");
const { formatEuro } = require("./money");
const { orderItemLabel } = require("./orderItems");
const { NO_RETURNS, PICKUP, vatNotice } = require("./legalText");

// The shop you pick up at (Rue Peyrolière) is NOT the association's
// registered office (siège, 5 rue Hippolyte Savary): customers get the shop
// address for collection and the siège only in the legal identity block.
// The shop's identity block for order emails (French consumer-law
// mentions: who sells, and that VAT does not apply; the VAT line follows
// VAT_NOTICE_ARTICLE in lib/legal.js).
const sellerLines = () =>
  `Uma's Books — association loi 1901, RNA W811011706, SIRET 109 441 147 00013, 5 rue Hippolyte Savary, 81000 Albi\nTél. / Phone : 06 98 95 67 91 — admin@umasbooks.org\n${vatNotice()}`;
const SELLER_LINES = sellerLines();

// Consumer Code art. L.221-13: the confirmation must carry the withdrawal
// information and the model withdrawal form ON A DURABLE MEDIUM, a link to
// the website does not count. So the essentials of the terms of sale are in
// the email itself (the full terms stay at /terms-of-sale.html).
const LEGAL_RIGHTS = [
  "YOUR RIGHTS",
  NO_RETURNS.en,
  "Right of withdrawal (books, online orders): you may withdraw from a book purchase without giving a reason within 14 days of collecting it (Consumer Code, art. L.221-18). Tell us by email to admin@umasbooks.org (you can use the form below), then return the book to the shop without delay and within 14 days of your notice, at your own cost (none if you bring it in person). We refund the full price, by the same means of payment, within 14 days of your notice; we may withhold the refund until we have the book back or you show proof that you returned it. Drop-in sessions are leisure activities on a specific date: no right of withdrawal (art. L.221-28, 12°); if we cancel a session we refund you in full.",
  "Legal guarantees: you keep the legal guarantee of conformity (art. L.217-3 et seq. of the Consumer Code) and the guarantee against hidden defects (arts. 1641 et seq. of the Civil Code). We give no commercial guarantee beyond these.",
  "Complaints: write to admin@umasbooks.org. If we cannot settle it, you may use our free consumer mediator: CM2C, 49 rue de Ponthieu, 75008 Paris, https://www.cm2c.net/declarer-un-litige.php",
  "",
  "VOS DROITS",
  NO_RETURNS.fr,
  "Droit de rétractation (livres, achats en ligne) : vous pouvez vous rétracter d’un achat de livre sans donner de motif dans un délai de 14 jours après l’avoir retiré (Code de la consommation, art. L.221-18). Informez-nous par e-mail à admin@umasbooks.org (vous pouvez utiliser le formulaire ci-dessous), puis rapportez le livre à la boutique sans retard excessif et au plus tard 14 jours après votre notification, à vos frais (aucun si vous le rapportez en personne). Nous vous remboursons l’intégralité du prix, par le même moyen de paiement, dans les 14 jours suivant votre notification ; nous pouvons différer le remboursement jusqu’à la récupération du livre ou jusqu’à ce que vous ayez fourni une preuve de son renvoi. Les séances « drop-in » sont des activités de loisirs à date déterminée : pas de droit de rétractation (art. L.221-28, 12°) ; si nous annulons une séance, nous vous remboursons intégralement.",
  "Garanties légales : vous conservez la garantie légale de conformité (art. L.217-3 et suivants du Code de la consommation) et la garantie contre les vices cachés (art. 1641 et suivants du Code civil). Nous n’offrons aucune garantie commerciale en plus de celles-ci.",
  "Réclamations : écrivez à admin@umasbooks.org. À défaut de règlement amiable, vous pouvez recourir gratuitement à notre médiateur de la consommation : CM2C, 49 rue de Ponthieu, 75008 Paris, https://www.cm2c.net/declarer-un-litige.php",
].join("\n\n").replace(/\n\n\n\n/g, "\n\n");

const WITHDRAWAL_FORM = [
  "WITHDRAWAL FORM / FORMULAIRE DE RÉTRACTATION",
  "(Complete and send by email only if you wish to withdraw from the contract / à renvoyer par e-mail uniquement si vous souhaitez vous rétracter)",
  "To / À l’attention de : Uma’s Books, 5 rue Hippolyte Savary, 81000 Albi, admin@umasbooks.org",
  "I hereby give notice that I withdraw from my contract for the sale of the following book(s) / Je vous notifie par la présente ma rétractation du contrat portant sur la vente du ou des livre(s) suivant(s) : ________",
  "Ordered on / collected on — Commandé le / retiré le : ________",
  "Name / Nom : ________   Address / Adresse : ________   Date : ________",
].join("\n");

// Subject of the order confirmation, in the order's language (English when unknown).
function orderConfirmationSubject(lang) {
  return emailTr(lang)("Your order at Uma's Books is confirmed", "Votre commande chez Uma's Books est confirmée");
}

// Plain-text body of the order confirmation. Pure (no I/O) so it can be tested.
// Written in the order's language (order.lang; English when missing). The
// legal blocks (rights, withdrawal form, seller identity) are bilingual FR/EN
// in every language: that is what the Consumer Code notice requires on the
// durable medium, so they are never reduced to one language.
function buildOrderConfirmationText(order, items, base) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const root = base ? base.replace(/\/$/, "") : "";
  const termsLine = base
    ? tr(
        `Terms of sale and your 14-day right of withdrawal for books: ${root}/terms-of-sale.html\n\n`,
        `Conditions de vente et votre droit de rétractation de 14 jours pour les livres : ${root}/terms-of-sale.html\n\n`
      )
    : "";
  // Proof of acceptance of the terms of sale, as stored at checkout (absent on
  // orders placed before it was recorded).
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
  const head = tr(
    `Hi ${name},\n\nThanks for your order — payment received:\n\nOrder #${order.id} — ${orderDate}\nPaid online via HelloAsso\n\n${lines}\n\nTotal: ${total}\n\n${PICKUP.en} Drop-in sessions need no pickup — just come along at the session time.\n\n`,
    `Bonjour ${name},\n\nMerci pour votre commande — paiement reçu :\n\nCommande n° ${order.id} — ${orderDate}\nPayée en ligne via HelloAsso\n\n${lines}\n\nTotal : ${total}\n\n${PICKUP.fr} Les séances drop-in ne nécessitent aucun retrait : il vous suffit de venir à l’heure de la séance.\n\n`
  );
  return `${head}${termsLine}${cgvLine}${LEGAL_RIGHTS}\n\n${WITHDRAWAL_FORM}\n\n${sellerLines()}`;
}

module.exports = { buildOrderConfirmationText, orderConfirmationSubject, SELLER_LINES, LEGAL_RIGHTS, WITHDRAWAL_FORM };
