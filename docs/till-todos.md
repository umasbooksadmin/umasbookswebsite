# Till: open questions and later work

## TODO(the association): accounting import

The **Accounting export** (Reports > Accounting export, CSV with the columns
Date, Category, Payment method, Count, Total (EUR), Libellé, Compte débit,
Compte crédit, Journal) is built for the treasurer. Refunded online orders give a
negative row on the refund day; a closed day's cash difference gives a
"Cash over/short" row; the opening float is never counted. The accounts come
from the editable table `accounting_map` (`/admin/reports/accounting/mapping`),
whose defaults (530 cash, 511 or 512 for cards and HelloAsso, 707/706/756/754/708
income, 658/758 over/short) are a guess to be confirmed. There is also a French
Excel variant of every CSV (`&locale=fr`).
Ask the treasurer to confirm the import layout. Question for the treasurer: does Paheko's import (or the accountant's software)
accept this layout, and which columns, date format, decimal separator and
account codes does it want? Nothing here was checked against Paheko: do not
assume. Once answered, either adapt the columns in `src/lib/accounting.js` or
write a small conversion step.

## TODO(the association): "Books (other)" manual items

A manual item with the category "Books (other)" appears under **Other** in the
export. Say if it should be Books used or Books new instead.

## Later: SumUp Cloud API

`src/lib/cardPayments.js` has the interface and the manual implementation. A
SumUp implementation (Readers API on a Solo reader: create the checkout on the
reader, then poll or receive the webhook, inside the 60 second window; use the
sale token as the client transaction id) needs: a SumUp API key, the paired
reader id, and Render environment variables for them (not defined yet).

## Done: collecting online reservations at the till

Scanning or typing `ORDER-<n>` (or the UB- label of a reserved book) loads the
reservation into the sale; paying cash or card collects it through the same
function as "Mark collected and paid" (`src/lib/tillReservations.js`). A sale
that collected a reservation cannot be voided at the till: the order is
refunded instead. Still open: the till receipt of such a sale is English only
(a French receipt for the customer is a separate decision).

## Later: receipt printer, split payments

Out of scope for now.
