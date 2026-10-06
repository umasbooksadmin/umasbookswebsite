# Legal to-do list for the association

Open legal questions found in the final legal review (October 2026). The
website shows the neutral wording named below until each one is answered. None
of this is legal advice: it is the list to take to the accountant or the lawyer.

## 1. VAT: which article of the CGI?

The shop shows "TVA non applicable" (cart, book pages, terms of sale, order
email). French rules want the article of the Code général des impôts as well.
The accountant has not said whether it is **261-7-1°** or **293 B**. Do not
guess. When the answer comes: set `VAT_NOTICE_ARTICLE` in
`umas-books/src/lib/legal.js` (see `docs/runbook.md`, section o).

## 2. Membership fee: does the 14-day right of withdrawal apply?

The membership terms say only: "The legal right of withdrawal for distance
contracts applies where the law provides for it." Question for the lawyer: is a
membership paid online through HelloAsso (a contribution to an association that
gives voting and forum access, for 12 months, active at once) a distance
contract with a right of withdrawal, and is the immediate activation covered by
an exemption or a waiver at payment? Also: the statement "not refundable,
except where required by law" in the membership terms (section "Ending your
membership"), and the HelloAsso form's own payment-button wording, which is
HelloAsso's, not ours (check that its last button says it creates an
obligation to pay).

## 3. Weekly immersion program: terms are missing

The immersion pages give the price (15 EUR per session, billed monthly) but say
nothing on cancellation, absences or refunds (the old "cancellations 48 hours
in advance" sentence was on unused text with a stale 20 EUR price and was
removed). No terms of sale were written for the program because the facts are
not decided. TODO (the association): decide cancellation and absence rules,
billing dates and what happens if the association cancels a session, then
add a short "Immersion program" section to the terms of sale (EN and FR) and
bump `TERMS_OF_SALE_VERSION`.

## 4. Reservations that are never collected (settled, for information)

Books and drop-in seats are reserved online and paid in the shop, so there is
no longer a paid order waiting to be collected. A reservation that is not
collected lapses after 14 days (the shop can extend it once, by 7 days), with
no penalty, and the books go back on sale; the terms of sale say so. Nothing to
do unless the association wants a different rule (a deposit, a fee), which
would need the terms to change first.

## 5. Photos

The photo-consent clause is kept as merged. Still open (also in
`docs/privacy/record-of-processing.md`): where photos are stored, whether any
are published, and how long they are kept.

## 6. Small items to confirm

- The footer has no Instagram/Facebook icons until real addresses exist (runbook, section o).
- The visit page still shows the kicker "Chapter Four" (it is used on that
  page: replace it with a real label if you want).
- The statutes of the association are "available on request" (membership
  terms): make sure a copy can really be sent.

## 7. Click-and-collect reservation, payment in the shop: distance contract?

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
