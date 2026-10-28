# Architecture

> **Which document is authoritative for what.** This file is the authoritative,
> file-level map: routes, views, data domains, the **environment-variable
> inventory** (the one source; a test keeps it complete), migrations, and where
> each feature lives. [`../docs/architecture.md`](../docs/architecture.md) is the
> system in diagrams (context, request flow, data model, payments, deploy,
> backups, security) and defers to this file for variables. [README.md](README.md)
> says what each feature does and how to run it locally.
> [`../docs/runbook.md`](../docs/runbook.md) is for operating it.

A quick technical map of how this app is put together — routing, views,
data, config, and how a change gets from a commit to production. See
[README.md](README.md) for what each feature does, and
[../README.md](../README.md) for the marketing-site side of things.

## One app, two front ends

`umas-books` is a single Express process (`src/index.js`, the thin entry; the
app itself is built by `createApp()` in `src/app.js`, the background jobs by
`src/jobs.js`) that serves
**both** the public marketing site (plain pages: About, Books, Events, …)
**and** the members-area app (accounts, forum, admin, reservations, …). There
is no separate marketing server — Squarespace was retired, and these
pages now live in this repo's root and are rendered by this same process.
That's why `render.yaml`'s `buildFilter` covers the whole repo, not just
`umas-books/`.

## Canonical marketing routes

Registered in `src/app.js`, each backed by a view under
`views/marketing/`:

| Route | View |
|---|---|
| `/` | `views/marketing/index.ejs` (redirects a logged-in member/volunteer/admin to `/dashboard` instead) |
| `/about.html`, `/blog.html`, `/books.html`, `/events.html`, `/programs.html`, `/immersion.html`, `/pre-registration.html`, `/membership.html`, `/visit.html`, `/volunteer.html`, `/privacy-policy.html`, `/membership-terms.html` | `views/marketing/<name>.ejs`, one `app.get` per entry in the `MARKETING_PAGES` array |

Adding a marketing page means adding both a `views/marketing/<name>.ejs`
file **and** its filename to `MARKETING_PAGES` — the array is the single
source of truth for which routes exist; nothing scans the `views/`
directory automatically.

**Marketing forms (server-side).** `pre-registration.html` and `volunteer.html`
carry real forms that `POST /pre-registration` and `POST /volunteer-signup`
(`src/routes/marketingForms.js`, validation and email text in
`src/lib/marketingForms.js`). Same pattern as `/contact`: the app-wide CSRF
check (the page prints `csrfToken`, so it is `Cache-Control: private, no-store`),
a honeypot field (`website`), a per-IP limiter (5 per 15 minutes, one counter per
form, refused attempts count), then ONE email to `CONTACT_TO` through `deliver()`
(`sendEmail` of `lib/outbox.js`, kind `contact`, so a failed send is retried). Nothing else is stored in the database and no
form content is logged (a failure logs the error message only; the email subject
carries no personal data). The pre-registration needs the child's name, date of
birth, a session, at least one day and time, the guardian's name, email and phone,
and a ticked "I am the parent or legal guardian of the child and I agree to be
contacted about this program"; the volunteer form needs name, email and consent.
Both say not to enter health information. A refused submission re-renders the
page with status 400 (429 rate limited; a failed send is queued by the outbox and still shows success), the typed values, an
error summary (`role="alert"`, `tabindex="-1"`, links to each field,
`assets/form-errors.js` moves focus to it) and per-field errors
(`aria-invalid`, `aria-describedby`). The messages are `form.err.*` keys in
`assets/i18n-common.js` COMMON (EN + FR), so the language toggle and the French server
render both work. Success redirects to `/<page>?sent=1`, which shows a thank-you
panel. The repeated `days` / `times` fields are in `MULTI_VALUE_BODY_FIELDS` in
`src/app.js` so the multi-selects are not collapsed to their first value. The
mailbox keeps these emails 12 months (yearly manual cleanup, `docs/runbook.md`).

**HelloAsso form is click-to-load.** `membership.html` renders a
`#haWidgetHolder` with a "Show the HelloAsso form" button; `assets/membership-widget.js`
creates the iframe only after the click (src taken from `data-src`, accepted only
on `https://www.helloasso.com/`), so HelloAsso gets no request, IP address or
cookie before the visitor chooses. The marketing CSP (`src/lib/marketingCsp.js`)
keeps `frame-src https://www.helloasso.com` and has no external image host.

Static assets are served directly from the repo root, not rendered:
`/assets/*` (CSS/JS/images) and `/logo.png`. The app's own static assets
(favicons, `admin.css`, `public/app.js`, …) are served separately from
`umas-books/public/` at the site root (`/style.css`, `/admin.css`, etc.)
— two different `express.static` mounts, one per directory.

Every marketing route sets its own restrictive CSP (`marketingCsp` in
`src/app.js`) before rendering — stricter than default since these
pages need no forms/scripts beyond the shared header's language toggle.

Both CSPs (app-wide helmet and `marketingCsp`) have `form-action 'self'` only (`formActionSources` in `src/app.js`): no form of ours posts to another site, and no redirect to another site follows a form POST, because books and seats are reserved here and paid in the shop (Chrome enforces `form-action` on the redirect after a POST, which is why HelloAsso hosts used to be listed there for the old online checkout). The HelloAsso membership form is an iframe/link allowed by `frame-src` instead; `src/lib/helloassoHosts.js` now only tells whether `HELLOASSO_API_BASE` is the sandbox.

## Legacy redirects

The booking calendar has been renamed twice ("classes" → "programs" →
the current `/sessions`). Rather than break old bookmarks/links, every
old address 301-redirects to the current one, forwarding any query
string:

| Old | Redirects to | Defined in |
|---|---|---|
| `/classes.html` | `/programs.html` | `src/app.js` |
| `/classes` | `/sessions` | `src/app.js` |
| `/admin/classes` | `/admin/sessions` | `src/app.js` |
| `/programs` | `/sessions` | `src/app.js` |
| `/admin/programs` | `/admin/sessions` | `src/app.js` |
| `/immersion/calendar` | `/sessions` | `src/routes/sessions.js` |

`/programs.html` (the marketing page) is unaffected — it's a different
thing from the `/programs` calendar route that used to exist.

## Shared partials (`views/partials/`, `views/marketing/partials/`)

| Partial | Used by | Purpose |
|---|---|---|
| `header.ejs` / `footer.ejs` | every members-area page (~25 views) | page shell: `<head>`, nav (Log in/out, cart, account icons), closing markup |
| `csrf_field.ejs` | every form (~27 views) | the hidden `_csrf` input every POST form must include — see [Security](README.md#security) |
| `admin_header.ejs` / `admin_footer.ejs` | every `/admin/*` page (14 views) | the admin section's own shell + sub-nav, separate from the member-facing header/footer |
| `calendar_grid.ejs` | `events.ejs`, `sessions.ejs`, and the admin volunteer/meetings/events/sessions calendars | the month/week grid layout, parameterized by an `itemPartial` name (`calendar_item_event.ejs` or `calendar_item_session.ejs`) so one grid renders either kind of entry |
| `mkt_chrome_header.ejs` / `mkt_chrome_footer.ejs` (in `views/marketing/partials/`) | `views/marketing/index.ejs` | the marketing homepage's own header/footer variant |
| `mkt_header.ejs` / `mkt_footer.ejs` / `mkt_member_band.ejs` (in `views/marketing/partials/`) | the other marketing pages | shared marketing-page chrome, including the "Member's Access" promo band |

Changing the members-area header/footer markup only touches
`views/partials/header.ejs`/`footer.ejs`; changing the marketing pages'
shared chrome touches the `mkt_*` partials instead — the two are
deliberately separate since the marketing pages need a lighter CSP and
different nav (no cart/account icons).

## Data domains

30 application tables (`migrations/`), plus `schema_migrations` and the
`session` store table (created by `migrate.js` / `connect-pg-simple`
rather than by a numbered migration), grouped by what they belong to:

- **Condition grades and binding** — `book_copies.condition` is one of five
  grades, `new`, `like_new`, `very_good`, `good`, `acceptable` (default `very_good`),
  defined once in `CONDITIONS` in `src/lib/inventory.js` (value, English and
  French label, one-line description) and used by the admin forms, the public
  book page (every in-stock copy is listed with its grade, plus a "What the
  grades mean" legend), the cart and the order lines/emails (`orderItemLabel`
  appends the grade, joined from the copy via `order_items.book_copy_id`).
  Migration 048 remapped the old grades (good to very_good, fair and poor to
  acceptable) and added a CHECK constraint; migration 078 made the grades
  New / Very Good / Good / Acceptable (like_new became very_good), and migration 083 added Like New back as a fifth grade
  (no data converted back; `normalizeCondition` still accepts fair and poor as aliases). A copy that cannot be sold at all
  is not a grade: it gets the status `damaged`. `books.binding` (migration
  048, NULL when unknown) is `mass_market`, `trade`, `hardcover` (shown as "Hardback") or `other`,
  in that display order (`BINDINGS`, `normalizeBinding`; migration 077 renamed `paperback` to
  `trade`, and `normalizeBinding` still accepts `paperback` as an alias, and `hardback` for `hardcover`; the
  pricing setting `fallback_paperback` became `fallback_trade`); it belongs to the edition, is prefilled
  from Open Library's `physical_format` (`mapBinding` in
  `src/lib/bookLookup.js`: hardcover; mass market / poche; any other paperback is
  trade; any other format is other) and never overwritten by a second copy.
- **Fixed price for new books (loi Lang)** — a `book_copies` row with
  condition `new` must carry `publisher_price` (migration 041) and be priced
  between 95% and 100% of it; enforced server-side by `resolveCopyPricing`
  in `src/lib/inventory.js` on both add-copy and edit-copy. Used copies are
  free-priced and store `publisher_price` NULL.
- **Inventory locations** — `book_copies.location` (migration 043) is free
  text per physical copy, normalised by `normalizeLocation` in
  `src/lib/inventory.js` (trimmed, spaces collapsed, 40 chars; capitals are kept as typed, and `sameLocation`/`uniqueLocations` compare case-insensitively).
  There is no locations table: the dropdown (a `<datalist>`, partial
  `location_options`) is the distinct locations folded case-insensitively (`getLocations`, most common spelling shown), so a newly typed place
  appears from then on. The scan/add flow carries the current location
  through hidden fields and `public/inventory-location.js` (localStorage);
  `/admin/inventory/move` moves one copy per scanned ISBN (`parseScan`), and
  each move writes a `copy.move` audit row (location codes only).
- **Saving a copy is idempotent** (`POST /admin/inventory`, migration 093
  `copy_intake_tokens`, `src/lib/intakeToken.js`): the Add Book / fast-scan form carries a
  random `intakeToken` (a fresh one per page and, in `public/scan-intake.js`, per saved
  copy). The server claims it before creating anything; the same token again within 10
  minutes returns the first result (same copy id, no new copy, no second AI/awards
  follow-up). A failed save releases the token. A post without a token (a page cached
  from before) still saves as before and logs a warning.
- **Awards & best-seller lists** — `book_awards` (migration 050, tightened by
  079) plus `books.awards_checked_at / awards_check_state`. Code in
  `src/lib/awards/`: `wikidata.js` (SPARQL by ISBN, awards P166 and
  nominations P1411), `nyt.js` (optional, `NYT_API_KEY`, in-process 5/min and
  500/day gate), `index.js` (`checkBookAwards`, `drainAwards`), `display.js`
  (what customers may see). **Trust model:** there is no review step and no AI
  source. Every row is `verified` and shown at once: it came from Wikidata, the
  NYT API, or an admin typed it (`manual`); migration 079 deletes the old AI,
  pending, approved and rejected rows and its CHECK constraints forbid them.
  Every lookup fails open and never blocks a save. A new book is checked in the
  background right after intake; a timer in `src/jobs.js` (every 2 minutes, 5
  books, via `guardJob`) checks never-checked books newest first, retries
  failures after a day, and refreshes yearly. Admin add / remove / re-check
  write `award.*` audit rows (label only). `AWARDS_LOOKUPS=off` is a kill
  switch (the test helpers set it).
