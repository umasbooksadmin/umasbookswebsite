# Legal to-do list for the association

Open legal questions from the legal reviews (October 2026). The website shows
the neutral or interim wording named in each item until it is answered. None of
this is legal advice: it is the list to take to the accountant or the lawyer.

How to use it: tick the box when the item is done and write the date. **Owner**
says who has to decide or do it: *maintainer* (Sharon), *accountant* or
*lawyer*. **Recommendation** is what the review suggests; the owner decides.

## Items for the maintainer

- [ ] **1. Give the shop street number** (owner: maintainer). The shop address
  on the website has no street number ("Rue Peyrolière, 81000 Albi").
  Recommendation: find the number, then set `SHOP_STREET_NUMBER` in
  `umas-books/src/lib/legal.js` (for example `"12"`). It then reads "12 rue
  Peyrolière" everywhere the shop address appears: legal notice, visit page,
  structured data, terms of sale (section 4), cart confirmation page, the order
  and reservation emails, the pickup reminder and the book-request emails. They
  all use `shopStreet(lang, capital)` in `legal.js` (or the `{shopStreet}` and
  `{shopStreetInline}` tokens filled by `fillVat(dict, lang)` in `legalText.js`),
  with "rue" in lower case in the middle of a French sentence. Do not write the
  street by hand in a new text: use the helper.
- [ ] **2. Set the membership price constant** (owner: maintainer). Set
  `MEMBERSHIP_PRICE_EUR` in `umas-books/src/lib/legal.js` (a number or a string,
  for example `"20"`) to the price configured on the HelloAsso membership form.
  It is then shown on the Membership page before the HelloAsso form loads. While
  it is empty the page keeps its earlier text. The price must always equal the
  one on HelloAsso (the membership terms say the amount is the one shown on the
  HelloAsso form). Check again each time the HelloAsso price changes.
- [x] **3. Registered name** (done, 2026-10-06). The official registered name is
  "UMAS BOOKS" (the register cannot take apostrophes). It is used only in the
  legal identity lines (legal notice, privacy policy, membership terms, via
  `BRAND_LEGAL_NAME` in `legal.js`); the public names "Uma's Books" and "Uma's
  Books and Adventures" stay as they are everywhere else.
- [ ] **4. Immersion program terms** (owner: maintainer, to write). The immersion
  pages give the price (15 EUR per session, billed monthly) and nothing else.
  TODO(the association): decide and write (a) cancellation by the family: 24 to
  48 hours' notice, (b) absences (no refund, or a make-up session), (c) the
  monthly billing date, (d) refund when the association cancels a session. Then
  add a short "Immersion program" section to the terms of sale (EN and FR) and
  **bump `TERMS_OF_SALE_VERSION` before bookings open**.
- [ ] **5. Photos and videos** (owner: maintainer). The policy says only that
  photos are taken with consent (the legal basis). TODO(the association): decide,
  then write in the policy and in `docs/privacy/record-of-processing.md`: the
  purpose of photos, where they are stored, whether any are published (where) and
  how long they are kept. Recommendation: a one-page consent form (signed by a
  parent or guardian for a child) saying what the photo is used for and where it
  is published, and a rule to delete photos after a fixed period. Nothing has
  been invented on the website for these points.
- [ ] **6. Remove the "Chapter Four" kicker** on the visit page (owner:
  maintainer; `views/marketing/visit.ejs`, key `visit.kicker`). Recommendation:
  replace it by a real label ("Visit" / "Venir nous voir") or remove it.
- [ ] **7. Statutes PDF ready to send** (owner: maintainer). The membership terms
  say the statutes are "available on request". Recommendation: keep an up to date
  PDF in the shared drive so any request is answered the same day.
- [x] **8a. CM2C adhesion** is signed and in place (confirmed by the maintainer, 2026-10-06).
- [ ] **8b. Mediator address** (owner: maintainer). Verify CM2C's postal address
  against the official list of the CECMC (Commission d'évaluation et de contrôle
  de la médiation de la consommation) and correct the terms if they differ.
- [ ] **9. Refreshments** (owner: maintainer). If drinks or food are served:
  recommendation: declare it to the mairie and the DDPP (hygiene rules), and find
  out which alcohol licence applies before serving any alcohol.
- [ ] **10. Mailbox cleanup is a quarterly task** (owner: maintainer). The
  12-month promise for contact, volunteer and pre-registration emails is checked
  every quarter (runbook, section e, "Quarterly"). Put it in the calendar: Gmail
  search `older_than:12m`, review, delete, empty the Trash.
- [ ] **11. Accept or record the data processing agreements** (owner:
  maintainer): see `docs/privacy/processors-checklist.md` (Status column), in
  particular GitHub (it runs the backup job, so the database dump passes through
  it).
- [ ] **12. Encrypt the backup before it leaves GitHub Actions** (owner:
  maintainer, optional). TODO(the association): consider encrypting the dump
  before upload so the copy that passes through GitHub is unreadable there (the
  key must then be kept safe, or restoring is impossible).

## Items for the accountant

