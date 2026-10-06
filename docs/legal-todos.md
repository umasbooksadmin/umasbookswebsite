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

## 4. Orders that are never collected

The terms ask buyers to collect within 14 days of payment and to write if they
need longer; they promise nothing else (no automatic release, no refund). The
software does not cancel a paid order after 14 days. TODO (the association):
decide what happens to a paid order that is not collected (kept longer,
offered again, refunded) and whether to write it in the terms.

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