- **Book requests** — `book_requests` and `book_request_list_tokens`
  (migration 047), replacing the retired wishlist. Public, no login or
  membership: `/request-a-book` (form; always answers "check your inbox"),
  double opt-in via `/request-a-book/confirm/:token` (the GET only shows a
  Confirm button, the POST confirms, so mail scanners can't), a private
  `/my-requests/:manageToken` link in every email to view/cancel, "Find my
  requests" at `/my-requests` (30-day emailed list link), and a "My book
  requests" section in My Account (by `user_id` or verified email). Tokens
  use `lib/resetTokens.js` (hashed at rest; the manage token is replaced
  whenever a newer email goes out). Logic is in `lib/bookRequests.js`: when a
  copy is created (or a book's title/ISBN is edited) open requests with the same ISBN
  (`isbnVariants`, 10 vs 13) or the same normalised title with an empty or
  overlapping author become `matched`. Admin → Book Requests
  (`routes/admin/requests.js`, English) has a one-click Notify and "Notify and hold
  7 days" (holds the copy without an order, with `reserved_at` back-dated 7 days so the standard 14-day
  hold ends in 7, and `reminder_sent_at` set so the day-11 pickup reminder
  stays quiet); every action writes an audit row with ids only. Emails use the
  requester's `lang`. Personal columns are cleared on cancel, expiry, erasure
  and by the daily purge (unconfirmed after 7 days, open/matched/notified at 12 months,
  ended ones after 30 days); the data export has a `book_requests` section.
- **Copy source** — `book_copies.source` (migration 045) is `donation`,
  `purchase`, `lot`, `other` or NULL (unknown; all copies from before). Chosen
  at intake (a select next to the location on the scan page, carried through
  the scan loop like the location, plus `inventory-location.js` for a page
  reload) and editable on the copy; `SOURCES` / `normalizeSource` in
  `src/lib/inventory.js`; the table has a CHECK constraint.
- **In-shop sales** — `shop_sales` (migration 046): one row per copy sold over
  the counter (price, `sold_at`, `sold_by` admin id, payment method; no buyer
  data). The old "Sell in shop" page (`/admin/inventory/sell`) is **retired**: GET and POST redirect (302)
  to `/admin/till?notice=sell-retired`. The table and its old rows stay; the till writes one row
  per book it sells (none for a collected reservation), so the reports count a sale once.
- **Reports** — `/admin/reports` (`src/routes/admin/reports.js`, SQL in
  `src/lib/reports.js`, views `views/admin/reports/`): inventory on hand,
  aging stock, sales over time (reservations collected and paid in the shop, by `orders.paid_at`, + walk-in shop
  sales; a reservations report (`/admin/reports/reservations`); drop-in seats in a separate table), sell-through by genre,
  membership, intake log, accounts (everyone with an account by type, orders
  and spend; paged by 50, filters by type/search/created date). Read-only aggregate queries (no N+1, LIMITs on every
  list, Paris day boundaries computed in SQL), `requireAdmin` throughout, no
  member emails or buyer names (except the Accounts report, whose job is the
  list of accounts; its type definitions live in `src/lib/accountTypes.js`,
  shared with `/admin/members`, so the two never disagree). `?format=csv&table=<section>` (or a `.csv`
  suffix) downloads a section: UTF-8 BOM, quoted text, cells starting with
  `= + - @` get a leading apostrophe; each download writes a `report.csv`
  audit row (slug only). Definitions: a copy is "sold" when its status is
  `sold`; its sold date is the shop sale, else the paid order's `paid_at`
  (copies marked sold by hand have no date and are left out of "days to
  sell"); age is counted from `acquired_at`, else the day the row was created.

- **Price safety** — a copy is only purchasable online with a real price:
  `price IS NOT NULL AND price > 0` is required by the public book page (no
  Add to Cart, "Ask in the shop" instead), `/cart/add`, `loadCartItems`, the
  reservation row lock (a null-price copy can never reach an order or a total of
  0), public reservations and book-request holds (`isPurchasablePrice` in
  `src/lib/inventory.js`). The in-shop sale takes the price typed at the counter,
  so an unpriced copy can still be sold over the counter. Every admin money
  or number input goes through `parseMoney` / `parseWholeNumber`
  (`src/lib/validation.js`: 0 to 10000 euros, at most 2 decimals, years 1000 to
  next year); migration 056 adds CHECK constraints (`book_copies.price`,
  `acquisition_cost`, `classes.dropin_price` NULL or 0 to under 100000) and
  sets out-of-range legacy values to NULL. The copy edit form posts the status
  it was rendered with and only changes the status when the copy still has it
  (never a sold, in-cart or online-reserved copy); cancelling a reservation only matches a copy
  that is still `reserved`.

- **Suggested prices** — `src/lib/pricing/` (migrations 053, 054, 085). Prices are
  only ever *suggestions*; a volunteer accepts or changes them and nothing is
  published automatically. `rules.js` is the pure rules engine (no network,
  no database; the order of checks is written at its top): new = publisher
  price; no ISBN = manual review; mass market and trade = a flat EUR 5 each (settings `mass_market_price`, `trade_price`, migration 085; "other" and hardback follow the normal rules); online value M (median
  of used listings in EUR, outliers trimmed; else publisher price x 0.35; else a
  typical value by binding) under 6 = Rule A (EUR 5), under 20 = Rule B (EUR
  10; EUR 8 was retired, the standard levels are 3, 5, 10), under 50 = Rule C (75% of M, rounded to 0.50), 50 or more = manual
  review; hardbacks (key `hardcover`) never below EUR 10; clearance (EUR 1) when 2+ copies of
  the book are already in stock (Rule A / mass market / trade, by default). The
  copy's condition never changes the price. Every number is a setting in
  `pricing_settings` (single row, `settings.js`, 60 s cache) edited at
  `/admin/pricing` (audit `pricing.settings`, changed keys only).
  `market.js` is the optional AI market check (Anthropic Messages API with the
  web search tool, same call pattern as `bookDescription.js`): off by default,
  fails open, 12 s timeout, results cached 30 days per ISBN-13 in
  `price_lookups`, daily cap counted from that table. `index.js` combines the
  two (`suggestPrice`, never throws); `forms.js`/`intake.js` are the glue to the
  admin forms; `clearance.js` counts copies and lists candidates. The add-book
  and copy forms use `public/price-suggestion.js` against
  `GET /admin/inventory/price-suggestion` (30 a minute per admin); what was
  suggested is stored on the copy (`suggested_price`, `suggested_level`,
  `price_basis`), and `is_clearance` marks clearance copies (shown to the public
  as a badge). `/admin/pricing/review` is the price check (copies that differ
  from the suggestion, copies needing review, clearance candidates; audit
  `copy.reprice`). `/admin/pricing/reprice` (`reprice.js`) is the one-off
  Reprice tool: it previews three groups of plain in-stock copies (trade not at
  the trade price, mass market not at the mass market price, any other binding
  at exactly EUR 8 -> EUR 10), each applied by its own confirm button in one
  transaction (rows locked `FOR UPDATE SKIP LOCKED`, conditions re-checked in
  the UPDATE), with `price_reprice_runs`/`price_reprice_items` holding the
  before/after per copy (CSV download), `price_basis = 'repriced'` on the copy
  and one audit row (`pricing.reprice`) per run. Clearance, new, reserved,
  sold, in-cart and request-held copies are never touched.
- **New books in the price control** — for new books the suggestion panel says
  "New book: sell at the publisher's price (max 5% off)" and never proposes a
  used level (`summaryLabel` in `lib/pricing/index.js`; the loi Lang rules in
  `resolveCopyPricing` are unchanged).
- **The till** — in-person sales (`src/routes/admin/till.js`,
  libs `till.js`, `tillScan.js`, `cardPayments.js`, `accounting.js`;
  views `views/admin/till/`;
  scripts `public/till.js`, `till-day.js`). English. Admins, plus accounts with "Till access"
  (`users.is_till`, `requireTillOrAdmin`, only on the till page and its scan/check/sale/release/void/receipt/read-only end-of-day routes).
  See `docs/architecture.md` ("The till", "Till correctness and money safety") for the data model.

  | Route | Purpose |
  |---|---|
  | `GET /admin/till` | the till screen: scan box, lines, Cash / Card, quick items, today's sales with Void |
  | `POST /admin/till/scan` | JSON: resolves a scanned code (order: `UB-` copy code, quick-item barcode, ISBN, unknown) |
  | `POST /admin/till/check` | JSON: the sale's validation without writing (called when Cash / Card opens) |
  | `POST /admin/till/sale` | JSON: records the sale in one transaction (`sale_token` + basket hash make it idempotent; `expectedTotalCents` must match; 409 `price_changed` / `day_closed` / `token_replay`); audit `till.sale`, `till.price_override`, `till.sale_backdated`, `till.day_reopen` |
  | `POST /admin/till/release` | releases a copy from an EXPIRED online cart (the cart's release function); audit `till.release_cart` |
  | `POST /admin/till/sales/:id/void` | same-day void with a reason; restocks copies and quick items; audit `till.void`; card sales carry the "I refunded the card" tick |
  | `POST /admin/till/sales/:id/refunded` | ticks "I refunded the card" on a voided card sale; audit `till.refund_confirmed` |
  | `GET /admin/till/sales/:id/receipt` | printable receipt (no customer data, "TVA non applicable") |
  | `GET /admin/till/items`, `POST /admin/till/items[/:id]`, `POST /admin/till/items/:id/generate-code` | "Other stock (not books)": quick items with optional barcode, stock and a generated shop code |
  | `GET /admin/till/day[?day=][&format=csv]`, `POST /admin/till/day/open` (today or a past unclosed day), `POST /admin/till/day/close`, `POST /admin/till/day/reopen` | end of day: totals, opening float, count and close (locks voids, needs a confirmation if no float), reopen (admin, reason), CSV; unclosed past days and unrefunded voided card sales appear in the dashboard's Needs attention |
  | `GET /admin/reports/accounting[?format=csv]` | Accounting export (`src/lib/accounting.js`): one row per Paris day, category and payment method; no customer data. A refunded reservation, and a refunded membership payment (`membership_payments.reversed_at`), keep their original row and add a NEGATIVE row on the refund day |
- **Accounts & auth** — `users`, `password_reset_tokens`,
  `email_verification_tokens`
- **Shop / reservations** — `books`, `book_copies`, `orders` (with `cgv_accepted_at` / `cgv_version`: proof of acceptance of the terms of sale, version from `src/lib/legal.js`), `order_items`
  (an order line references *either* a book copy *or* a class drop-in
  seat, never both — see the `order_items_one_item_type` check
  constraint). Books and drop-in seats are RESERVED online and PAID IN PERSON;
  nothing is paid online for them. `orders.status` is plain text: `reserved`,
  `paid`, `refunded`, `expired`, `cancelled`, and `pending` (only on old
  online-checkout orders). Migration 066 added `reserved_until`,
  `reservation_extended_at`, `released_at` / `release_reason`,
  `expiry_notice_sent_at`, `payment_method` / `amount_received` /
  `payment_note` / `reserved_total`, `split_from_order_id` and
  `class_dropin_seats.reminder_sent_at`. The life of a reservation is in
  `src/lib/reservations.js` (deadline, release, customer cancel, extend), the staff
  actions in `src/lib/orderActions.js` (`collectReservation`: "Mark collected
  and paid" with payment method and amount, partial pickup into a new
  reserved order, `markOrderRefunded`: a refund is made by hand in the shop and an
  admin then presses "Mark refunded" on `/admin/orders/:id`, which in one
  transaction sets `refunded` + `refunded_at` + `refund_note`, puts the order's
  sold copies back `in_stock` (not a copy sold again since) and marks its
  drop-in seats `released`; it also records `orders.refund_method` (cash from the
  till drawer, card, transfer, other; NULL for refunds made before migration 095;
  the accounting export's refund row uses it as its payment method)
  and, for a cash refund made while today's till day is not closed,
  `orders.refund_till_day`: `till.daySummary` subtracts those from the day's expected
  cash, and a cash refund on a closed day is refused). Cash taken with the admin
  "Mark collected and paid" button (`orders.payment_method = 'cash'`, `amount_received`
  set, `paid_at` on that Paris day, NOT collected at the till: `accounting.TILL_COLLECTED`)
  is added by `till.daySummary` as `adminCash` to the day's expected cash and to the
  last column of the till days CSV ("Admin-button cash (EUR)"); the export itself is
  unchanged (the order is already one export row set), and `collectReservation`
  refuses cash on a closed till day (`till_day_closed`) like a cash refund.
  Collected for less than the
  list price: `collectReservationTx` sets `total_amount` / `amount_received` to what
  was received and `reserved_total` to the list total. `accounting.accountingRows`
  exports the lines at list price plus one negative "Discount" row per day and
  method (credit account 709; `DISCOUNT_ORDERS_SQL`, used by the Sales report too),
  reversed on the refund day, so the export equals what was received;
  `test/integration/accountingReconciliation.test.js` asserts export, Sales report,
  Refunds report and Dashboard agree to the cent), and the cart in `src/lib/cart.js`
  (`createReservation`). `src/lib/orderSweeps.js` (every 6 h, started in
  `src/jobs.js`, no payment-provider call) releases lapsed reservations, sends the
  day-10 customer reminder (`customer_pickup_reminder_sent_at`), the 24-hour
  drop-in seat reminder, the "reservation ended" email and the admin digest of
  reservations expiring within 2 days (`pickup_reminder_sent_at`), each once.
  Revenue everywhere counts `status = 'paid'` only, by `paid_at` (the day staff
  record the payment) in Paris time (`src/lib/dashboardStats.js`,
  `src/lib/reports.js`).
- **Legacy trust decision (one-time):** migration 032 marked every
  account that existed at the time as email-verified, since forcing
  re-verification would lock out real members. Email squatting that
  predates it (someone registering another person's address first) is
  therefore not detectable and can only be fixed by an admin editing or
  disabling the account at `/admin/members`. Changing an account's email
  there clears verification and sends a link to the new address. Accounts
  an admin creates are verified immediately, justified because the invite
  link must be clicked from that same inbox to set a password.
- **Account pre-hijack defence** (migration 055, `users.first_verification_pending`,
  set only by `POST /signup`): signup collects **no password** (the account gets
  a random unusable hash and cannot log in). The emailed link
  (`GET /verify-email/:token` shows a "Confirm my email" button; its `POST` does the work, because mail scanners open GET links) verifies the email, bumps `password_changed_at`
  and redirects to `/reset-password/:token?confirmed=1`, a fresh single-use
  token, where the person chooses their password (policy and breach check
  apply); they then land on `/login?reset=confirmed`. So only the mailbox owner
  can ever set a password. The membership sync waits for that choice.
  `POST /resend-verification` is neutral and rate limited. Admin-created,
  grandfathered (032) and admin-email-changed accounts are unflagged and keep
  their password. Still-unconfirmed accounts from the old password-at-signup form
  follow the same rules (migration 055 flagged them). Reasoning is in the comment
  above the verify route in `src/routes/auth.js`.
- **Membership** — becoming a member needs an account, created in one step on
  the membership page (`POST /membership/join` reuses `registerAccount` from
  `/signup`; pay first, confirm the email after; the page state is in
  `src/lib/membershipPage.js`; the next page is identical whether or not the
  address already has an account). A logged-in person sees only the payment
  form, and `POST /membership/check` (5 per 10 min per account) runs the same
  sync for their own confirmed email. `membership_payments` (HelloAsso payment records,
  matched to a `users` row by verified email — see
  `src/lib/membership.js`). The sync also re-runs (in the background)
  when an account becomes eligible: email verified, password reset
  completed (which also verifies the email), or admin-created. A recorded
  payment is revoked only when HelloAsso returns that order without an
  Authorized payment, never merely because the fuzzy search omitted it.
- **Community** — `forum_threads`, `forum_replies`, `announcements`,
  `blog_posts`, `favorites`
- **Forum moderation** — members report a post (`POST /forum/report`: emailed
  to the admin address, nothing stored). An admin sees extra controls on the
  thread page (`user.isAdmin`) and can hide or restore a thread or reply
  (`POST /admin/forum/hide|restore`, `src/routes/admin/forum.js`, migration 044:
  `hidden_at`, `hidden_reason` = reason code plus optional ": note", `hidden_by`).
  The text stays in the row. `routes/forum.js` blanks hidden rows for members
  (the views show the "removed by the moderators" placeholder; a hidden first
  post hides the whole thread and its replies, and members cannot reply to
  it); admins see the original marked "Hidden: reason" with Restore. Hiding
  emails the author a statement of reasons (EU DSA art. 17, `lib/forumModeration.js`,
  author's `users.lang`, skipped if the account is gone, a failed send never
  blocks the hide) and writes `forum.hide` / `forum.restore` to the audit log
  with the kind and reason code only.
- **Charity vote** — `charity_rounds`, `charity_options`,
  `charity_votes`, `charities` (a reusable library), `charity_ideas`
  (member-submitted, admin-reviewed)
- **Volunteering & meetings** — `volunteer_shifts`, `volunteer_signups`,
  `meetings`, `meeting_rsvps`
- **Public events & classes** — `events`, `event_signups`, `classes`,
  `class_signups`, `class_dropin_seats`
- **Unused, left in place** — `event_rsvps` (superseded by
  `event_signups`; see [README.md](README.md))

## Environment variables

Every setting the app, its scripts and the GitHub workflows use is declared **once**, in
[`src/lib/configRegistry.js`](src/lib/configRegistry.js) (name, kind, default, secret or not, where it is set, one
line of documentation, and the variable's own parsing rule). That registry is the single source for:

- the code: `src/lib/config.js` (`config.get("NAME", env)`; `env` defaults to `process.env` and is injectable in
  tests) is the only place that reads the environment, and a value that is set but unusable (so the default is
  used) is reported at boot with one `[config] WARNING` line per variable, never an email and never a secret;
- the three tables below and the whole of [.env.example](.env.example), regenerated by `npm run docs:env`;
- the launch checks in `src/lib/env.js` (`required`, `group`).

Do not edit the tables below or `.env.example` by hand. `test/unit/envInventory.test.js` fails when code reads a
variable directly, names one the registry does not know, or when either document is stale; the step-by-step is
in `docs/runbook.md`, section al ("Adding or changing a setting"). The number and on/off rules differ from
variable to variable on purpose (they are the rules each one always had, pinned by
`test/unit/configEquivalence.test.js`), so read the entry before assuming `0`, `off` or an empty value means the
same thing everywhere.

"Where set" says exactly which store holds the value:

- **Render env var** = Render dashboard > umas-books > Environment (production)
  or umas-books-staging. `render.yaml` / `render.staging.yaml` list most of
  them: `value:` = plain value kept in the repo; `generateValue` = Render makes a
  random one; `sync: false` = typed by hand in the dashboard, never stored in the
  repo and never overwritten by a Blueprint sync.
- **Local `.env`** = your own machine only (copy `.env.example`).
- GitHub values (`GitHub repository variable` = Settings > Secrets and variables
  > Actions > **Variables** tab, not secret; `GitHub secret` = same page,
  **Secrets** tab) are listed in the second table below.

### Required

<!-- env-required:start (GENERATED by `npm run docs:env` from src/lib/configRegistry.js: edit the registry, not this table) -->
| Variable | Secret? | Where set | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | Render env var, `sync: false`, **set by hand** to the database's Internal Database URL (staging: `fromDatabase` in `render.staging.yaml`); local `.env`. Rotation: runbook "Rotating the database password" (section b) | Postgres connection string. The app (`src/db.js`) refuses to start without it. See [Migration process](#migration-process) for TLS |
| `SESSION_SECRET` | yes | Render env var (`generateValue: true`); local `.env` | Signs the session cookie. The app refuses to start without it |
| `TOTP_ENCRYPTION_KEY` | yes | Render env var (`generateValue: true`) | **Required in production** (`src/lib/env.js` fails the boot without it). Encrypts admins' two-step secrets at rest (`src/lib/totp.js`). Outside production it falls back to a key derived from `SESSION_SECRET`. Changing it makes enrolled admins re-enrol, so set it once |
<!-- env-required:end -->

### Optional, with their defaults

<!-- env-optional:start (GENERATED by `npm run docs:env` from src/lib/configRegistry.js: edit the registry, not this table) -->
| Variable | Secret? | Default | Where set | What it does |
|---|---|---|---|---|
| `NODE_ENV` | no | development | Render env var (`production`); local `.env` | `production` turns on startup env validation (`src/lib/env.js`: lists every missing required var, warns about disabled email/payments), secure cookies, mandatory admin 2FA, and `src/lib/baseUrl.js` requiring `APP_BASE_URL`/`RENDER_EXTERNAL_URL` |
| `PORT` | no | 3000 | Render sets it; local `.env` | HTTP listen port |
| `PGSSLMODE` | no | TLS on (`rejectUnauthorized: false`) | local `.env` (`disable`) | `disable` for a local Postgres without TLS; anything else keeps TLS (`src/db.js`) |
| `DB_POOL_MAX` | no | 20 (allowed 2 to 50) | Render env var, optional | Size of the Postgres connection pool (`src/lib/dbConfig.js`). Render allows 100 connections and a deploy runs two instances |
| `APP_BASE_URL` | no | none | Render env var (`https://umasbooks.org`, plain value in `render.yaml`) | The public address, no trailing slash. The only base URL used on a live site: emailed links, payment return URLs, sitemap; other Hosts are redirected to it (`src/middleware/canonicalHost.js`), other methods on another Host get 421 except `/healthz` and `/webhooks/helloasso` |
| `RENDER_EXTERNAL_URL` | no | none | Set by Render itself | Fallback for `APP_BASE_URL` when that is unset |
| `APP_ENV` | no | none | Render env var (`staging` in `render.staging.yaml`) | `staging` marks the test site: red TEST SITE banner, noindex, mail only to `STAGING_MAIL_TO`, boot guards (`src/lib/staging.js`) |
| `PRODUCTION_DATABASE_HOST` | no | none | Render env var on **staging**, `sync: false` | The production database's host name. Staging refuses to start if this is empty or its `DATABASE_URL` points at that host. Also used by the demo-data script |
| `STAGING_MAIL_TO` | no | none | Render env var on **staging**, `sync: false` | The only mailbox the test site may send to (`src/lib/staging.js`); required there |
| `PREVIEW_MODE` | no | off | Render env var, set by hand, deliberately **not** in `render.yaml` | `true`, `1`, `on`, `yes` or `enabled` (any case) turns on [preview mode](#preview-mode): coming-soon banner, payments off, search engines kept out. `false`, `0`, `off`, `no`, `disabled` or empty means off. **Any other value (a typo) counts as ON** (fail closed: a safe, closed site) with a loud boot warning and a launch alert |
| `SITEMAP_BOOKS_PER_FILE` | no | 10000 | tests only (not set on Render) | In-stock books per `/sitemap-books-N.xml` file (2 URLs each, so 20,000 URLs, under the 50,000 limit); capped at 10000. Lets tests use small files (`src/routes/seo.js`) |
| `TRUST_PROXY_HOPS` | no | 2 in production, 1 elsewhere | Render env var (`"2"` in both yaml files) | Integer 1 to 5: reverse proxies in front of the app (Render's edge plus its internal proxy = 2; no Cloudflare). Decides `req.ip` (`src/lib/trustProxy.js`); check on `/admin/diagnostics/client-ip`. A CDN added later changes this |
| `GMAIL_USER` | no | none | Render env var, `sync: false` (staging: a separate Gmail account); local `.env` | Outgoing mail (resets, verification, contact form, every alert). Unset: dev/tests log instead of sending, **production throws** so the outbox keeps and retries the message |
| `GMAIL_APP_PASSWORD` | yes | none | Render env var, `sync: false` (staging: a separate Gmail account); local `.env` | Outgoing mail (resets, verification, contact form, every alert). Unset: dev/tests log instead of sending, **production throws** so the outbox keeps and retries the message |
| `CONTACT_TO` | no | `admin@umasbooks.org` | Render env var (plain value) | Where the Contact form and forum reports deliver; one address or several separated by commas |
| `ALERT_TO` | no | falls back to `CONTACT_TO`, then `admin@umasbooks.org` | Render env var (plain value) **and** the GitHub repository variable of the same name (keep the two equal) | Where every site alert goes (errors, failed/stuck email, failing jobs, launch warnings); comma separated list |
| `MAIL_GLOBAL_PER_HOUR` | no | per-kind caps in `THROTTLE.globalPerHour` (`src/lib/outbox.js`) | Render env var, optional (tests set a high value) | Overrides the shop-wide hourly cap on throttled mail kinds (signup, verification, password reset, book requests) with one positive number |
| `SEED_ADMIN_EMAIL` | no | `admin@umasbooks.org` | Render env var, `sync: false`; local `.env` | Email of the first admin created by `npm run seed`. Never blocks startup. |
| `SEED_ADMIN_PASSWORD` | yes | none | Render env var, `sync: false`; local `.env` | Password of the first admin: required only the first time `npm run seed` runs (it creates the admin if none exists). Never blocks startup. Delete it afterwards. |
| `SEED_SAMPLE_CONTENT` | no | off | local / CI | `true` forces the seed to add sample content. |
| `SEED_STRICT` | no | off | local / CI | `true` makes a seed failure exit 1 (CI). |
| `ADMIN_2FA_REQUIRED` | no | required | tests / local only | `false` switches admin two-step off, **ignored when `NODE_ENV=production`** (`src/middleware/auth.js`). Tests set it |
| `ADMIN_SESSION_IDLE_HOURS` | no | 8 (allowed 0.25 to 72) | Render env var, `sync: false` | Admin and till accounts are signed out after this long idle (`src/lib/adminSession.js`; runbook section ab) |
| `ADMIN_SESSION_MAX_DAYS` | no | 7 (allowed 1 to 30) | Render env var, `sync: false` | Admin and till accounts are signed out this long after login even if active |
| `ANON_SESSION_LIMIT` | no | 60 per IP per 10 minutes | tests only | Stored guest sessions per IP (`src/lib/anonSessionGuard.js`). For the local end-to-end run; leave unset on the live site |
| `ANTHROPIC_API_KEY` | yes | none | Render env var, `sync: false` | Powers photo-scan, AI book descriptions (English), the Translate to French buttons (blog, collections, events...) and genre suggestions |
| `ANTHROPIC_WORKSPACE_ID` | no | none | Render env var, `sync: false` | Optional workspace header on Anthropic calls |
| `MIGRATE_LOCK_TIMEOUT_MS` | no | 5000 (5 seconds; at least 100) | Render environment variable, optional (Render > `umas-books` > Environment) | How long ONE migration waits for a table lock before giving up and retrying (`src/migrate.js`; runbook "When a deploy fails because a migration could not get a lock") |
| `MIGRATE_LOCK_RETRIES` | no | 5 (`0` = no retry) | Render environment variable, optional (Render > `umas-books` > Environment) | How many times a migration file is retried, with growing pauses, when it fails because a lock was not available (`src/migrate.js`). Still locked after that: the deploy fails and the old version keeps serving |
| `DB_PLAN_STORAGE_MB` | no | 0 (= unknown: sizes are shown, no warning) | Render environment variable, optional (Render > `umas-books` > Environment) | The storage limit of the database plan in megabytes (Render > the database > Info). With it set, the weekly database size check warns at 70% and again at 90% (`src/jobs.js`; admin Diagnostics > Database size; runbook "Database size monitoring") |
| `AI_DAILY_MAX_CALLS` | no | 600 (`0` = AI off) | Render env var, `sync: false` | Most Anthropic calls a day for ALL AI features together, counted from the database (`src/lib/aiLimits.js`; runbook "AI limits"). Resets at midnight Paris time |
| `PRICING_AI` | no | off (on only for `1` or `true`) | Render env var, `sync: false` | Turns on the AI market check behind price suggestions (also needs `ANTHROPIC_API_KEY`) |
| `PRICING_AI_MODEL` | no | the description model | Render env var, `sync: false` | Model for the market check; must support the web search tool |
| `PRICING_AI_DAILY_MAX` | no | 150 (`0` = off) | Render env var, `sync: false` | Most AI market lookups a day; part of `AI_DAILY_MAX_CALLS` |
| `NYT_API_KEY` | yes | none | Render env var, `sync: false` | New York Times Books API key; enables verified best-seller rows. Never logged |
| `AWARDS_LOOKUPS` | no | on | Render env var, optional | `off` (also `0`, `false`) stops all awards lookups |
| `COVER_BACKFILL` | no | on | Render env var (`"on"` in `render.yaml`); tests set `off` | `off` stops the background job that copies covers to our own server. Only a 404, placeholder or invalid image counts as a failed attempt; 3 in a row stop the batch |
| `GOOGLE_BOOKS_API_KEY` | yes | none | Render env var, `sync: false` | Higher Google Books quota for the ISBN lookup (covers from Google are not used, see the cover-source decision) |
| `ISBNDB_API_KEY` | yes | none | Render env var, `sync: false` | ISBNdb key (paid): last-resort book lookup and the price suggestion. Unset = not used |
| `ISBNDB_API_BASE` | no | ISBNdb's production API | optional | Must be an `https://...isbndb.com` address, else ignored with a warning (the key is never sent elsewhere) |
| `ISBNDB_MIN_INTERVAL_MS` | no | 1000 | optional | Minimum gap between ISBNdb calls (`src/lib/bookSources.js`) |
| `ISBNDB_PRICE_TIMEOUT_MS` | no | 6000 | optional | Timeout for one ISBNdb price call (`src/lib/isbndbPrice.js`) |
| `ISBNDB_PRICE_TTL_MS` | no | 3 days | optional | How long an ISBNdb price answer is cached |
| `ISBNDB_DAILY_MAX_CALLS` | no | 500 (`0` = no paid calls) | Render env var (Render > Environment; not in `render.yaml`) | Most paid ISBNdb requests per Paris day (title fallback and price suggestion together), counted atomically in `ai_daily_cap` (scope `isbndb`, `src/lib/bookSources.js`). At the cap the call is skipped (no error, no email) and the price suggestion says "daily limit reached"; today's count is on Admin > Diagnostics > Book lookup sources |
| `SCAN_LOOKUP_SOURCES` | no | `openlibrary,bnf,google,openlibrary-data,isbndb` | optional | Comma list of lookup sources the scan screen uses, in order (`src/lib/bookLookup.js`) |
| `SCAN_CACHE_TTL_MS` | no | 600000 (10 minutes; `0` = off) | optional | How long a scan lookup result is cached (`src/lib/bookLookup.js`) |
| `SCAN_NEGATIVE_TTL_MS` | no | 120000 (2 minutes) | optional | How long a "not found" is cached |
| `SCAN_LOOKUP_TIMEOUT_MS` | no | 4000 | optional | The whole book lookup is given up after this long |
| `SCAN_LOOKUP_HEDGE_MS` | no | 1500 (`0` = off) | optional | Start the second source if the first has not answered by then |
| `SCAN_LOOKUP_GRACE_MS` | no | 300 | optional | Wait for slower sources this long after the first titled result |
| `SCAN_COVER_WAIT_MS` | no | 1200 | optional | Budget for the cover copy on the Add a book screen (`src/routes/admin/inventoryLookup.js`). |
| `SCAN_PRICE_WAIT_MS` | no | 3000 | optional | Budget for the price suggestion on the Add a book screen (`src/routes/admin/inventoryLookup.js`). |
| `SCAN_SLOW_LOG_MS` | no | 1500 (`off` disables) | optional | Log a scan lookup slower than this (`src/lib/timing.js`) |
| `DASHBOARD_COUNTS_CACHE_SECONDS` | no | 30 in production, 0 elsewhere | optional | How long the admin dashboard's slow counts are cached; `0` turns the cache off |
| `TILL_MAX_VOIDS_PER_DAY` | no | 3 | optional | Voids a non-admin till user may make per day (`src/lib/till.js`) |
| `FISCAL_YEAR_START_MONTH` | no | 1 | GitHub repository variable (read by `scripts/export-accounting-month.js` in the workflows) | Month the financial year starts, for the monthly accounting export |
| `HELLOASSO_CLIENT_ID` | yes | none | Render env var, `sync: false` | HelloAsso API credentials, membership only. Unset: the membership sync is off |
| `HELLOASSO_CLIENT_SECRET` | yes | none | Render env var, `sync: false` | HelloAsso API credentials, membership only. Unset: the membership sync is off |
| `HELLOASSO_ORG_SLUG` | no | none | Render env var, `sync: false` | HelloAsso API credentials, membership only. Unset: the membership sync is off |
| `HELLOASSO_API_BASE` | no | production API | Render env var (`sync: false`; staging sets the sandbox URL in the yaml) | HelloAsso's sandbox URL for testing. Staging refuses to boot with credentials but no sandbox address |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` | no | any Membership-type form | Render env var, `sync: false` | Only orders of this HelloAsso form (`formSlug`) grant membership |
| `DEMO_ALLOW_LOCAL` | no | none | local shell only | Demo-data script (`src/lib/demoData.js`): `1` allows a run against a local database. Staging or localhost only. |
| `DEMO_CONFIRM` | no | none | local shell only | Demo-data script: `yes` skips the `--yes` prompt. |
| `DEMO_PASSWORD` | no | none | local shell only | Demo-data script: the fixed password of the demo accounts (a throwaway). |
| `TZ` | no | `Europe/Paris` | forced by the code | `src/lib/tz.js` sets it at start (`TZ` is read only to detect a difference); never needed in Render |
| `CI` | no | none | CI / developer scripts | Set by GitHub Actions; the sitemap crawler adds `--no-sandbox` to Chrome when it is set. |
| `GITHUB_OUTPUT` | no | none | CI / developer scripts | Set by GitHub Actions; the accounting export writes its step outputs there. |
| `DEBUG_BLOBS` | no | none | CI / developer scripts | Debug switch of one image tool in `scripts/`; nothing to configure. |
| `DUMP_FILE` | no | `/tmp/i18n-fr-dump.txt` | CI / developer scripts | Output path of `scripts/i18n-audit.js` (French dump); nothing to configure. |
| `DUMP_EN_FILE` | no | `/tmp/i18n-en-dump.txt` | CI / developer scripts | Output path of `scripts/i18n-audit.js` (English dump); nothing to configure. |
<!-- env-optional:end -->

`render.yaml` lists the production variables a rebuild needs (secrets as
`sync: false`), except `PREVIEW_MODE`, which is deliberately left out.
`render.staging.yaml` lists the staging set.

### GitHub Actions values (not read by `src/`)

The workflows in `.github/workflows/` use these; none is set in Render except
where noted. **Secret** = Secrets tab, **Variable** = Variables tab.

<!-- env-github:start (GENERATED by `npm run docs:env` from src/lib/configRegistry.js: edit the registry, not this table) -->
| Name | Kind | Used by | What it is |
|---|---|---|---|
| `DATABASE_URL` | GitHub secret | nightly backup, inventory export, accounting export | Production database's **External** URL (the Internal URL does not work from GitHub) |
| `GMAIL_USER` | GitHub secret | every workflow that mails an alert | Same Gmail sender as the site |
| `GMAIL_APP_PASSWORD` | GitHub secret | every workflow that mails an alert | Same Gmail sender as the site |
| `ALERT_TO` | GitHub repository variable | every alert | Keep equal to the Render value |
| `FISCAL_YEAR_START_MONTH` | GitHub repository variable | accounting export | Month the financial year starts (1 to 12), for the monthly accounting export |
| `ACCOUNTING_TO` | GitHub repository variable | accounting export, nightly backup | Where the monthly accounting export goes |
| `BACKUP_S3_KEY_ID` | GitHub secret | backup, restore test, freshness, exports | Backblaze B2 application key (id) |
| `BACKUP_S3_APPLICATION_KEY` | GitHub secret | backup, restore test, freshness, exports | Backblaze B2 application key (secret part) |
| `BACKUP_S3_BUCKET` | GitHub repository variable | backup, restore test, freshness, exports | Backblaze bucket location (name) |
| `BACKUP_S3_ENDPOINT` | GitHub repository variable | backup, restore test, freshness, exports | Backblaze bucket location (endpoint) |
| `BACKUP_S3_REGION` | GitHub repository variable | backup, restore test, freshness, exports | Backblaze bucket location (region) |
| `BACKUP_S3_PREFIX` | GitHub repository variable | backup, restore test, freshness, exports | Backblaze bucket location (key prefix) |
| `BACKUP_AGE_RECIPIENT` | GitHub repository variable | nightly backup | Public `age` key backups are encrypted to |
| `BACKUP_AGE_IDENTITY` | GitHub secret | restore test | Private `age` key (decrypts backups for the drill) |
| `SITE_URL` | GitHub repository variable | uptime check | Address the check pings |
<!-- env-github:end -->

The Node version is not an environment variable: it is pinned to an exact patch version (currently `22.23.4`) in `umas-books/.node-version`, which the workflows read (`node-version-file`) and Render uses; `package.json` `engines` says `22.x`. The minimum safe version per major is in `src/lib/nodeVersion.js`; the running version is shown on Admin > Diagnostics (client IP page) and warned about on the dashboard.

CI (`.github/workflows/ci.yml`) has its own throwaway values (a Postgres
service container, a dummy `SESSION_SECRET`, etc.): see that file.

## Preview mode

- **Preview mode** (`PREVIEW_MODE=true`, parsed by `isPreviewMode()` in
  `src/lib/preview.js`; a middleware mounted early in `src/app.js` sets
  `res.locals.preview`) is for showing the site, with sample data only, before
  it opens. Off by default. While on:
  - every customer page shows a bilingual banner (`views/partials/preview_banner.ejs`,
    included by `partials/mkt_chrome_header.ejs`; marketing pages also get the strings
    in `assets/i18n-common.js` COMMON `preview.*`), linking to `/contact?topic=feedback`
    (the contact form then offers a "Feedback on the preview" topic);
  - reservations and payments are off: the cart shows a notice instead of the
    reserve form, `POST /cart/reserve` answers 403 before locking or creating
    anything (drop-in seats use the same route), and the membership page shows
    "Membership opens at launch" instead of the HelloAsso widget. The webhook
    and membership sync jobs are untouched (no payment can start);
  - search engines are kept out: `X-Robots-Tag: noindex, nofollow` on every
    response, a robots meta tag, `/robots.txt` disallowing everything and an
    empty `/sitemap.xml`;
  - the admin header shows a red reminder that preview mode is on.
- To launch, delete the variable in Render: see the runbook, "Launching: turn
  preview mode off".
- **Launch guards** (preview off, `src/lib/env.js`): warn at boot and send one
  alert email when `APP_BASE_URL` is missing or not https, `HELLOASSO_API_BASE`
  is the sandbox, or the HelloAsso credentials are missing (`CONTACT_TO` missing
  only warns); the site keeps running. Sandbox also shows a red banner on every
  admin page (`res.locals.helloassoSandbox`, `lib/preview.js`).

## Process lifecycle and operations

- **Startup checks** (`src/lib/env.js`, production only): called first thing
  in `src/index.js` (the entry), before `db.js` and `src/app.js` load. Missing `DATABASE_URL` /
  `SESSION_SECRET` → one error naming all of them, exit 1. Unset Gmail,
  HelloAsso, base-URL or `ALERT_TO` variables → a loud `[env] WARNING` line, since
  those features otherwise fail silently (no Gmail also means no error-
  alert emails). A live-site misconfiguration also raises a launch alert, at
  most once per 24 h each (`alert_flags`), and a red banner on every admin page.
  Test/dev are untouched.
- **Graceful shutdown** (`src/index.js`): SIGTERM/SIGINT call `jobs.stopAll()`
  (every job timer, including first-run delays not yet fired), then `server.close()` (in-flight requests, e.g. a
  HelloAsso webhook, are allowed to finish; idle keep-alive sockets are
  dropped), then `pool.end()`, then exit 0. A 10-second hard-exit timer
  exits 1 if requests do not drain. A listen failure (e.g. `EADDRINUSE`)
  logs a clear message and exits 1.
  Covered by `test/integration/gracefulShutdown.test.js`.
- **Background jobs** are tracked: `guardJob` records every run in the
  `job_runs` table (migration 081); three failures in a row send one alert,
  `/admin/diagnostics/jobs` shows the table, and the dashboard flags a job whose
  last success is older than 3x its interval (`src/lib/jobRuns.js`,
  `test/integration/jobRuns.test.js`).
- **Adding a background job is ONE edit**: add an entry to `jobSpecs()` in
  `src/jobs.js`:

  ```js
  {
    name: "My job",                 // the job_runs name: shown on /admin/diagnostics/jobs and in alerts
    label: "What it does, one sentence.",
    everyMs: 6 * 60 * 60 * 1000,    // the timer AND the "stale after 3x" check both come from this
    firstRunAfterMs: 5 * 60 * 1000, // 0 = at boot, N = N ms after boot (unref'd), omit = first interval tick
    enabled: process.env.MY_JOB !== "off", // optional env toggle (default true)
    run: async () => { await doTheWork(pool); },   // throw to fail; the guard logs, records and alerts
  },
  ```

  `schedule()` wraps it in `guardJob`, passes the same `everyMs` to the
  bookkeeping, starts the timers and registers them for `stopAll()` at shutdown.
  Never rename a job lightly: its history in `job_runs` is keyed by `name`. Other
  options: `steps: [{ name, run }]` (several tracked jobs on one timer),
  `track: false` (the run writes no row itself, it records sub-steps with
  `ctx.record`), `setup` (runs just before the first run is arranged). The
  registry is `createJobRegistry({ pool })` (`test/unit/jobs.test.js` checks
  unique names, positive intervals, the interval-to-bookkeeping wiring and
  `stopAll()`).
- **`src/index.js` is a thin entry, `createApp()` builds the app.** `src/app.js`
  exports `createApp()`: all middleware and routes in order, no `listen`, no
  timers, no process handlers (`test/unit/createApp.test.js`). `src/index.js`
  validates the environment, calls `createApp()`, listens
  (`configureServer`, keep-alive 65 s), sends launch alerts, `startJobs(pool)` and
  installs the shutdown handler. A test that needs the real app in its own
  process uses `startInProcessApp()` (`test/helpers/testApp.js`, port 0, no jobs;
  see `test/integration/createAppInProcess.test.js`); the existing integration
  tests still boot `node src/index.js` as a child process with `startTestApp`.
  `scripts/verify-startup-equivalence.js` boots two builds of `index.js` (a git
  ref and the working tree) against throwaway databases and diffs the middleware
  stack, timers, logs and shutdown; run it before and after any change to the
  entry point.
- **Monitoring and backups** (all GitHub Actions, independent of Render; every
  alert goes to the repository variable `ALERT_TO`, default admin@umasbooks.org; a
  weekly "Send a test alert" proves the channel; the restore test also checks
  the dump holds the till, shop, outbox and audit tables and the newest migration;
  the freshness check also watches the `monthly/` copy; every email goes through the one local
  composite action `.github/actions/send-alert-mail`, which holds the Gmail SMTP settings and the
  pinned mail action):
  `uptime-check.yml` polls `/healthz` every hour (Actions minutes are metered on a private repo) and emails once on
  the second consecutive failure and once on recovery;
  `nightly-db-backup.yml` uploads one complete `pg_dump` (image bytes
  included, login sessions excluded) to the private Backblaze B2 bucket and
  fails if the offsite settings are missing; `backup-restore-test.yml` downloads the newest
  dump from B2, restores it into a scratch postgres:18 monthly and checks it. The manual restore procedure
  is in [README.md](README.md#restoring-from-a-backup).

## Forms: Post/Redirect/Get (`src/lib/flash.js`, `src/lib/postRedirect.js`)

A POST that renders a page itself leaves a POST in the browser history, and Back then shows "Confirm form
resubmission". So every form handler, admin and customer, answers a refused or finished submission with a
`303` to a fixed GET path; the message (and what was typed) travels once in the session: `redirectWithFlash`
stores it (saved BEFORE the redirect, see `lib/session.js`), the page's GET reads it with `takePageFlash`
(once, dropped after 10 minutes, page never cached). Rules:

- Never put a password, a token, a recovery code or a two-step code in the flash or in a redirect URL; those
  fields come back empty. A redirect target is a fixed internal path (a `returnTo` only after `safeReturnTo`, a
  token only after `encodeURIComponent`).
- Messages are translated when the POST is handled (the language cookie is the same on the GET).
- Limiters that count only failures (`skipSuccessfulRequests`) can no longer read the failure from a 4xx
  status: the handler passes `{ counted: true }` (sets `res.locals.failedAttempt`) and the limiter uses
  `failureCounts` / `onlyMarkedFailures` from `middleware/rateLimits.js`. The generic limiter answer (429, plain
  text) is the one thing that still renders from a POST.
- Left as they are on purpose: JSON/`fetch()` endpoints (favourites, the till sale, HelloAsso webhook), file
  downloads, the 404 page for a forged id, and the page that shows two-step recovery codes right after a
  successful POST (the codes exist in plain text only there).
- `test/integration/adminPostRedirect.test.js` and `customerPostRedirect.test.js` scan every write route and
  fail when a new handler renders instead of redirecting (add it to the allow-list only with a reason).

## Where SQL lives

Rule: **SQL and business rules in `src/lib/`, routes read the request and answer** (parse, call lib, respond: JSON, redirect or render). `collections.js` + `lib/collections.js` is the model. A rule that lives in a lib function can be tested with the real database and no HTTP, and cannot drift between the routes that share it.

Done for the add-a-copy path (the money- and stock-critical one):

- `lib/inventoryIntake.js`: `parseIntakeInput` (pure: the form read and normalised), `prepareIntake` (pricing: fixed-price rule, 2-year rule, the first refusal in the order the form always gave), `saveBookAndCopy` (one-time token, cover photo, the book new or existing, the copy, clearance repricing and its audit entries), `afterSaveFollowUps` (awards, cover/description fill, customers' requests), `intakeAnswer` / `intakeRefusal` (what is answered or shown again).
- `lib/inventoryCopies.js`: edit a copy (`parseCopyEdit`, `priceCopyEdit`, `updateCopy`), `cancelReservation`, `deleteCopy`, `deleteBook`, and `learningFields` (shared with the intake).
- `routes/admin/inventory.js` keeps the list, lookup, show and edit-book routes as they were.
- `test/integration/intakeGolden.test.js` pins the HTTP behaviour (about 60 inputs: status, headers, body, rows, audit entries) from a fixture recorded before the move; `test/integration/inventoryIntake.test.js` tests the lib functions directly. Changing a rule on purpose means re-recording the fixture (`node scripts/record-intake-golden.js`) and saying so in the PR.

Not done yet (route files with the most inline queries, next candidates): `routes/auth.js` (36 `.query()` calls), `routes/admin/charity.js` (25), `routes/admin/members.js` (18).

## Password hashing (`src/lib/passwordHash.js`)

Every password is hashed and checked through this one module (signup placeholder,
login, reset, change password, 2FA enrolment, privacy re-check, admin add member,
seed, demo data).

- **Native `bcrypt`, cost 12.** Each hash/compare runs on libuv's thread pool, not
  on the event loop. The previous pure-JS `bcryptjs` spent ~200 ms of main-thread
  CPU per check, so a burst of logins froze every other request. Hashes are the
  same `$2a$/$2b$` format: stored hashes keep verifying, no rehash. Input over 72
  bytes is truncated by both libraries, as before. `needsRehash()` is there for a
  future cost bump.
- **Concurrency cap.** At most 2 bcrypt operations run at once (the pool has 4
  threads by default and also serves fs/dns/crypto), up to 20 more wait; beyond
  that the caller gets a `PasswordBusyError` and the person a friendly 503 with
  `Retry-After: 5` (`sendBusy`, also wired into `errorHandler`, no alert).
- **Unknown email on login** still does a real cost-12 compare against a fixed
  dummy hash (`compareDummy`), so response time does not reveal which emails exist.
- The native module ships prebuilt binaries (glibc and musl, so Render's Node 22
  needs no compiler). `bcryptjs` stays as a dependency only for `scripts/` and as
  the independent implementation in compatibility tests.
- Benchmark (not in CI): `PORT=4790 node scripts/bench-login-cpu.js` fires 12
  parallel failed logins and reports an unrelated endpoint's latency meanwhile.

## Two-step verification (admins)

TOTP (RFC 6238, any authenticator app), mandatory for admins, optional for
others. `lib/totp.js` (hand-rolled on `node:crypto`), `routes/twoFactor.js`
(setup at `/account/2fa`), login step `/login/2fa` in `routes/auth.js`.

- `requireAdmin` sends an admin without it to `/account/2fa?required=1`; the
  setup page is the only thing they can reach until they enrol.
- Login: the password only creates a 5-minute "pending" marker in the
  session; the code (or a one-time recovery code) completes it. Codes can't
  be replayed (`totp_last_step`). Wrong codes count against the account's
  normal lockout (`failed_login_attempts`), not just the session, so
  re-logging-in doesn't reset the guess budget. Enrolling needs the account
  password again.
- The secret is AES-256-GCM encrypted in `users.totp_secret_enc`, keyed from
  `TOTP_ENCRYPTION_KEY` (generated by render.yaml; required in
  production, with a `SESSION_SECRET` fallback only outside production). Changing that
  value makes everyone re-enrol, so set it once and don't rotate casually.
- Lost phone and recovery codes: another admin uses **Reset Two-Step** on
  Members. If the only admin is locked out, run in the Render shell:
  `UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE email='…';`
  then log in with the password and enrol again.
- Tests set `ADMIN_2FA_REQUIRED=false` (ignored when `NODE_ENV=production`).

## Personal data: erasure and retention

`src/lib/privacy.js` holds both halves. Most personal data is keyed by
**email**, not user id, so deleting a `users` row alone leaves it behind.

- `eraseMember(pool, userId)` (admin → Members → **Erase Member**): in one
  transaction deletes the account, its event/class sign-ups and sessions,
  releases any active book reservation (an open order reservation is cancelled and its items freed), and **anonymises** (never deletes)
  paid orders and HelloAsso membership payment rows, which French accounting law makes
  us keep for 10 years. Forum posts keep their text with no author name.
- `purgeExpiredPersonalData(pool)` runs at boot and daily from `src/jobs.js`:
  sign-ups 12 months after the event, expired reset/verification tokens
  after 7 days, orders and payment records after 10 years, accounts with no
  login for 3 years (never admins or current members) — emailed a warning
  first (`users.inactivity_warned_at`), deleted 30 days later unless they log
  in, which clears the warning (any signed-in request also counts as
  activity: `attachUser` refreshes `last_login_at` at most once a day).
  `orders.client_ip` (used by the old online checkout's abuse caps) is no longer
  written: reservations set it to NULL. The purge still clears old values after
  2 days (`clientIpDays`), and so does `eraseMember`.
  Stored copies of emails (`email_outbox`: recipient, subject, body) are
  erased 30 days after sending, 90 for ones that could not be sent
  (`outboxSentDays`/`outboxFailedDays`, step `emailOutbox`); `eraseMember`
  erases and cancels the rows for that address.
  Contact details on `book_copies` that are no longer reserved (sold or
  cancelled) and on `expired`/`cancelled` orders are removed after 30 days.
  The warning email is claimed (`inactivity_warned_at` set) before it is
  queued in the outbox (which owns the retry), so overlapping instances don't
  double-send. The `RETENTION` constants must match the privacy policy page.
- Admin audit log: `lib/audit.js` `audit(req, {action, targetType, targetId,
  detail})` appends to `admin_audit_log` (migration 040) from sensitive admin
  routes (member changes/erasure/2FA reset, deletes, bulk deletes, admin
  login), shown read-only at `/admin/audit`. It stores only the admin's id and
  email, the action and a numeric target id, never member emails, names or
  message text, and never throws. Purged after 12 months by
  `purgeExpiredPersonalData`; keep the privacy policy in step.
- Account switches (Member, Volunteer, Till, Admin, Deactivate): the form posts
  `desired=on|off` and `lib/accountRoles.js` `setAccountFlag` sets that exact value
  (idempotent: a double click or stale page cannot undo a change; no audit row when
  nothing changed; the audit detail has the old and new value). The last active admin
  cannot be demoted or deactivated: the check runs in the same transaction as the
  update, under a lock on every admin row, so two admins cannot remove each other.
- Right of access / portability: admin → Members → member detail →
  **Download data (JSON)** (`GET /admin/members/:id/export.json`, admin only,
  `no-store`) returns the account and everything held under its email or id
  (sign-ups, orders, membership payments, favorites, volunteer/meeting
  RSVPs, forum posts, charity votes/ideas, reservations). Columns whose name
  contains hash/token/secret/totp are never exported. Add a section there
  when a new table holds personal data. The privacy paperwork (register of
  processing, processor DPAs, breach log) is in `docs/privacy/`.
- Self-service: a signed-in member can download their own data or delete
  their own account at `/account/privacy` (`src/routes/accountPrivacy.js`).
  Both need the current password (wrong ones count toward one throttle,
  5 per 15 minutes per account); deleting also needs the typed word
  DELETE/SUPPRIMER, is refused for admins, emails a bilingual confirmation
  first (a failed send doesn't block it), then calls `eraseMember` and ends
  the session. The download uses `lib/memberExport.js`, shared with the admin
  export. Both write `member.self_export` / `member.self_erase` to the audit
  log with the member's id only (`actor_label` = `self`).
- Not automated: contact-form messages live in the Gmail inbox (the policy
  says they are kept until the sender asks us to delete them; the copy in
  `email_outbox` goes after 30 days), and server
  logs sit with Render. Log lines never contain emails.


## Clearing test data before launch

`npm run clear-test-data` (`scripts/clear-test-data.js`, logic in
`src/lib/clearTestData.js`, tests in `test/integration/clearTestData.test.js`;
steps for the maintainer in `docs/runbook.md`) removes test data from the
database. Layers: dry run by default (the whole job runs in a transaction that is
rolled back, so its counts are exact); a real run needs `--execute`,
`--confirm "DELETE TEST DATA FROM <db name>"` and `--i-have-a-backup`; refused
unless `PREVIEW_MODE` is on (`--allow-live` overrides); and, whatever any environment
variable says, refused when the **data** looks live (a closed till day, a paid /
refunded / collected order, a membership payment, a non-admin member / volunteer /
till account, more than 50 stocked books with any sale) or the host is
`PRODUCTION_DATABASE_HOST`: only `--i-know-this-is-the-live-database` plus
`--live-confirm "DELETE LIVE DATA ON <host> WITH <n> PAID ORDERS AND <n> MEMBERS"`
(the counts it found) gets past that; unknown flags refused;
one transaction of plain `DELETE`s in foreign-key order (no `TRUNCATE ... CASCADE`);
sanity checks (admins, 2FA, recovery codes, `pricing_settings`, `schema_migrations`,
kept content unchanged) roll back on any difference; sequences are restarted only
for tables left empty.

**Every table must be classified** in `TABLES` (`shop`, `people`, `logs`, `content`,
`kept`). The script refuses to run on a database with an unclassified table and a
test fails when a migration adds one, so a new table cannot be forgotten: when you
add a table, classify it there and, if it holds rows to delete, add it to
`buildPlan()` in foreign-key order. Always kept: admin users (with 2FA and recovery
codes), their sessions, `pricing_settings`, `schema_migrations`.
Content is kept unless `--include-content`; non-admin accounts are kept with
`--keep-members`.

## The blog (server-rendered, English and French)

- **Pages** (`src/routes/blogPages.js`, views `marketing/blog.ejs`, `blog_post.ejs`, `partials/blog_card.ejs`): `/blog.html` (24 posts a page, real `?page=N` links; `public/page-blog.js` only turns "Show older posts" into an in-page load by fetching the next HTML page), `/blog/<slug>` and their `/fr/` twins (`lib/frUrls.js` treats `/blog/<slug>` as a public path). The post's whole sanitised body is in the HTML, with its own title, description, canonical, hreflang, Open Graph / Twitter tags, `BlogPosting` + `BreadcrumbList` JSON-LD and previous / next links. `/blog.html?post=<slug>` is a 301 to `/blog/<slug>`. The marketing header partial takes `ogType`, `ogImage`, `ogLocale`, `metaProps` and `robots` for this.
- **One rule for "public"** (`src/lib/blogPosts.js`): `status = 'published' AND published_at <= now()`; an admin with `?preview=1` sees everything (noindex, `no-store`, a note). The JSON feed (`routes/blog.js`), the pages, the sitemap and the admin status all use it.
- **French**: nullable `title_fr`, `excerpt_fr`, `body_fr` (migration 096), one slug for both languages. `frenchState()`: *missing* (nothing), *ready* (title and body, and an excerpt when the English post has one), *draft* (anything in between). Only *ready* French is shown. Otherwise `/fr/blog/<slug>` shows the English text inside `lang="en"` elements under the notice "Cet article n'est disponible qu'en anglais", its canonical points at the English address and there is no `fr` hreflang; lists mark such posts with a small "EN" tag. Bodies (both languages) pass the same sanitize-html allowlist on write and on read.
- **Sitemap**: `/sitemap-blog.xml` (listed in `/sitemap.xml`): published posts, `lastmod` = `updated_at`; a post with ready French gets both addresses with `en`/`fr`/`x-default` alternates, others only the English one. Empty in preview mode like the other files; any admin POST to `/admin/blog` drops the cached copy.
- **Books have no French text** (Sharon, 2026-10-28): a book's description and genres are English only. The French site shows them marked `lang="en"` (`views/book_detail.ejs` via `bookText()`, the collection genre line, the Browse genre buttons); `lib/genres.js` returns the English genres in both languages and `lib/bookSeo.js` uses the English description for the meta description and the JSON-LD. Nothing generates, translates, fills or stores a French description or genre (the old `POST /admin/inventory/translate-french`, `public/book-french.js`, `translateDescriptionToFrench*`, `translateGenresToFrench` / `COMMON_GENRES_FR` / `GENRE_ALIASES_FR` and `src/backfillFrenchContent.js` are removed; posted `genreFr` / `descriptionFr` fields are ignored). Migration 107 copied the old values into `book_french_backup` (book_id, description_fr, categories_fr, saved_at; `shop` for the test-data script, it follows the books) and set `books.description_fr` / `categories_fr` to NULL (the columns are kept, unused), with one Admin activity line `books.french_removed`; restore recipe in docs/runbook.md section aq (tested by `test/integration/removeFrenchBookContentMigration.test.js`).
- **Translate to French** (`lib/blogTranslate.js`, `POST /admin/blog/translate`, `public/blog-translate.js`): one call of `askText` (shared daily cap, 10 a minute per admin) returns title / excerpt / body to the form; nothing is saved or published by it, and the returned body is sanitised.

## French versions of events, sessions, announcements and charities

Same conventions as the blog (migration 097, nullable columns next to the English ones, English never changed):

- **Columns**: `events` (`title_fr`, `description_fr`, `location_fr`), `classes` (`title_fr`; the session's other fields are not shown to customers), `announcements` (`title_fr`, `excerpt_fr`, `body_fr`), `charities` (`description_fr`; names stay as they are), `charity_rounds` (`title_fr`). No table added, so `clearTestData` is unchanged. Meetings and volunteer shifts are members-only working notes and were left out on purpose.
- **One module** `src/lib/frenchText.js`: `SPECS` says per kind which fields are *needed* for the French to be **ready** (event: title, plus the description when the English has one; session: title; announcement: title and body, plus the excerpt when the English has one; charity: the description when the English has one; vote: title), `frenchState()` returns missing / draft / ready, `localize(kind, row, lang)` returns a copy of the row whose fields hold the French text only for `lang === 'fr'` and a *ready* row (`frLang`, `fallback`, and the English originals as `<field>_en`), `readFrench()` reads the admin form (blank -> NULL, HTML sanitised). An HTML text (announcement body) is sanitised on write and again on read.
- **Pages**: `/events` (+ `/events/:id/ics`, in the visitor's language), `/sessions`, `/dashboard` and `/announcements` (members, `req.lang`), `/charity` localize their rows in the route; the views print `title`/`description` as before and add `lang="en"` and a small "EN" tag (with a spoken French note) when `fallback` is true; an event card also shows the note "Cet événement n'est décrit qu'en anglais". `GET /api/events/upcoming?lang=fr` does the same and every event carries `lang`; `public/page-events.js` (marketing Events page) asks in the page's `<html lang>`. A session's colour keeps following the English title (`title_en`).
- **Drop-in lines**: `lib/orderItems.js` (`orderItemLabel`) uses `classes.title_fr` for a French reader (page or e-mail, from `orders.lang`) and the English title otherwise; the cart page does the same from `titleFr`. `order_items.item_title` (the accounting record) is always written in English.
- **Admin**: the shared partial `views/partials/admin_french_fields.ejs` (French version box with the status label and the button) is used by the events, sessions, announcements and charity editors; lists show the French status. **Translate to French**: `POST /admin/translate-french/:kind` (`routes/admin/frenchText.js`, `lib/frenchTranslate.js`, `public/french-translate.js`): one `askText` call (shared daily cap, 10 a minute per admin), fills only the form, never saves, sanitises HTML, audit entry `french.translate` (counts only).

## Languages

Everything customers and members see must be available in French (admin
screens stay English). Two languages only: `en` and `fr`.

- **Cookie.** `assets/site.js` (the EN/FR toggle) writes `umasbooks_lang=fr|en`
  (1 year, `Path=/`, `SameSite=Lax`, `Secure` on https) whenever the language is
  applied, and repairs a missing/different cookie from localStorage
  (`umasbooks.lang`) on page load.
- **Middleware** `src/middleware/lang.js` (mounted before `attachUser`, headers
  only: no session, no DB). `req.lang` is `fr` only when the cookie is exactly
  `fr`; with no cookie, the first `Accept-Language` tag decides (`fr*` is
  French); otherwise `en`. It sets `res.locals.lang` / `htmlLang`,
  `req.langFromCookie`, `req.frPrefix`, `req.tr` and `res.locals.tr`, and replaces the date
  helpers in views with French-aware ones (`fr-FR` / `en-GB`, still Europe/Paris;
  also `formatDateLong`, "3 octobre 2026"). `app.locals` dates stay en-GB for
  non-request callers such as emails. Every HTML response (and anything marked
  `Cache-Control: public`) gets `Vary: Accept-Language, Cookie` next to
  compression's `Accept-Encoding`; redirects do not (static assets are mounted
  earlier and untouched). Cache-Control itself is left as each route set it.
- **French addresses (`/fr/`).** The same public pages exist under `/fr/`, always
  French whatever the cookie or `Accept-Language` say, so search engines (which send
  neither) can index them. `src/lib/frUrls.js` is the one rule: `isPublicPath()` lists the
  pages with a twin (`/`, the marketing pages and their extensionless forms, `/contact`,
  `/events`, `/sessions`, `/request-a-book`, `/books/:id`). The language middleware strips
  the prefix from `req.url` (so each page's own route answers; `req.originalUrl` keeps
  `/fr/`), sets `req.frPrefix`, and writes `umasbooks_lang=fr` for a human visitor (not for
  crawlers). `/fr` 301s to `/fr/`; any other `/fr/...` (admin, cart, login, api, POSTs,
  typos) matches no route and is a French 404. Unprefixed addresses stay English-first and
  keep honouring the cookie / `Accept-Language` with no redirect, but their
  `rel="canonical"` is the language-specific address and every public page carries
  `hreflang` `en`, `fr` and `x-default` (English) alternates (`res.locals.seoUrls()`, read by
  both `<head>` partials), `og:locale`, and JSON-LD `inLanguage`. `sitemap.xml` lists both
  addresses of every page with `xhtml:link` alternates (still empty in preview/staging; the
  preview `noindex` applies to `/fr/` too). Forms, `/api/` and every private area exist once,
  unprefixed: a French page posts to the normal URL, and `res.redirect` sends a French
  visitor to the `/fr/` twin of a public target (permanent 301s only on a `/fr/` request,
  so a cache never keeps a language-dependent redirect).

  Crawler-facing details (`src/routes/seo.js`, `views/partials/header.ejs`): the app pages'
  canonical comes from a normalised path (`canonicalPathOf`: lower case, no trailing slash,
  so `/Events` and `/events/` name `/events`); `robots.txt` (live only) disallows `/api/` but
  allows the public JSON that fills the blog, shelves and events (`/api/blog/`, `/api/books`,
  `/api/events/`) and keeps `/api/books/by-ids` blocked; per-user `/favorites` passes
  `noindex: 'follow'` (`noindex, follow`, no canonical, not in the sitemap); a page with no
  `description` of its own shows the site default, so every listed page passes one; the book
  page passes `fullTitle` (`Title by Author — Uma's Books and Adventures`, French `de`/`d’`,
  clipped near 60 characters; French pages curl the brand's apostrophe like all text); the home JSON-LD (`views/marketing/index.ejs`) reads telephone and `sameAs` from
  `lib/legal.js`; `/favicon.ico` serves `public/favicon-32x32.png`. Static files: a `?v=<hash>`
  URL is `immutable` for a year, a bare one 7 days (`lib/assetUrl.js`, also `/logo.png`);
  `/img/<sha256>` is always immutable. Preview output (`Disallow: /`, empty sitemaps,
  `noindex, nofollow`) is pinned by `test/integration/seoQuickWins.test.js`.
  Links: on a `/fr/` page the server rewrites `<a href="/public-page">` to `/fr/...` after
  rendering (`prefixLinks()` in `frenchTypography.js` / `pageDictionary.js`; forms, assets and
  the toggle are left alone), and `assets/site.js` does the same for what it writes in the
  browser (dictionary text, book and event cards; `test/unit/frUrls.test.js` keeps its copy of
  the rule in step). Marketing views use root-relative asset paths (`/assets/img/...`) because
  a relative one would resolve under `/fr/`.
- **The EN | FR toggle** is two real links (`/x` and `/fr/x`, query string kept) on pages with a
  twin, so it works without JavaScript; clicking one stores the choice in the cookie and
  localStorage. Pages without a twin (cart, login, account...) keep two buttons that store the
  choice and reload. On a `/fr/` address site.js always starts in French, whatever was stored.
  Without JavaScript the FR link works (the `/fr/` visit writes the cookie) but EN cannot override a French cookie,
  so the "JavaScript is needed to change language" note stays in the header on every page. A `/fr/` address that
  is no page (a French 404) gets a toggle whose EN link goes home.
- **Translate a view:** `<%= tr('English', 'Français') %>`, with placeholders
  `<%= tr('Hello {name}', 'Bonjour {name}', { name: user.displayName }) %>`
  (French falls back to English if empty; `<%= %>` does the HTML escaping).
  Attributes, `<title>` and `alt` text count too. Server messages:
  `req.tr('English', 'Français')`. Do not use `data-fr-text` for new work.
- **Calendars:** public calendar routes pass `req.lang` to `resolveCalendarRange(query, weekStartsOn, lang)` so
  month/week labels are French ("Mai 2092", "12–18 mai 2092"); admin calendars omit it and stay English.
  The contact page no longer uses `contact-i18n.js`; its topics are stored in English and labelled in the view.
- **Emails:** `emailTr(lang)` from `src/lib/lang.js` returns `(en, fr) => string`.
  The language is stored on `users.lang` (set at signup, refreshed at each login
  when the person has chosen a language; NULL for admin-created accounts) and
  `orders.lang` (set when reserving). The reservation
  confirmation, reminders and inactivity warning follow it (the legal block and seller
  lines of the order email are French only in a French mail; the English mail keeps the
  bilingual block); French mail text gets the same no-break space before `; : ! ? »` as
  the pages (`emailTr()` applies `frenchPlainText()`); `sendResetLink`, the verification
  mails and the other account mails use `user.lang`; password-policy messages take a
  translator (`validateNewPassword(pw, req.tr)`). Use `normLang` / `pickLang` for untrusted values.
  NULL means English.
- **Marketing pages** (`views/marketing`) are written in English with
  `data-i18n` / `data-i18n-html` / `data-i18n-attr` hooks and one EN and one FR
  dictionary (`pageI18nEn/Fr` in the page, `COMMON` in `assets/i18n-common.js`: plain data, one copy, loaded by a `<script>` before `site.js` in the browser and `require()`d by the server, also read by the header partial for the nav labels). They are
  rendered through `renderMarketing()` (`src/lib/pageDictionary.js`): when
  `req.lang` is `fr`, `applyPageDictionary()` fills every hook from the French
  dictionaries BEFORE the HTML is sent (the same swap `site.js` does in the
  browser), so the legal pages, `<title>`, meta description, Open Graph and
  Twitter tags, the skip and back links are French in the server HTML (search
  engines, no-JavaScript clients, print). `og:locale` is `fr_FR` / `en_GB` and
  `<html lang>` follows. The EN/FR toggle still swaps in place, from the same
  dictionaries: there is one copy of every text. Each page needs `meta.title` and
  `meta.description` entries in both dictionaries. French dictionaries use a
  no-break space before `; : ! ? €` and inside `« »` (a unit test checks it).
- **Euro amounts** are formatted by ONE helper, `formatEuro(amount, lang)` in
  `src/lib/money.js` (French `12,50 €` with a no-break space, English `€12.50`;
  null/NaN give an empty string). Views call `eur(n)` (set in `lang.js`), emails
  and server code call `formatEuro`, and the two client scripts that build
  prices (`UmasUI.euro` in `public/ui.js`, used by the Browse and Favorites cards) read
  `<html lang>`. JSON APIs keep numbers. Never print a price with `toFixed(2)`
  to a customer.
- **Is the French complete? (the crawler).** `test/integration/i18nCrawler.test.js` boots the
  app, seeds one of everything, and reads every customer page as a guest, an account holder, a
  member and a volunteer, plus refused and successful form posts, the JSON APIs, error pages and
  the emails the app sends (captured at the mailer by `test/helpers/mailCapture.js`), in English
  and in French. It fails on English text in the French render (identical to the English page, a
  known English `tr()` string, or English function words). Legitimate same-in-both-languages text
  is listed with a reason in `test/i18n-allowlist.js`. Two source-level tests sit under it:
  `test/unit/frenchWording.test.js` (every `tr(en, fr)` pair and marketing dictionary has real
  French, "e-mail" spelled with a hyphen, same placeholders) and `test/unit/frenchSourceScan.test.js`
  (no new English sentence outside `tr()` in customer-facing server code, baseline in
  `test/i18n-source-baseline.json`). `node scripts/i18n-audit.js` prints what is left and
  `--write` refreshes `docs/i18n-audit.md`, which also holds the "definition of done" for a new
  text and the review checklist (`docs/testing/french-review.md`). The admin area, emails to the
  admins and stored content (blog posts, announcements, forum posts, event texts) are out of scope.
  It also fetches the `/fr/` address of every public page with no language cookie and no `Accept-Language`, and
  expects the same status and no English text there too (`test/integration/frenchUrls.test.js` covers the links,
  cookie, redirects and head tags of `/fr/`).
- **Older per-page net:** `test/helpers/i18nAudit.js` (`visibleText`, `untranslated`,
  shared `ALLOWLIST` for brand names and legal identifiers) reports text that is
  identical in the English and French render of a page, including `aria-label`,
  `alt`, `placeholder`, `title` and the meta description / Open Graph / Twitter
  text. Append each translated customer page to `PAGES` in
  `test/integration/i18nCoverage.test.js` (every marketing page is already there).
  `test/integration/i18nCore.test.js` covers the plumbing.

## Dates and times (Europe/Paris)

Uma's Books is in Albi, so every date and time an admin types and every one a
person sees means **France time**, not UTC (Render's servers run in UTC).
`src/lib/tz.js` pins the process timezone to `Europe/Paris` (required first by
`index.js`, `db.js`, `lib/dates.js` and `lib/calendar.js`), so a typed
`2026-07-15T18:00` with no offset is read as 18:00 Paris and calendar grouping,
month maths and default formatting use Paris days. Postgres keeps exact
instants (`timestamptz`); routes hand it a `Date` built by
`parseLocalDateTime(date, time)` (`lib/dates.js`), which returns `null` for
anything invalid so the write is skipped. Display helpers set
`timeZone: "Europe/Paris"` explicitly. A weekly repeat (volunteer shifts) uses
`weeklyDateTimes`, which keeps the same wall-clock time across the October/March
clock changes instead of adding 7×24 h.

The DATABASE session zone is pinned to UTC too (`options: "-c timezone=UTC"` in
`src/db.js`; Render's Postgres is UTC already, a developer's may not be), so
nothing depends on the machine. `timestamptz + interval '7 days'` is evaluated in
that session zone, i.e. as 7×24 h, which ends a hold an hour early or late in
Paris wall time across a clock change. A deadline that means "N calendar days
later in Paris" is therefore written with `parisPlusDaysSql(expr, days)`
(`src/lib/tz.js`: add the days to the Paris wall-clock time, convert back):
extending a reservation, the "reservations expiring" windows that compare against
the stored Paris-midnight `reserved_until`, and the membership "ending within 30
days" list. Plain elapsed-time windows (an order paid N days ago, a copy reserved
N days ago, minutes/hours, retention periods) deliberately stay `interval` maths:
an hour either way does not matter there. Tests: `test/integration/parisCalendarDays.test.js`.

Before this existed, typed times were stored as UTC (18:00 became 18:00Z, i.e.
20:00 in Paris in summer) — migration `033_paris_wall_times.sql` shifted those
rows once. Date-only fields (blog dates, announcement expiry) are
UTC-midnight values and were left alone. `test/integration/parisTime.test.js`
covers it; run it with `TZ=UTC PGOPTIONS='-c timezone=UTC'` to reproduce
production's environment on a Paris-timezone dev machine.

## Migration process

`src/migrate.js` applies each `.sql` file in `migrations/` exactly once, in
filename order (`001_`, `002_`, …), and records it in the
`schema_migrations` table. `npm run migrate` runs in Render's pre-deploy command (not at boot), and only
files not yet recorded do anything. Each
file runs in its own transaction together with its bookkeeping row, so a
failing migration leaves no half-applied state, and an advisory lock stops
two booting instances racing.

Because a file runs once, a migration may contain one-time data fixes
(`UPDATE ...`) — that's the point of the tracking. Before it existed,
every file had to be re-runnable, and two weren't: `014` reset NULL
(unlimited) session capacities to 5 and `032` marked still-unverified
accounts as verified, on every deploy. Those files are unchanged (editing
an applied migration would be pointless), but they no longer re-run.

Rules: never edit or rename a migration that has been deployed — add a
new numbered file instead. A database that predates the tracking table
(production, at the time this was introduced) is detected on first run and
all existing files are recorded as applied without being re-run.

Numbering is enforced by `test/unit/migrationNumbering.test.js`: no duplicate
number, strictly increasing in filename order, the newest file has the highest
number, and the only gaps are the known ones (049, 051, 052, 061, 064). Check
`main` and open pull requests for the next free number.

**Migrations must be additive (expand) in the release that needs the old code to
keep working; destructive steps (drop, rename, NOT NULL, data deletion) ship in
a later release (contract).** A rollback runs the old code against the new
database, and a backfill must never record an outage as a permanent result (the
migration-059 lesson: only a 404, placeholder or invalid image counts as a failed
cover attempt). Runbook section z) has the longer version.

To add a migration: create the next-numbered `.sql` file and commit it.
CI's `migration-test` and `test` jobs (`.github/workflows/ci.yml`) apply
every migration to a brand-new database on every run, and
`test/integration/migrationTracking.test.js` proves a second run changes
nothing.

## Alphabetical order of titles (`books.title_sort`)

Every "sort by title" uses `ORDER BY b.title_sort, b.title, b.id`, never `b.title`:
`/api/books/search` (the shop and Browse Books), "More by this author" on the book
page, and the admin Inventory list. `books.title_sort` (migrations 086, 099) is a STORED
generated column: the title lower-cased, with leading punctuation dropped and one
leading whole-word "The", "A" or "An" dropped (`The Hobbit` -> `hobbit`, `A Midsummer Night's Dream` ->
`midsummer night's dream`; `Theory`, `Anne` untouched; a title that is only "The"/"A"/"An" keeps itself). It follows title edits by itself and has an index
`(title_sort, title, id)`, so the catalogue query reads in index order and stops at its
LIMIT. `src/lib/titleSort.js` (`sortTitleKey`, `compareTitles`) is the JavaScript twin for
sorting in code; `test/integration/titleSortOrder.test.js` checks the two agree. French
articles are deliberately not ignored. The collection edit page and the public collection page use the same order. New code that lists books by title
must use the column, not `title`.

## Images

Uploaded photos (book covers, blog/announcement/charity images) are
processed by sharp as before (see the `process*Image` functions in
`src/routes/admin/`; the 40-megapixel decode cap is in
`src/lib/uploadImage.js`) and then handed to `src/lib/imageStore.js`:
`saveImage(buffer) -> '/img/<sha256>.jpg'`. Rows store only that short URL
(`books.cover_url`, `announcements.image_url`, `charities.image_url`,
`blog_posts.image_url`). A cover address from Open Library / the Internet
Archive is never printed in a page: it is downloaded once and stored too
(next bullet), so `books.cover_url` is always one of our own `/img/` URLs or NULL.

- **Covers on our own server (`src/lib/coverStore.js`, migration 059):** when a
  book is added or edited the lookup's cover address is fetched by the server
  (`prepareCover`), re-encoded with sharp (JPEG, at most 600 px wide, all
  metadata removed, a 1x1 "no cover" placeholder refused) and stored with
  `saveImage`, so the same bytes are stored once. The external address stays
  only in `books.cover_source_url` (never rendered) so a failed download can be
  retried; `cover_fetch_failures` / `cover_fetch_attempted_at` space retries out
  (1 hour apart, 3 failures then nothing for a week). Fetching is SSRF-safe:
  https only, no credentials or port, host in `ALLOWED_HOSTS`
  (`covers.openlibrary.org`, `openlibrary.org`, `archive.org`, `*.archive.org`)
  checked again on every redirect (followed manually, 3 at most), the name must
  resolve to a public address, 8 s and 3 MB limits, content-type check, and the
  bytes must decode as an image. A background job (`Cover backfill`, every 5
  minutes, first run after 1 minute, `guardJob`, 20 books per run, books on the
  shelves first, 0.5 s between downloads) copies the covers of books that existed
  before; `COVER_BACKFILL=off` stops it (the test helper sets it). Routes print
  covers through `localCover()`, so a stray external address is never rendered.
  Cover `<img>`s carry `width`/`height` + CSS `aspect-ratio: 2 / 3` (no layout
  shift), a neutral background, `loading="lazy"` in lists and `fetchpriority="high"`
  on the book page's own cover; a failed load is swapped for a "No cover" box by
  `public/app.js` (a capture-phase `error` listener on `img[data-cover]`, no
  inline `onerror`, which the CSP blocks). Neither CSP lists an external image
  host any more (`img-src 'self' data:`).

- **Editing a cover (`src/lib/coverEdit.js`, `src/routes/admin/inventoryCover.js`, migration 098):** the Cover card on a
  book's admin page replaces, rotates, crops or removes the cover. Four admin-only POST routes,
  `/admin/inventory/:id/cover/{rotate,crop,replace,remove}` (CSRF, audit `cover.rotate|crop|replace|remove` with the book id,
  `coverEditLimiter`: 30 a minute per admin), all plain form posts that redirect back to `#cover` with `?cover=<code>`
  (the sentence is looked up in `COVER_NOTICES` / `COVER_ERRORS`; a script sending `Accept: application/json` gets JSON and
  the real status: 400 bad values, 409 changed meanwhile / not stored / no cover, 413 over 8 MB, 429). One pipeline for every
  edit, built on the same pieces as the other photo paths: `sharpFromUpload` (40 MP cap), format read from the bytes
  (JPEG, PNG, WebP only: GIF, SVG, HEIC and "HTML named .jpg" are refused), `.rotate()` with no angle first (EXIF
  orientation), all metadata dropped, transparent areas on white, always a JPEG (quality 85, down to 50 if over 400 KB),
  never enlarged, longest side at most 900 px (so a turn never shrinks a cover). The result goes through `saveImage`
  (new SHA-256 id) and `books.cover_url` is updated with `WHERE cover_url = <the one edited>` (two people cannot undo each
  other; a double press by one person is two turns). The old image is NOT touched: it stays until
  `imageCleanup` finds nothing refers to it and it is older than 7 days. Crop values are fractions (0..1) of the CURRENT
  stored picture, plain decimals only (`NaN`, `1e-1`, arrays, negatives refused; a box up to 0.001 past the edge is pulled back;
  at least 5% and 30 px each way). Rotate and crop only work on `/img/<hash>` pictures that exist in our store (an own photo
  or an Open Library cover that `coverStore` copied there). A leftover external address, a `data:` URI or an unknown hash is
  REFUSED with a clear message (409 `not-stored`) instead of being imported: the editor makes no network call at all, so it
  has no SSRF surface; Replace and Remove still work for such a book. **Remove** sets `cover_url` and `cover_source_url` to
  NULL and `cover_removed_at = now()`; that mark makes `fillBookGaps`, the edit-details save and `backfillCovers` leave the
  book without a cover until a photo or cover address is set again. An edit calls `clearBrowseCaches` (New In) and
  does not run awards, AI or description fill. The crop box is `public/cover-edit.js` (pointer events: mouse, pen and touch,
  keyboard: arrows move, Shift+arrows resize, Escape cancels; `touch-action: none` only on the overlay), styled by
  `public/cover-edit.css` (`cvr-` prefix, owned by this page only); without JavaScript the Crop button stays hidden and the
  other three still work. Tests: `test/integration/coverEdit.test.js`, `test/unit/coverEdit.test.js`.

- **Where the bytes live:** the `images` table (`id` = lowercase hex SHA-256
  of the bytes, `content_type`, `data` BYTEA, `byte_size`;
  `migrations/034_image_store.sql`). Content-addressed, so identical uploads
  dedupe and a URL's bytes never change.
- **Cleanup of unused images:** `src/lib/imageCleanup.js` deletes `images`
  rows whose hash appears in no referencing column. The columns are listed
  once, in `IMAGE_REFERENCES` (cover/image URL columns plus the rich-text
  bodies, excerpts and descriptions, matched by substring so an `<img>`
  inside a body counts). Only images older than 7 days are removed (an
  upload exists before the form that references it is saved), `saveImage`
  refreshes `created_at` on a repeat upload, one run deletes at most 500
  rows in a single statement, and a daily job in `src/jobs.js` runs it and
  logs counts only. The admin dashboard shows "Unused images waiting for
  cleanup". A test fails if a new image-looking text column or a new
  `saveImage` caller appears without updating `IMAGE_REFERENCES`.
- **Serving:** `GET /img/<sha256>.(jpg|png|webp)` (`src/routes/img.js`),
  mounted before the session store like `/assets`, so it never reads or sets
  a cookie. `Cache-Control: public, max-age=31536000, immutable`, `ETag` =
  the hash (`If-None-Match` -> 304 without a DB read), `nosniff`. Anything
  not matching the strict pattern, or unknown, is 404. No rate limiter: the
  response is immutable and cacheable and a page legitimately loads dozens.
  CSP `imgSrc` is `'self' data:` only.
- **Width variants (`src/lib/imageVariants.js`, no migration):** a phone shows a
  cover in a 150-170 px slot, so grids, the "New In" carousel, book cards, the
  cart and the favourites ask for a smaller copy through `srcset`/`sizes`.
  `GET /img/<sha256>-w300.jpg` (also `-w450`, `-w600`) is the stored JPEG scaled
  to that width by sharp, height following the ratio (never cropped), no
  metadata, never enlarged (a 600 px request for a 600 px cover is the stored
  bytes). Only those three widths exist: any other name (another width, another
  extension, a query-string width) is a plain 404, so the URL cannot make the
  server render arbitrary sizes, and the query string plays no part. The variant
  is made on the first request and kept in a small in-memory LRU (24 MB, bounded;
  a restart only costs a recompute), at most 2 resizes run at once and requests
  for the same variant share one. Same immutable cache headers as the original;
  the `ETag` is `"<hash>-w300"`, so a 304 needs no database read. Variants are
  only made for stored JPEGs (covers); a PNG/WebP upload has no variants. Pages
  use `coverSrcset(url)` (EJS local, `app.locals`) and `UmasUI.coverAttrs` in
  `public/ui.js` builds the same attributes in the browser; an address that
  is not a stored `/img/<hash>.jpg` gets no `srcset`. Widths 300/450/600 (not
  just 300/600) because a 160 px slot on a 2x phone needs 320 px: 450 is the
  smallest copy that stays sharp there.
- **Legacy values:** the migration converted every `data:image/...;base64`
  value in those four columns (inside its transaction). Templates and APIs
  just print the column, so old data URIs and new short URLs both work.
- **Future object storage (Backblaze/S3):** callers only ever receive a URL
  string, so reimplement `saveImage`/`getImage` against the bucket and have
  `routes/img.js` redirect or stream from it; no caller changes. Existing
  `/img/<hash>` URLs stay valid because the key is the content hash.
- **Backups:** the nightly dump is complete (images included) and goes only
  to the private Backblaze B2 bucket under `store-backups/full/` (nothing is
  committed to git); the workflow fails if `BACKUP_S3_*` is not configured
  (README, "Restoring from a backup").

## Phone polish: print, colour scheme, safe area, fonts

- **Print (`public/print.css`):** linked with `media="print"` from the two public
  heads only (`views/partials/header.ejs`, `views/marketing/partials/mkt_header.ejs`).
  Hides the header, menu, footer, banners, language switch, buttons, heart
  buttons and sticky bars; writes the address after an *external* link in running
  text (`main p a[href^="http"]::after`; our own links are relative, so they are not
  printed). Admin pages do not load it: their print layouts (pickup list, reports,
  the price-sticker colour chart in `admin.css`) and the till receipt
  (`till-receipt.css`) are untouched, as is the order receipt rule in `style.css`.
- **Colour scheme (decision: the site stays light):** there is no dark theme (the
  botanical artwork is painted for a pale page). `color-scheme: light` on `:root`
  (`style.css`, `assets/site.css`) plus `<meta name="color-scheme" content="light">` in
  every head, so a phone in dark mode still draws form controls, scrollbars and the
  canvas light. A test fails if a `prefers-color-scheme: dark` rule appears: adding a
  dark theme is a design decision, not a CSS tweak.
- **Safe area:** `viewport-fit=cover` is deliberately *not* set. Without it a
  home-screen (standalone) page is laid out inside the safe area, so nothing sits
  under the home indicator. Bars that would need it anyway pad with
  `env(safe-area-inset-bottom)` already (till pay bar, scan page bar, the sticky save bar
  `.form-actions-sticky`, the phone menu drawer); a test fails for any new
  `position: fixed|sticky` bar at `bottom: 0` that does not. If `viewport-fit=cover` is
  ever added, those paddings start to matter at once.
- **Fonts:** the two fonts every page needs first (Cormorant Garamond and Nunito Sans,
  latin) are preloaded (`rel=preload as=font crossorigin`, same URL as the CSS, so it
  is not fetched twice). Each of the four families has a `... Fallback` `@font-face`
  (`local('Georgia')` or `local('Arial')`) with `size-adjust`, `ascent-override`,
  `descent-override`, `line-gap-override: 0`, named right after the web font in every
  `font-family` stack, so the swap does not reflow the text (privacy policy CLS 0.055
  -> 0 at 390 px on throttled 4G, CPU 4x). Values were measured in headless Chrome on a
  mixed English/French sample (width ratio, then rounded up about 0.6% so a line that
  fits in the web font also fits in the stand-in); re-measure if a font file changes.
  Phones without Georgia/Arial (some Android) fall through to the generic font as before.

## Accessibility conventions (WCAG 2.2 AA / RGAA)

- **Language of parts.** The shop sells English books, so on a French page titles and authors are wrapped in `<span lang="en">` (`src/lib/bookText.js`, views use `bookText()`; browser twin `UmasUI.enSpan` in `public/ui.js`). The catalogue has no book-language field; a book that carried a non-English `language` would be left unwrapped. An `aria-label` cannot carry a `lang`, so on French pages the favourite heart's name is a visually-hidden `.fav-name` span inside the button (`views/partials/favorite_button.ejs`); English pages keep a plain `aria-label`. Image `alt` text (cover) stays one French sentence with the title inside it: the HTML alt attribute cannot switch language.
- **Carousels** (`public/carousel.js`): only the items on screen are tab stops (`tabStops()`, the rest get `tabindex="-1"`); the Next arrow is before the track in the DOM and drawn after it with CSS `order`; arrows use `aria-disabled`, never `disabled` (a focused button that gets disabled drops focus on `<body>`); a skip link jumps from New In to Browse by Genre.
- **Customer form errors:** `views/partials/form_error_summary.ejs` (role=alert, links to the fields, `data-form-errors`, focused by `public/app.js`) plus `aria-invalid` and `aria-describedby="form-errors"` on the fields named by the route's `errorFields`. The marketing forms (volunteer, pre-registration) have their own summary partial.
- **Hit areas:** the heart's invisible `::after` is exactly 44 x 44 and centred, whatever the heart's own size.

## CSS ownership

Three layouts, three base sheets. A page loads exactly one of these sets (the real `<link>` tags are in the three layout
partials; `test/helpers/cssPages.js` reads them):

| Layout (partial) | Pages | Sheets, in load order |
|---|---|---|
| `marketing/partials/mkt_header.ejs` | the public marketing site | `assets/site.css`, `public/site-header.css`, `print.css` (print only), then the page's `extraCss` |
| `partials/header.ejs` | members area and shop (login, account, cart, dashboard, events...) | `public/style.css`, `public/site-header.css`, `print.css` (print only), then `extraCss` (`dashboard.css`, `floral-calendar.css`) |
| `partials/admin_header.ejs` | admin | `public/style.css`, `public/admin.css`, then `extraCss` (`till.css`, `scan-intake.css`) |

`assets/site.css` and `public/style.css` are two alternative base sheets: they never load on the same page, so each
repeats the same design tokens, font faces, focus ring and basic buttons (kept in step by `test/unit/cssOwnership.test.js`).
`site-header.css` (the shared header, footer, back bar, skip link) is the only sheet both public systems load.

**Who owns what.** `site.css` / `style.css`: tokens, base elements, buttons, cards, forms of their system. `site-header.css`:
`.mkt-header`, `.mkt-footer`, `.site-back-bar`, `.skip-link`, `.preview-banner`, `.langtoggle`, `.favorite-toggle::after`.
A page sheet (`home.css`, `books.css`, `blog.css`, `events.css`, `dashboard.css`, `till.css`...) owns every class that starts
with its prefix (`.bk-`, `.wn-`/`.blog-`, `.ev-`, `.dash-`, `.till-`...), **including the wrapping and shrinking rules for them**
(`overflow-wrap`, `hyphens`, `min-width: 0`): they live next to the rest of the class, not in the base sheet.

**The rule: one owner per shared class.** A selector is declared in one sheet only among the sheets of a page type. Two sheets that
load together and both declare it make the winner depend on `<link>` order, and an edit to one silently does nothing or changes
the other system. To add to a class another sheet owns, edit the owner. To override it for one page, scope the override with
`:where(.page-wrapper) .the-class` (specificity stays the same, so the cascade does not move) and put it in the page sheet.
`test/unit/cssOwnership.test.js` fails when two co-loaded sheets declare the same selector (allowlist: `ALLOWED_SHARED`, empty
today; every entry needs a reason).

**Design tokens** (`:root` of `site.css` and `style.css`, same values): colours `--cream`, `--panel`, `--ink`, `--green`,
`--maroon`, `--maroon-dark`, `--gold`, `--gold-dark`, `--btn-bg`, `--btn-bg-dark`, `--line`, `--card-border`, `--line-strong`
(field and tile borders); fonts `--font-serif` (Cormorant Garamond, body and headings), `--font-baskerville`, `--font-nunito`,
`--font-montserrat`, `--font-script` (the stacks are written once; the size-adjusted fallback faces are the `@font-face` rules at the
top). Only `site.css` also has `--cream-alt` and `--shadow` (marketing sheets only). Use the token when a colour equals one; do not
type the hex or a font stack again. `--ink-soft`, `--maroon-soft` and `--green-soft` were removed: they held the same value as
`--ink`/`--maroon` (or were unused), so a "softer" grey is a new design decision, to add as a new token when someone wants it.
Known gap: `floral-calendar.css` uses `--cream-alt`, which `style.css` does not define, so `.fcal-day.is-empty` has no background
in the app (listed in `KNOWN_MISSING_TOKENS` of the test; defining the token would tint those days).

Tests read stylesheets through `test/helpers/css.js` (`loadSheet(file).getDecl(selector, prop, { at })`, `getRule`, `hasRule`),
which parses with postcss, instead of matching the source text with regular expressions.

## Genres: managed list, rules, Update all books, Browse buttons

`books.categories` is a comma-separated free-text string (English; books have no French genre: `categories_fr` is unused and NULL since migration 107).
Admin > Genres (`routes/admin/genres.js`, views `admin/genres*.ejs`, `public/genres.js` + `genres.css` with the `.gn-` prefix; English only)
manages it. Migration 100 adds only tables (no book is rewritten by it):

- `managed_genres` (name `name_en`; `name_fr` and `browse_label_fr` are left from migration 100 and no longer read or written; `sort_order`, and the Browse button: `show_on_browse`, `browse_slug`, `browse_order`, `browse_label_en` (the label in both languages),
  `browse_topic`, `colour`, `icon`), seeded from `COMMON_GENRES` (and the French list of that time) plus Health & Wellness and Home & Garden.
- `genre_rules` (`exact` | `contains-word`, action `map` | `remove` | `keep`, target, `sort_order`), `genre_runs`, `genre_run_changes`.
  Classification for the test-data script: the two settings tables are `kept`, the two run tables `shop`.

**Matching** is pure and lives in `lib/genreRules.js` (`applyGenreRules`, `rewriteGenres`, `planBook`): exact rules, then word rules, then
the managed names (identity, normalises capitals), each by `sort_order`; first match wins; an unmatched genre is left as it is; duplicates
collapse, order is kept, nothing left = NULL. `lib/genreAdmin.js` is the data side (found genres: ONE aggregate query, cached 60 s; CRUD;
"Show matches"), `lib/genreSuggest.js` the AI help (batches of 100, shared daily cap through `askText`, answers validated against the managed
names, never saved), `lib/genreRun.js` the bulk run.

**Update all books follows the Reprice safety model:** preview (POST, nothing written; count + sha256 of every planned change) -> confirm
(POST, CSRF, rate limited; recomputes and refuses unless it equals the preview) -> batches of 500 in transactions with a session advisory
lock (one run at a time; each UPDATE re-checks the value the plan read) -> `genre_runs` + before/after per book -> audit
(`genre.apply`) -> caches cleared. **Undo** restores only books that still hold what the run wrote (`genre.undo`), newest un-undone run only.
A run the server never finished (crash, SIGTERM) stays `running` until `reapStaleRuns` (`src/lib/genreRun.js`) marks it `failed` with a `note` (migration 102): at the start of every apply and when the Genres pages load, for `running` rows older than 15 minutes while nobody holds the run lock. It shows as "failed (interrupted)" and Undo stays available for the books it had already changed.
Idempotent: a second run plans 0 changes. A book whose genres do not change keeps its stored string. Runs write and undo the English genres
only (`genre_run_changes.old/new_categories_fr` stay NULL for new runs; an older run's French values are history and are never written back).

**Save paths** (`inventoryIntake.createBookAndCopy` for a new book, the book edit route) call
`applyRulesToBook(pool, genre)` -> `{ genre }`: with NO stored rule nothing changes; otherwise the genres go through the same rules (cached in-process
60 s, cleared on every rule change). The admin Inventory Genre filter lists the managed genres, then up to 200 other genres
in use under "Other". The repeated checkbox field `accept` of the AI proposals is on the allow-list in `lib/multiValueFields.js` (guard test
`test/unit/multiValueFields.test.js`).

**Browse buttons are managed genres** (`lib/browseGenres.js`): `loadBrowseGenres(pool)` reads the rows with `show_on_browse` ordered by
`browse_order`, cached 60 s (cleared on edits and after Update all books), then appends the fixed **All Genres** button (not a genre: no row).
`views/marketing/books.ejs` draws them and puts each label (`browse_label_*`, else the managed name) in the page's EN/FR dictionaries as
`g.<slug>`. The slug (the value of `?genre=`) is created once and never changes, so old links keep working; the 13 original slugs, search words,
colours (`PALETTE`) and icons (`ICONS`) are seeded exactly. The search is unchanged: `/api/books/search?topic=` matches the words as substrings
of `books.categories`; a genre with no search words searches its own name. The rendered Browse page of the seeded data is byte-identical to the
page before this change (`test/fixtures/browseGenres.golden.json`).

## Reservations: reserve online, pay in the shop

**Reserving: with an account, or as a guest.** Anyone can browse, search and fill
the cart (a list of lines in the session, at most 20; a signed-out visitor's cart
is the same session cart). The cart page then offers two ways to reserve:

- **With an account** (`POST /cart/reserve`; a signed-out visitor posting it, and
  the old `GET /cart/checkout`, are sent to `/login?returnTo=/cart`). Login
  regenerates the session but copies the cart across; the returnTo (local paths
  only, `src/lib/returnTo.js`) travels in the login form and, through signup,
  inside the single-use `email_verification_tokens.return_to` /
  `password_reset_tokens.return_to`, so signup -> confirm -> choose password ->
  login ends back on the cart. The reservation is placed under the account's
  confirmed email (`orders.user_id`, `buyer_email` from the `users` row, never
  from the form; an unconfirmed account is refused); the name is pre-filled from
  `display_name` and stored on the order.
- **As a guest, without an account** (`GET /cart/guest`, `POST /cart/guest/reserve`,
  `src/lib/guestOrders.js`, migration 106): name and email required, phone
  optional, the terms box; no password. The same `createReservation` with
  `guest: { email }`: `orders.user_id` NULL, `orders.is_guest` TRUE. The books are
  held at once but `reserved_until` is only `GUEST_CONFIRM_HOURS` (2 h,
  `lib/legal.js`) away, and the email (`guest_reservation`, a throttled
  one-time-link kind of the outbox, queued inside the reservation transaction: a
  throttled address rolls the reservation back, `MAIL_THROTTLED`) carries a
  **confirm link** and a **manage link**. `GET /cart/guest/confirm/:token` shows
  a button (mail scanners must not confirm); the POST claims the token atomically,
  sets `guest_confirmed_at` and the deadline an account holder's reservation made
  at the same moment would have (end of the 14th Paris day after `created_at`, or
  the end of the session for seats only), and sends the full confirmation
  (`guest_reservation_confirmed`, the account holder's text with the manage link
  instead of the account page). Never confirmed, the usual expiry releases it
  (release reason `unconfirmed`: no "your reservation has ended" mail, no
  reminders, not in the admin digest). `GET /cart/guest/manage/:token` is the
  reservation page plus "Cancel reservation" (`cancelReservationAsGuest`, the same
  release as the customer cancel). Tokens (`guest_order_tokens`): 32 random
  bytes, only the SHA-256 stored, one purpose each, `confirm` single use and
  expiring with the 2 hours, `manage` expiring 30 days after the deadline; both
  emails' bodies are blanked once sent. Limits: `MAX_RESERVED_COPIES` /
  `MAX_ACTIVE_RESERVATIONS` count per lower-cased email over every open guest
  reservation of that address (unconfirmed ones included), under a per-email
  advisory lock, plus the per-IP `checkoutLimiter` and CSRF. Drop-in seats share
  the cart, so a guest can reserve seats too; classes that need a sign-up,
  membership, member discounts and the account page still need an account.
  **Attach**: `attachGuestOrders(db, userId)` sets `user_id` on the guest orders
  with the account's email, only when that account's email is confirmed (and the
  account not disabled): called from `POST /verify-email/:token`, a completed
  password reset (both confirm the email) and every login (`loginAs`). An
  attached order keeps `is_guest` TRUE (the admin page says so).
  The admin orders list and order page mark guest orders "Guest" with name,
  email and phone; collect, partial pickup (the guest's links follow the part
  still reserved), refund, no-show, cancel and the accounting export are the
  account holder's, unchanged. "Resend confirmation" mints fresh links.

Orders from before accounts were required have `user_id` NULL and `is_guest`
FALSE and keep working by token (`/cart/return`, exports by email).

Reservation flow (`createReservation`, `src/lib/cart.js`): one transaction,
under a per-account advisory lock, checks the limits in `src/lib/legal.js`
(`MAX_RESERVED_COPIES` 10 books, `MAX_ACTIVE_RESERVATIONS` 3 open reservations),
inserts an order with status `reserved` and `reserved_until` (end of the 14th
Paris day for books; the end of the session for a seat-only order), locks the
copies in id order (`status = 'reserved'`, `cart_order_id` pointing at the
order) and the class rows (seats `reserved`), inserts the order lines and queues
the confirmation email in the outbox. Any mismatch is `SOLD_OUT` and rolls
everything back. The customer lands on `/cart/return?order=<access_token>`, the
reservation page (also the link in the email).

- **Release.** `expireOrderReservations` and `releaseEndedSeats`
  (`src/lib/reservations.js`) run at the top of any route that shows copy status
  and from the 6-hourly jobs: a reservation past its deadline becomes `expired`,
  its copies `in_stock`, its seats `released`. Mail is only sent from the
  periodic jobs, never from a page read.
- **Customer cancel.** `POST /cart/reservations/:id/cancel`, owner-only (another
  account gets the same "not found"), books at any time, seats until
  `SEAT_CANCEL_HOURS` (24) before the session.
- **Admin.** "Extend by 7 days" (once, only while books are held), "Cancel
  reservation", "Mark no-show / expired", "Mark collected and paid" (payment
  method cash / card at the shop / cheque / other; the amount received can only
  be lowered, with a note, and `reserved_total` keeps the original), "Collect
  selected items" (partial pickup: the rest moves to a new reserved order
  with the same deadline, linked by `split_from_order_id`). Each runs in one
  transaction with the order row locked first and writes an audit row (ids only).
- **Drop-in seats on release.** Releasing marks `class_dropin_seats` rows
  `released` rather than deleting them: `order_items.class_dropin_seat_id`
  references the seat (no ON DELETE action). A released seat stops counting
  toward the session's capacity and is not on the roster.
- **Old online checkout.** `runCartMaintenance` (every 10 min) releases
  leftover `in_cart` holds from before the change, and runs the reservation
  expiry so an unconfirmed guest hold goes back on sale within 10 minutes of its
  2 hours even without traffic; no payment provider is asked,
  nothing creates a `pending` order any more, and `/webhooks/helloasso` only handles
  membership payments (an old notification naming a checkout order is logged).

### Cart icon on book cards (`src/lib/cardCart.js`)

Every book card with a price (Browse New In, genre/search/See All results, collection pages, Favorites, the
book page's "More by", the Browse no-JavaScript list) has a cart icon at the right end of its price line. The book
page's own price line has none: its copy table right below already has an Add to Cart button per copy.

- **What it does** is decided per book from the copies buyable online now (`in_stock`, price > 0, the
  `/cart/add` rule), by `BUY_COPY_SQL` in the list queries, sent as `buy` in the public JSON (`lib/publicBookJson.js`):
  none -> no icon (unpriced, reserved, sold: never a dead icon); one copy, or several identical in what the book page
  shows (price, grade, clearance) -> `{ copyId }`, the oldest (lowest id) is added; several that differ ->
  `{ choose: true }`, the icon opens the book page. A book with a copy in the session's cart shows "in your cart",
  a link to `/cart`, never a second add (`cartBookIds`, also in `/api/session` as `cartBookIds`).
- **Markup**: `views/partials/card_cart.ejs` (server) and `UmasUI.cartControlHtml` (`public/ui.js`, browser), the
  same HTML (`test/unit/uiHelpers.test.js`). The price line sits outside the card's link (a form cannot be inside a
  link); on the `.book-card` cards the link's `::after` still covers the whole card. Names: "Add T to cart" /
  "Ajouter T au panier" (French: visually-hidden text with the title in `lang="en"`, like the heart).
- **Forms without JavaScript**: a page drawn for one session (signed in, or the book page, which prints a token
  anyway) gets a POST form to `/cart/add` with the CSRF token and `via=card`. A signed-out visitor's marketing page
  (Browse, collections) stays the same for everyone and creates no session: its icon is a GET form to the book's page
  (`/books/<id>`, whose Add to Cart works signed out).
- **With JavaScript** (`public/cart-add.js`): any icon form posts `/cart/add` itself (token from `/api/csrf-token`,
  `Accept: application/json`), and the answer is JSON. Signed in: the icon turns to "in your cart" in every card of
  that book, focus moves onto it, the header count follows, a polite status line speaks. Signed out: the same (the
  copy goes into the session's cart, which login carries across; no sign-in detour). Same limiter, same CSRF check,
  no state-changing GET.

### Favourites

Saved in the browser (`localStorage` `umasbooks.favorites`, `public/favorites.js`, every read and write in
try/catch), signed in or not; the Favorites page (`/favorites`) needs no account and draws the list from
`/api/books/by-ids`. Signed in, each toggle is also saved to `favorites` (`POST /api/favorites/toggle`), and once
per login session (`/api/session` `favoritesMerge`, cleared by the merge) the browser posts its whole list to
`POST /api/favorites/merge`, which adds it to the account (unknown ids skipped, 200 at most) and answers the
account's list, added back into the browser. `favorites.js` is on every page (EJS footer and marketing footer).

### Email outbox (`src/lib/outbox.js`, migration 062)

All customer emails are **stored in `email_outbox` first**, then sent
(`sendEmail`), so a Gmail outage, rate limit (~2000 messages/day) or revoked
app password loses nothing. See `docs/architecture.md` §7 for the full design.
Points for maintainers:

- `enqueueEmail(db, msg)` accepts a transaction client; `createReservation`
  queues the reservation confirmation inside the reservation transaction (in a
  savepoint: a failure building the text never undoes a reservation) and calls
  `deliverNow` after commit.
- `mailer.sendMail` is always called through the module object, so tests that
  replace `mailer.sendMail` still see every mail.
- Worker `processOutbox` runs every 60 s from `src/jobs.js` (advisory lock key
  7243902, claim by pushing `next_try_at` 5 minutes ahead); backoff 1, 5, 15,
  60, 240 min, 8 attempts, then `failed` plus one alert per hour
  (`alertFailedEmails`, sent directly through `errorAlert.sendAdminAlert` with
  one retry). `alertStuckEmails` adds one alert per 6 hours (flag in
  `alert_flags`) when any row has waited over 60 minutes, with counts per kind only. Admin alert emails (`alertOnError`) stay on the direct path with
  the same retry-once.
- `orders.confirmation_sent_at` (migration 062) is set when a confirmation went
  out; the dashboard flags reservations without it after 30 minutes. The admin
  routes live in `routes/admin/emailOutbox.js`: `/admin/email-outbox` and
  `POST /admin/orders/:id/resend-confirmation` (button from the partial
  `views/partials/admin_resend_confirmation.ejs`, included by
  `views/admin/orders.ejs`).
- One-time-link kinds (`TOKEN_KINDS`) lose their body when sent, when they fail,
  and when their link lifetime (`TOKEN_LIFETIME_MINUTES`) passes while pending
  (status `expired`, migration 068, swept first in every worker tick).
- Throttle (`THROTTLED_KINDS`, `enqueueThrottled`, constants in `THROTTLE`):
  1 mail per (recipient, kind) per 10 min, 5 per recipient per day, plus a
  shop-wide hourly ceiling per kind; one advisory-locked transaction per
  recipient. `sendEmail(msg, { throttle })`: undefined = full, `"skipInterval"`
  for resend buttons and the book-request mails (own limits), `"off"` for admin actions.
  A throttled mail returns `{ throttled: reason }` and stores nothing.
- `email_outbox.subject_email` (migration 068) is the submitter of form mail
  (kind `contact`); `eraseOutboxFor` and `listOutboxFor` match it as well as
  `to_email`.
- Data requests by address: `lib/privacyRequests.js` + `routes/admin/privacyRequests.js`
  (`/admin/privacy`); shared logic lives in `memberExport.buildEmailSections` and
  `privacy.eraseEmailKeyedData`.
- The goodbye email on self-deletion bypasses the outbox on purpose.

### Membership payments (`src/lib/membership.js`, migration 063)

`expiryFromPayments` chains payments (one calendar year in Paris time from `max(paid day, previous last day)`, ending at the last instant of that Paris day);
only Authorized orders over 0 EUR on `HELLOASSO_MEMBERSHIP_FORM_SLUG` (when
set) count; a result in the past grants nothing. A payer email with no
confirmed account is stored in `membership_payments` with `user_id NULL`,
`unmatched_at` set, and alerted (once an hour, from `alertUnmatchedPayments`,
also run by the outbox tick); `/admin/members` lists them and
`linkUnmatchedPayment` attaches one and grants in one transaction.
A refund or lost dispute no longer deletes the payment: the sync sets `reversed_at` / `reversed_amount_cents` (once), validity ignores reversed rows, and `accountingRows` adds a negative Membership row dated `reversed_at`.
`lib/memberStatus.js` is the one definition of "active member now"
(`attachUser`, login, favorites, member counts) and `isoDateParis` formats end
dates in Paris time.

## Newer features: where they live

Short map of features added after the sections above were written. Each entry
names the files; read those for the details. Operations for these are in
[`../docs/runbook.md`](../docs/runbook.md) (the table of contents at its top).

### The Browse page (`/books.html`)

- View `views/marketing/books.ejs`, script `public/page-books.js`, state parsing
  `public/books-state.js`, styles `../assets/books.css` (repo root `assets/`). Top to bottom: the page
  title, the **search** box, **Browse by Collection** (carousel of curated
  collections, `views/marketing/partials/collections_row.ejs`), **New In**
  (carousel), **Browse by Genre** (carousel of genre tiles), then the **results**
  grid with a **Show more** button (24 books at a time).
- All three carousels are one component, `UmasCarousel.make(track, prev, next,
  itemSel, more)` in `public/carousel.js`: the track shows a whole number of items,
  every item is a scroll-snap point, arrows and arrow keys move to the measured
  left edge of a real item. The genre buttons are drawn by the server
  (`src/lib/browseGenres.js`, order, colours, icons, search topics; the labels are
  in the page's EN/FR dictionaries) and `page-books.js` reads them back.
  (The home page's "What's New" slider in `assets/blog.js` is a different
  widget, one post at a time redrawn on each click; it is not this component.)
- **Shared browser scripts:** `public/ui.js` (loaded before the page script, see
  `extraScripts` in the views) is the one copy of `esc`, `euro`, `coverAttrs` and the
  two card layouts (`bookCardHtml` for Browse, `favoriteCardHtml` for Favorites;
  `views/marketing/partials/book_card.ejs` draws the Browse card on the server, for the
  collection page, and `test/unit/uiHelpers.test.js` checks the two give the same HTML
  byte for byte, EN and FR). It also holds `getJSON` (one retry, none when rate limited),
  `syncFavorites` and `installCoverFallback`, shared by `page-books.js` and `page-collection.js`.
  `npm run e2e:ci` (`e2e/ci.js`) runs the carousel, the genre Show more and a collection
  page's Show more (CI-G97a) in a real browser; CI runs it after the crawl.
- **Hide rules**: Browse by Collection and New In are for the plain view only.
  With a search (`?q=`), a genre (`?genre=`), a topic (`?topic=`) or
  `?new=1` ("See All New In") they are hidden. The server sends them already
  hidden (`src/app.js`: `newInHidden`, `collectionsHidden` from
  `browseFilterActive()` in `src/lib/collections.js`) and the page script applies
  the same rule afterwards, so there is no flash. Browse by Collection is also
  absent when no collection is published with an approved in-stock book.
- A `<noscript>` list of the newest books keeps the page usable without JavaScript.

### New In API and paged search

- `GET /api/books/new-in` (`src/routes/books.js`, `newIn()` in `src/lib/latestArrivals.js`): `{ total, books, nextOffset }`, newest copy first; "New In" = books with a copy added in the last 60 days, never fewer than the 40 newest books. `?all=1` returns
  everything in one request (the carousel); otherwise `?limit=` (1 to 48, default
  24) and `?offset=`. Not rate limited (no text search, one cheap query); cached
  60 seconds (`Cache-Control: public, max-age=60`); CORS open.
- `GET /api/books/search?paged=1`: `{ books, total, nextOffset }` with `?offset=`
  and `?limit=` (1 to 48, default 24). Without `paged` it returns the plain array,
  at most 60 books. A query shorter than 2 characters answers empty without
  touching the database; the description is searched from 3 characters
  (trigram indexes, migration 088). Filters: `q` (title, author, description,
  genre, ISBN), `genre` (exact), `topic` (comma list, up to 10, substring of the
  categories). Rate limited by `bookSearchLimiter`; cached 60 seconds.
- `GET /api/blog/posts`: light list (slug, title, excerpt, category, image, date; no bodies), 24 per page (`?offset=`, `?limit=` up to 100), cached 5 minutes; `GET /api/blog/posts/:slug` returns one post with its sanitised body. `?lang=fr` gives the French text where a post has a READY French version; every post carries `lang` (`en`/`fr`, the language of the text sent). Used by the home page's "What's New" slider only: the blog pages are rendered by the server. `?preview=1` (admin) adds drafts, never cached.
- Public book page (`/books/:id`) sweeps expired reservations at most once per 30 s per process (`expireStaleReservationsThrottled`); cart, checkout return, till and admin screens sweep every time.
- Numeric parameters are clamped by `parseIntParam` (`src/lib/parseParams.js`):
  only plain digits count (an array, `1e3`, `0x10`, spaces or a decimal give the
  default), a number outside its range is clamped, however many digits it has.
  The search `?offset=` stops at 100000 (an empty last page); `?ids=` on
  `/api/books/by-ids` keeps valid distinct ids only, at most 200. `%`, `_` and
  `\` in a search text are literal (`likeContains`, same file). No hostile
  number can reach SQL as an out-of-range integer, so none gives a 500 and an
  alert; `test/integration/numericParamFuzz.test.js` checks every GET route.
- **Public input handling (the rule):** every value read from `req.query` or
  `req.body` goes through `clean(value, max)` (`src/lib/validation.js`, a
  capped trimmed string, `""` for anything that is not a string),
  `parseIntParam` / `parseIdList` / `parseId` (`src/lib/parseParams.js`,
  `validation.js`), or is compared against a fixed list (`LIST.includes(v)`,
  `v === "1"`). Never call `.trim()`, `.toLowerCase()`, `.split()` or a regex
  directly on a raw value: Express 5 gives an ARRAY for a repeated query
  parameter (`?genre=a&genre=b`), so that throws, answers 500 and sends an
  alert email to an anonymous visitor. Repeated urlencoded form fields are
  collapsed to their first value in `src/app.js`, and multipart ones right
  after multer (`collapseRepeatedFields`, `src/lib/multiValueFields.js`); a
  field meant to repeat is named in `MULTI_VALUE_BODY_FIELDS`. The same
  numericParamFuzz test also sends repeated (`?x=a&x=b`), bracketed (`?x[]=a`,
  `?x[a]=b`), over-long and NUL-carrying text for EVERY query name found in
  `src/` to every GET route in the router stack (public and admin, with a real
  book so detail pages run) and fails on any 5xx or 429: a new route or
  parameter is covered without editing the test.
- **Return-to-the-list text** (`backQuery` hidden fields in admin Members,
  Announcements, Blog) is rebuilt by `makeBackQuery` (`src/lib/backQuery.js`):
  a whitelist of keys per screen, each value checked or clamped and encoded;
  the posted string is never appended to a redirect.
- **Multipart limits** (the multer instances in `src/app.js`): 200 fields, 210
  parts, 64 KB per text field (256 KB for blog and announcement bodies) plus
  the per-instance file size. Over the limit: 413 (file or field too large) or
  400 (too many fields) through the error handler, no alert; the blog and
  collections forms answer with their own sentence.
- Sitemap files past the last one (`/sitemap-books-<n>.xml`, `n` greater than
  ceil(in-stock books / per file)) are a 404 from the cached count, with no
  `OFFSET` scan.

### Curated collections

- Tables (migration `091_curated_collections.sql`): `curated_collections` (slug,
  English and French title and description, `curation_prompt`, `icon_path`,
  `banner_path`, `published`, `sort_order`, `last_generated_at`) and
  `curated_collection_books` (`status` suggested / approved / rejected, `reason`,
  `position`). Logic: `src/lib/collections.js`; admin routes
  `src/routes/admin/collections.js` (English only); public
  `src/routes/collections.js`; AI helper `src/lib/collectionSuggestions.js`;
  French text `src/lib/collectionTranslate.js`; pictures `src/lib/collectionImages.js`.
- **Atomic writes**: publish, the Approve/Reject ticks (`saveDecisions`), removing a
  book and reordering run in one transaction under a row lock on the collection
  (`lockCollection`), so publishing cannot interleave with un-approving the last book
  and a failure part-way saves nothing.
- **Review is mandatory.** The AI only writes `suggested` rows. An admin approves
  or rejects each book and presses Publish; a collection with no approved book or
  no French title and description cannot be published. Customers see only
  `approved` books that are in stock at the moment the page is drawn (read live
  from `book_copies`, never copied), so a sold book leaves the page by itself.
- **AI generation limits**: Generate / Add new books / Full rebuild / Update all /
  Translate call the paid API through the shared client (`anthropic.js`
  `askText`), so they count toward `AI_DAILY_MAX_CALLS`; 10 AI requests a
  minute per admin; each run looks at no more than 300 candidate books (batches of
  100, at most 12 picks per batch); invented book ids are dropped and each pick is
  re-checked against the database. Existing decisions are never overwritten.
- **Rebuild and last built**: `last_generated_at` ("Last built") is set only when
  at least one AI answer was usable. "Add new books" considers only copies added
  since that date; "Full rebuild" (a confirm page, `/admin/collections/:id/rebuild`)
  considers everything again; "Update all collections" runs "Add new books" for
  each built collection (no new collection is started after 40 s and each AI call's limit is cut to what is left of 85 s, so
  the request stays under Cloudflare's 100 s; skipped ones are reported as "not reached").
- **Uploads are stored in the database** (`images` table via `src/lib/imageStore.js`),
  so they survive deploys: the round icon (240 px PNG, circular) and an optional
  wide banner (1600 x 800 JPEG) with English and French alt text; JPEG, PNG or
  WebP, 5 MB at most, re-encoded on upload.
- **Deletion** is a confirm page with a tick box (`/admin/collections/:id/delete`);
  it removes the collection and its decisions, never the books.
- **Public pages**: `/collections/<slug>` and `/fr/collections/<slug>`
  (server-rendered, marketing CSP); unknown and unpublished slugs are a plain 404.
  **The book list is the Browse genre results** (maintainer decision 2026-10-26: "just pages of
  books like browsing by genre", not a carousel): `collection.ejs` uses the same elements and
  classes as the Browse results (`section.bk-results`, `.bk-grid`, `.bk-more-row` with `#bk-more`,
  `.bk-covernote`, the `.bk-sr` status line), styled only by `assets/books.css` (one owner per class:
  `assets/collections.css` has no rule for them, a test checks it), so the grid, gaps, cards, phone
  columns and Show more button are Browse's by construction. The first 24 books are in the HTML
  (no JavaScript needed, search engines read them); `public/page-collection.js` loads the next 24
  at a time from `GET /api/collections/<slug>/books?offset=&limit=` (`src/routes/collections.js`:
  `{ total, nextOffset, books }` in the `bookJson` shape of `/api/books/new-in`, limit 1-48 default 24,
  offset clamped to 0-100000, public, `max-age=60`; unknown or unpublished slug: 404, `no-store`), same
  order as the page (`approvedInStockBooks` with `offset`/`limit`; the admin's position, then title).
  The Show more button is in the HTML but `hidden`; the script shows it when `data-next-offset` is on
  the section, so a collection of 24 books or fewer, or no JavaScript, has no dead button. Behaviour
  copied from Browse: `aria-disabled` while loading, the status line "More books added to the results."
  (no counts), focus on the first new book. The heading of the list is for screen readers only (the
  title or banner above names the collection). The robots.txt rule for `/api/` is unchanged (the
  Show more endpoint is for the page's own script, not crawlers).
  Published collections with a book to show are listed in `sitemap.xml`
  (`src/routes/seo.js`, which drops its one-hour cache after any admin change).
  The Browse button row lists published collections that have at least one
  approved in-stock book (`listButtonCollections`).

### Anthropic client (`src/lib/anthropic.js`)

Every paid AI call (descriptions, French translations, genres, cover-photo reading,
the price check, collection suggestions and "Translate to French") goes through ONE
function, `anthropic.request({ feature, model, system, messages, maxTokens, tools,
timeoutMs, signal, env, fetchImpl, claim })`. It builds the request (URL, headers,
`anthropic-version`, JSON body), takes a slot of the shared daily cap
(`aiLimits.acquireAiCall`; `claim: false` when the caller already holds its slot, as
the price check does), enforces the time limit, counts the call in `ai_usage_stats`
(`aiUsageStats.recordCall`, which also drives the credit alert email) and returns
`{ ok: true, data, status, ms }` or `{ ok: false, kind, message, status?, body? }` with
`kind` one of `no-key`, `cap`, `no-credit`, `rate-limit`, `http`, `timeout`, `network`,
`invalid`. It never throws and never logs; each feature maps the kinds to its own
fallback (usually `null`). `askText(prompt, opts)` is the one-prompt text helper that
answers `{ text, reason }` (used by the descriptions, the collection helpers).

- **Change a model or a price:** edit `src/lib/anthropicModels.js` only. `MODELS`
  holds `text`, `vision` and `priceLookup` (id and USD per million tokens); the usage
  report's cost estimate reads the same table. A test fails if a model id or the API
  URL appears anywhere else in `src/`.
- **Add an AI feature:** add its name to `FEATURES` in `aiUsageStats.js` (and the
  report label), build the prompt in the feature's own module, call `request()` with a
  model key from `MODELS` and that feature's own `maxTokens` / `timeoutMs` (limits are
  per feature on purpose: 8 s texts, 20 s photos, 12 s price check, 45 s collection
  suggestions), and decide what each failure kind means for that feature. Do not call
  `fetch` for the Anthropic API anywhere else.
- **Tests:** `test/unit/aiClientEquivalence.test.js` compares every feature against
  golden outgoing requests and outcomes recorded from the code before the client
  existed (`scripts/ai-golden.js`, harness `test/helpers/aiMatrix.js`); refresh the
  golden file only when a request is meant to change.

### Inventory search by sentence (`src/lib/inventoryQuerySpec.js`, `src/lib/inventoryNlSearch.js`)

- `POST /admin/inventory/ask` (admin, CSRF, `aiAdminLimiter` 10 a minute per admin, sentence <= 300 characters):
  ONE `request()` (feature `search`, `MODELS.text`, 15 s, forced tool call `inventory_query`) turns the sentence into
  a query **spec**; the model never writes SQL. The sentence goes in `<request>` tags as data. The answer is
  validated (`validateSpec`), the outcome audited (`inventory.ai_search`), and the browser redirected (303) to
  `/admin/inventory?nl=<validated spec JSON>`; the sentence itself only travels in a one-time flash. Any failure
  (no key, cap, credit, timeout, refused spec, "cannot") redirects to the normal page with a message.
- The spec language: a whitelist of book fields (`title author isbn publisher description published_year genre
  binding`) and copy fields (`price publisher_price acquisition_cost suggested_price condition location status source
  acquired_at added_at sold_at clearance notes`); operators by type (`= != < <= > >= contains not_contains in not_in
  between is_empty is_not_empty`); field-vs-field comparisons of the same type; `and`/`or` groups (3 levels, 12
  children, 20 conditions); `copies` in_stock (default) / sold / all; an optional sort. No personal-data column
  (reservation names, emails, phones) is in the whitelist.
- Semantics: the whole condition is checked on a (book, copy) pair inside ONE `EXISTS`, so every copy-level part is
  true of the same copy (same rule as the filters). A blank value never satisfies a comparison (`price !=
  publisher_price` = both set and different) unless the leaf has `or_missing: true`.
- `GET /admin/inventory?nl=` and `GET /admin/inventory/results.csv?nl=` validate the spec AGAIN on every request
  (a tampered link gets a message / a 400, never a 500) and build parameterised SQL themselves (`buildSpecWhere`,
  `specCopyCondition`, `specOrderBy`); "Understood as" is `explainSpec(spec)`, the server's wording. A sentence
  search replaces the text search and filters of that page view.
- Tests: `test/unit/inventoryQuerySpec.test.js` (validation, SQL, wording) and
  `test/integration/adminInventoryNlSearch.test.js` (real routes and database, Anthropic faked at `fetch`).
  To add a field: one entry in `FIELDS` (column, type, label); the tool schema and the prompt are built from it.

### ISBNdb price suggestion

- `GET /admin/inventory/isbndb-price?isbn=...&condition=new`
  (`src/routes/admin/inventoryLookup.js`, `src/lib/isbndbPrice.js`): the
  publisher's list price for a New book, shown on Add Book with a "Use this
  price" button. **Never saved automatically**: the maintainer compares it with
  the price printed on the book.
- ISBNdb returns USD, GBP or EUR; the currencies are converted with the rates on
  **Admin > Pricing** (`usd_eur`, `gbp_eur` in `pricing_settings`) and rounded to
  the nearest 0.05 EUR. One paid call per ISBN per 3 days (in-memory cache,
  `ISBNDB_PRICE_TTL_MS`), skipped while ISBNdb is paused (bad key, quota).
  Keys and knobs: see the environment table.

### Old-new books pricing exception

French fixed book price law (loi Lang) obliges the publisher's price, at most 5%
off, for New books. `resolveCopyPricing()` in `src/lib/inventory.js` applies the
**2-year rule**: a New book published more than two years ago
(`isPublishedOverTwoYearsAgo`, two years after the end of the published
year / month / day) is free-priced like a used one and its publisher's price is
optional. The admin note (`views/admin/inventory/_publisher_price_help.ejs`,
`public/publisher-price-rule.js`) also reminds the maintainer that the law
additionally requires the last supply to be more than **six months** ago; the
code cannot check that, so it is a prompt to ask the accountant. The till uses
the same function (`src/lib/till.js`).

### Locations

Shelf locations (`book_copies.location`, migration 043) keep the capitals the
volunteer typed. `normalizeLocation` trims, collapses spaces and caps at 40
characters; comparison and grouping are **case-insensitive** (`locationKey`,
`sameLocation`, `uniqueLocations` in `src/lib/inventory.js`): "Store", "STORE"
and "store" are one place, shown with the most common spelling.

### Shop constants (`src/lib/legal.js`)

One file holds the facts printed on many pages and emails; change them there
only: `SHOP_PHONE_DISPLAY` / `SHOP_PHONE_TEL`, `SOCIAL_LINKS` (Instagram and
Facebook; an empty value hides the icon), opening days and hours
(`SHOP_OPEN_DAYS`, ...), the extra-hours note link, reservation limits
(`RESERVATION_DAYS` and friends), `SHOP_STREET_NUMBER`, `VAT_NOTICE_ARTICLE`.

### DATABASE_URL is set by hand

In `render.yaml`, `DATABASE_URL` is `sync: false`: the value is typed in the Render
dashboard (the database's Internal Database URL), so a Blueprint sync never
overwrites a rotated password. Rotation steps: runbook section b, "Rotating the
database password". Staging uses `fromDatabase` instead (`render.staging.yaml`).

## Deploy sequence

Production runs on Render, configured entirely by `render.yaml` (a
Render Blueprint) at the repo root:

1. A push to `main` triggers **two independent things in parallel**:
   Render's own webhook starts a deploy, and GitHub Actions runs the CI
   workflow (`.github/workflows/ci.yml`). Neither currently gates the
   other — CI passing is not required for Render to deploy. Treat a
   CI failure as "go fix this," not as something that already stopped a
   bad deploy.
2. Render's `buildCommand` runs `npm ci --omit=dev`.
3. Render's `preDeployCommand` runs `npm run migrate` before the new
   version takes traffic; if a migration fails the deploy is aborted and the
   running version keeps serving. Then `startCommand` runs
   `npm run seed; npm start` every time the service starts. `migrate`
   is tracked (each file runs once) and takes an advisory lock; `seed` is
   safe to re-run: it only bootstraps a brand-new database (first admin when
   none exists and the email is free, plus sample content in that same run),
   never touches an existing account or password, and never blocks startup
   (failures are logged and emailed, exit code 0; `;` rather than `&&`). Rolling back to an older commit does NOT undo migrations.
   The Node version is pinned to an exact 22.x patch (`.node-version`, and `engines` `22.x` in `package.json`; which every GitHub workflow reads through `node-version-file`), and `render.yaml` sets
   `healthCheckPath: /healthz` (a `SELECT 1`) so a deploy that can't
   reach the database never goes live.
4. Migrate runs as Render's pre-deploy command and seed in `startCommand`.
   Rolling back is covered in [`../docs/runbook.md`](../docs/runbook.md).

A failing migration stops the deploy (the old version keeps serving). Nothing
blocks a bad app boot or a bad-but-valid migration automatically — the safety
net is keeping migrations small and safe, keeping CI green, and watching the
deploy.