- [ ] **13. VAT: which article of the CGI?** (owner: accountant). The shop shows
  "TVA non applicable" (cart, book pages, terms of sale, order email). French
  rules want the article of the Code général des impôts as well. Recommendation:
  ask whether it is **261-7-1°** or **293 B**; do not guess. When the answer
  comes: set `VAT_NOTICE_ARTICLE` in `umas-books/src/lib/legal.js` (see
  `docs/runbook.md`, section o).
- [ ] **14. NF525 (certified till software)** (owner: accountant). Question: does
  the association's till have to meet the anti-fraud rules (NF525 certificate)
  given its status, VAT position and turnover? Recommendation: ask in writing; if
  the answer is yes, the till must be certified before it is used for real sales.
- [ ] **15. Donation tax receipts** (owner: accountant). The till records no donor
  identity. Recommendation: issue a *reçu fiscal* (Cerfa 11580) only if the
  association is eligible; ask the accountant. If it is, a receipt needs the
  donor's name and address, which the till does not collect: do it by hand,
  outside the till.
- [ ] **16. Cash payment cap** (owner: accountant). Recommendation: confirm the
  legal cap on cash payments that applies to the shop (generally 1 000 EUR for a
  person resident in France) and tell volunteers to refuse larger cash payments.

## Items for the lawyer

- [ ] **17. Membership fee: does the 14-day right of withdrawal apply?** (owner:
  lawyer). Question: is a membership paid online through HelloAsso (a
  contribution to an association that gives voting and forum access, for 12
  months, active at once) a distance contract with a right of withdrawal, and is
  the immediate activation covered by an exemption or a waiver at payment? Also
  the statement "not refundable, except where required by law" in the membership
  terms, and the HelloAsso form's own payment-button wording (HelloAsso's, not
  ours). **Interim wording on the site until the lawyer answers** (a position the
  association can honour): "If you join online you may withdraw within 14 days by
  writing to admin@umasbooks.org; we will refund your payment and the membership
  then ends." (French: « Si vous adhérez en ligne, vous pouvez vous rétracter
  dans les 14 jours en écrivant à admin@umasbooks.org ; nous vous remboursons et
  l’adhésion prend fin. »). Refunds are done in HelloAsso (runbook, section k).
- [x] **18. Terms of sale: "courts" sentence** (done 2026-10-07; the lawyer may
  still review it). The French sentence that said the courts are "seules
  compétentes" now reads « les juridictions compétentes en vertu du droit de la
  consommation s’appliquent » (the consumer keeps the choice of court).
  `TERMS_OF_SALE_VERSION` was bumped to 2026-10-08.
- [ ] **19. Click-and-collect reservation, payment in the shop: distance
  contract?** (owner: lawyer / consumer mediator). Details below.

## Closed or no longer needed

- **Reservations that are never collected** (settled, for information): books and
  drop-in seats are reserved online and paid in the shop, so no paid order waits
  to be collected. A reservation that is not collected lapses after 14 days (the
  shop can extend it once, by 7 days), with no penalty, and the books go back on
  sale; the terms of sale say so. Nothing to do unless the association wants a
  different rule (a deposit, a fee), which would need the terms to change first.
- **Footer social icons**: none until real addresses exist (runbook, section o).

## Item 19 in detail: click-and-collect reservation, payment in the shop

Since the "reserve online, pay at the shop" change, nothing is paid on the
website for books and drop-in seats (only the membership is paid online). A
second legal review (October 2026) advised the following, which the site now
applies: **a reservation is a free, non-binding hold; the sale is concluded and
paid in the shop, in person, so it is not a distance contract.** Therefore the
terms of sale, the cart and the reservation email show **no 14-day withdrawal
notice and no model withdrawal form** for books and drop-in seats. Withdrawal
text stays **only** for the online membership payment (membership terms, with
the neutral sentence "applies where the law provides for it").

**To confirm with a lawyer / the consumer mediator (CM2C):**

- that a click-and-collect reservation with payment and handover in the shop is
  not a distance contract (so no right of withdrawal for books, and none to
  mention in the email), including when the customer reserved online and never
  collects (no contract at all);
- that the "no returns for a change of mind once bought in the shop" notice
  (`NO_RETURNS` in `umas-books/src/lib/legalText.js`) is acceptable next to the
  statement that the legal guarantees still apply;
- that the drop-in seat needs no withdrawal waiver (nothing is paid online; the
  checkbox was removed);
- the list of what the terms of sale now state (seller identity and contact,
  price TTC "TVA non applicable", unique copies, hold of 14 days (+7 once) with
  automatic release and no fee or penalty, limits of 10 books and 3 reservations
  per account, price honoured during the hold, payment in cash or card in the
  shop, condition checked on the spot with the right to decline, opening hours
  and address, reservation data kept 30 days after it ends).

Until answered, do not put the withdrawal notice back without asking. If the
lawyer says the opposite (a withdrawal right applies), ask for the terms of
sale, the reservation email and `NO_RETURNS` to be changed together, and bump
`TERMS_OF_SALE_VERSION`.
