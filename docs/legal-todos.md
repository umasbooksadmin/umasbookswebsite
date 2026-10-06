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
website for books and drop-in seats (only the membership is paid online). The
customer reserves online, then pays and collects in the shop, where the sale is
concluded. Question for the lawyer / the consumer mediator (CM2C): is such a
click-and-collect reservation a distance contract (Consumer Code, art.
L.221-1 et seq.), so that the 14-day right of withdrawal for books (art.
L.221-18) applies, or is it an ordinary in-shop sale (no right of withdrawal),
because the price is paid and the contract concluded in the shop? Also: does
the answer change if the customer reserves a book and later does not collect
it (no contract at all)? Nobody decided this; the site does not take a side.

What the site shows meanwhile (do not remove until answered):

- the terms of sale keep the withdrawal paragraph and the withdrawal form, with
  one neutral sentence: "This right applies where the law provides for it."
  (French: "Ce droit s'applique lorsque la loi le prévoit.");
- the "no returns for a change of mind in the shop" sentence (single source:
  `NO_RETURNS` in `umas-books/src/lib/legalText.js`) says the legal guarantees
  and the statutory right of withdrawal "where the law provides for it" still
  apply, and never says a right is waived;
- the reservation confirmation email repeats the withdrawal information and
  the withdrawal form, in French and English, with the same neutral sentence;
- drop-in seats: the terms say the right of withdrawal does not apply to them
  (art. L.221-28, 12°, leisure activity on a specific date); there is no waiver
  checkbox any more, since nothing is paid online.

When the answer comes: if it applies, nothing to change; if it does not, ask
for the terms (section "Right of withdrawal"), the email and `NO_RETURNS` to be
simplified together, and bump `TERMS_OF_SALE_VERSION`.
