# Architecture

> For diagrams of the whole system (context, request flow, data model, payments,
> deploy, backups, security) see [`../docs/architecture.md`](../docs/architecture.md).

A quick technical map of how this app is put together — routing, views,
data, config, and how a change gets from a commit to production. See
[README.md](README.md) for what each feature does, and
[../README.md](../README.md) for the marketing-site side of things.

## One app, two front ends

`umas-books` is a single Express process (`src/index.js`) that serves
**both** the public marketing site (plain pages: About, Books, Events, …)
**and** the members-area app (accounts, forum, admin, reservations, …). There
is no separate marketing server — Squarespace was retired, and these
pages now live in this repo's root and are rendered by this same process.
That's why `render.yaml`'s `buildFilter` covers the whole repo, not just
`umas-books/`.

## Canonical marketing routes

Registered in `src/index.js`, each backed by a view under
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
`assets/site.js` COMMON (EN + FR), so the language toggle and the French server
render both work. Success redirects to `/<page>?sent=1`, which shows a thank-you
panel. The repeated `days` / `times` fields are in `MULTI_VALUE_BODY_FIELDS` in
`src/index.js` so the multi-selects are not collapsed to their first value. The
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
`src/index.js`) before rendering — stricter than default since these
pages need no forms/scripts beyond the shared header's language toggle.

Both CSPs (app-wide helmet and `marketingCsp`) have `form-action 'self'` only (`formActionSources` in `src/index.js`): no form of ours posts to another site, and no redirect to another site follows a form POST, because books and seats are reserved here and paid in the shop (Chrome enforces `form-action` on the redirect after a POST, which is why HelloAsso hosts used to be listed there for the old online checkout). The HelloAsso membership form is an iframe/link allowed by `frame-src` instead; `src/lib/helloassoHosts.js` now only tells whether `HELLOASSO_API_BASE` is the sandbox.

## Legacy redirects

The booking calendar has been renamed twice ("classes" → "programs" →
the current `/sessions`). Rather than break old bookmarks/links, every
old address 301-redirects to the current one, forwarding any query
string:

| Old | Redirects to | Defined in |
|---|---|---|
| `/classes.html` | `/programs.html` | `src/index.js` |
| `/classes` | `/sessions` | `src/index.js` |
| `/admin/classes` | `/admin/sessions` | `src/index.js` |
| `/programs` | `/sessions` | `src/index.js` |
| `/admin/programs` | `/admin/sessions` | `src/index.js` |
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

- **Condition grades and binding** — `book_copies.condition` is one of four
  grades, `new`, `very_good`, `good`, `acceptable` (default `very_good`),
  defined once in `CONDITIONS` in `src/lib/inventory.js` (value, English and
  French label, one-line description) and used by the admin forms, the public
  book page (every in-stock copy is listed with its grade, plus a "What the
  grades mean" legend), the cart and the order lines/emails (`orderItemLabel`
  appends the grade, joined from the copy via `order_items.book_copy_id`).
  Migration 048 remapped the old grades (good to very_good, fair and poor to
  acceptable) and added a CHECK constraint; migration 078 made the grades
  New / Very Good / Good / Acceptable (like_new became very_good, and
  `normalizeCondition` still accepts like_new, fair and poor as aliases). A copy that cannot be sold at all
  is not a grade: it gets the status `damaged`. `books.binding` (migration
  048, NULL when unknown) is `hardcover`, `trade`, `mass_market` or `other`
  (`BINDINGS`, `normalizeBinding`; migration 077 renamed `paperback` to
  `trade`, and `normalizeBinding` still accepts `paperback` as an alias; the
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
  `src/lib/inventory.js` (trimmed, spaces collapsed, upper-case, 40 chars).
  There is no locations table: the dropdown (a `<datalist>`, partial
  `location_options`) is `SELECT DISTINCT location`, so a newly typed place
  appears from then on. The scan/add flow carries the current location
  through hidden fields and `public/inventory-location.js` (localStorage);
  `/admin/inventory/move` moves one copy per scanned ISBN (`parseScan`), and
  each move writes a `copy.move` audit row (location codes only).
- **Awards & best-seller lists** — `book_awards` (migration 050, tightened by
  077) plus `books.awards_checked_at / awards_check_state`. Code in
  `src/lib/awards/`: `wikidata.js` (SPARQL by ISBN, awards P166 and
  nominations P1411), `nyt.js` (optional, `NYT_API_KEY`, in-process 5/min and
  500/day gate), `index.js` (`checkBookAwards`, `drainAwards`), `display.js`
  (what customers may see). **Trust model:** there is no review step and no AI
  source. Every row is `verified` and shown at once: it came from Wikidata, the
  NYT API, or an admin typed it (`manual`); migration 077 deletes the old AI,
  pending, approved and rejected rows and its CHECK constraints forbid them.
  Every lookup fails open and never blocks a save. A new book is checked in the
  background right after intake; a timer in `src/index.js` (every 2 minutes, 5
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

- **Suggested prices** — `src/lib/pricing/` (migrations 053, 054). Prices are
  only ever *suggestions*; a volunteer accepts or changes them and nothing is
  published automatically. `rules.js` is the pure rules engine (no network,
  no database; the order of checks is written at its top): new = publisher
  price; no ISBN = manual review; mass market = EUR 5 ("trade" and "other" follow the normal rules); online value M (median
  of used listings in EUR, outliers trimmed; else publisher price x 0.35; else a
  typical value by binding) under 6 = Rule A (EUR 5), under 20 = Rule B (EUR
  8), under 50 = Rule C (75% of M, rounded to 0.50), 50 or more = manual
  review; hardcovers never below EUR 10; clearance (EUR 1) when 2+ copies of
  the book are already in stock (Rule A / mass market, by default). The
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
  `copy.reprice`).
- **Price sticker colors** — the shop marks copies with colored price stickers
  (3 yellow, 5 green, 8 blue, 10 red, any other used price purple, clearance
  orange, new books white with the publisher's price written on). Nothing is
  stored: `src/lib/priceColors.js` is the single source of truth (levels with
  key, EUR amount, EN/FR label, hex and text color) and derives a copy's color
  from its data, in this order: `is_clearance` -> orange; condition `new` ->
  white (retail); price exactly 3/5/8/10 -> that color; else purple. Admin
  views get it as `app.locals.priceColors`; `views/partials/sticker_chip.ejs`
  draws a chip and `sticker_legend.ejs` the legend. The price control
  (`_price_control.ejs` + `public/price-suggestion.js`) shows a live chip that
  follows the price level and the condition (the scheme reaches the script as
  JSON in `data-sticker-levels`). For new books the suggestion panel says
  "New book: sell at the publisher's price (max 5% off)" and never proposes a
  used level (`summaryLabel` in `lib/pricing/index.js`; the loi Lang rules in
  `resolveCopyPricing` are unchanged).

  | Route | Purpose |
  |---|---|
  | `GET /admin/inventory/stickers` | printable sheet of in-stock copies (`src/routes/admin/stickers.js`, `views/admin/inventory/stickers.ejs`): filters `?since=` (default last 7 days, Paris time), `?location=`, `?color=`; sorted by location then color |
  | `GET /admin/inventory/stickers?format=csv` | same rows as a CSV download (audit action `stickers.csv`); the smoke crawler skips `?format=csv` links |

  The sheet has an `@media print` stylesheet (menu hidden, chips keep their
  colors via `print-color-adjust: exact`). Mounted before the inventory router
  because `stickers` would otherwise be read as a book id.
- **The till** — in-person sales (`src/routes/admin/till.js`, `src/routes/admin/labels.js`,
  libs `till.js`, `tillScan.js`, `cardPayments.js`, `accounting.js`, `code128.js`;
  views `views/admin/till/`, `views/admin/inventory/labels.ejs` and `label_sheet.ejs`;
  scripts `public/till.js`, `till-day.js`, `labels.js`). English. Admins, plus accounts with "Till access"
  (`users.is_till`, `requireTillOrAdmin`, only on the till page and its scan/check/sale/release/void/receipt/read-only end-of-day routes).
  See `docs/architecture.md` ("The till", "Till correctness and money safety") for the data model.

  | Route | Purpose |
  |---|---|
  | `GET /admin/inventory/labels` | pick copies (filters like the stickers page); `?id=<copyId>` (repeatable), `?all=1` render the print sheet; `?w=&h=` mm (default 50x25), `?layout=roll\|sheet`; audit `labels.print` |
  | `GET /admin/till` | the till screen: scan box, lines, Cash / Card, quick items, today's sales with Void |
  | `POST /admin/till/scan` | JSON: resolves a scanned code (order: `UB-` label, quick-item barcode, ISBN, unknown) |
  | `POST /admin/till/check` | JSON: the sale's validation without writing (called when Cash / Card opens) |
  | `POST /admin/till/sale` | JSON: records the sale in one transaction (`sale_token` + basket hash make it idempotent; `expectedTotalCents` must match; 409 `price_changed` / `day_closed` / `token_replay`); audit `till.sale`, `till.price_override`, `till.sale_backdated`, `till.day_reopen` |
  | `POST /admin/till/release` | releases a copy from an EXPIRED online cart (the cart's release function); audit `till.release_cart` |
  | `POST /admin/till/sales/:id/void` | same-day void with a reason; restocks copies and quick items; audit `till.void`; card sales carry the "I refunded the card" tick |
  | `POST /admin/till/sales/:id/refunded` | ticks "I refunded the card" on a voided card sale; audit `till.refund_confirmed` |
  | `GET /admin/till/sales/:id/receipt` | printable receipt (no customer data, "TVA non applicable") |
  | `GET /admin/till/items`, `POST /admin/till/items[/:id]`, `POST /admin/till/items/:id/generate-code`, `GET /admin/till/items/:id/label` | "Other stock (not books)": quick items with optional barcode, stock and a Code 128 label for shop codes |
  | `GET /admin/till/day[?day=][&format=csv]`, `POST /admin/till/day/open` (today or a past unclosed day), `POST /admin/till/day/close`, `POST /admin/till/day/reopen` | end of day: totals, opening float, count and close (locks voids, needs a confirmation if no float), reopen (admin, reason), CSV; unclosed past days and unrefunded voided card sales appear in the dashboard's Needs attention |
  | `GET /admin/reports/accounting[?format=csv]` | Accounting export (`src/lib/accounting.js`): one row per Paris day, category and payment method; no customer data |
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
  drop-in seats `released`), and the cart in `src/lib/cart.js`
  (`createReservation`). `src/lib/orderSweeps.js` (every 6 h, started in
  `src/index.js`, no payment-provider call) releases lapsed reservations, sends the
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

Every one the code actually reads (`grep -rohE "process\.env\.[A-Z_]+"
src/` is the ground truth if this list ever drifts):

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string — see [Migration process](#migration-process) for how `PGSSLMODE` affects it |
| `SESSION_SECRET` | yes (app refuses to start if unset) | signs the session cookie |
| `PORT` | no (defaults 3000) | HTTP listen port |
| `NODE_ENV` | no | `production` turns on startup env validation (`src/lib/env.js`: fails fast listing every missing required var, warns about disabled email/payments), secure session cookies, and `src/lib/baseUrl.js` requiring `APP_BASE_URL`/`RENDER_EXTERNAL_URL` |
| `PGSSLMODE` | no | set to `disable` for local dev (no TLS); any other value uses `{ rejectUnauthorized: false }` — see `src/db.js` |
| `APP_BASE_URL` | no | overrides the auto-detected base URL (emailed links, the membership payment return URL) |
| `RENDER_EXTERNAL_URL` | no | set automatically by Render; same purpose as `APP_BASE_URL` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | no | outgoing email (password reset, email verification, contact form, every alert); when unset, development and tests log instead of sending, while **production throws** (the outbox keeps and retries the message rather than marking it sent) |
| `CONTACT_TO` | no (defaults `admin@umasbooks.org`) | where the Contact form and forum reports deliver; one address or several separated by commas |
| `ALERT_TO` | no (falls back to `CONTACT_TO`, then `admin@umasbooks.org`) | where every site alert goes (errors, failed/stuck email, failing background jobs, launch warnings); comma separated list. The GitHub workflows use the repository variable of the same name |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `SEED_ADMIN_PASSWORD` required the first time `npm run seed` creates an admin | one-time bootstrap of the first admin account; never blocks startup. `SEED_SAMPLE_CONTENT=true` forces sample content, `SEED_STRICT=true` makes a failure exit 1 (CI) |
| `ANTHROPIC_API_KEY` | no | powers inventory photo-scan and auto-generated book descriptions |
| `NYT_API_KEY` | no | New York Times Books API key (free from developer.nytimes.com); enables verified best-seller rows. Never logged |
| `AWARDS_LOOKUPS` | no | `off` stops all awards lookups (kill switch) |
| `COVER_BACKFILL` | no | `off` stops the background job that copies book covers to our own server (the test helpers set it). Only a 404, a placeholder or an invalid image counts as a failed attempt; 5xx, timeouts and network errors do not, and 3 in a row stop the batch |
| `ANTHROPIC_WORKSPACE_ID` | no | optional workspace header on Anthropic API calls |
| `PRICING_AI` | no (off unless `1` or `true`) | turns on the AI market check behind price suggestions (also needs `ANTHROPIC_API_KEY`); without it prices come from the built-in rules only |
| `PRICING_AI_MODEL` | no (defaults to the model used for book descriptions) | model for the market check; it must support the web search tool |
| `PRICING_AI_DAILY_MAX` | no (defaults 150) | most AI market lookups per day, counted from the database so a restart cannot reset it; `0` switches lookups off |
| `HELLOASSO_CLIENT_ID` / `HELLOASSO_CLIENT_SECRET` / `HELLOASSO_ORG_SLUG` | no (the membership sync is off without them) | HelloAsso API credentials, used for the membership only |
| `HELLOASSO_API_BASE` | no (defaults to production) | set to HelloAsso's sandbox URL for testing |
| `TRUST_PROXY_HOPS` | no (default 2 in production, 1 elsewhere) | integer 1 to 5, number of reverse proxies in front of the app (Render's edge and its internal proxy = 2; DNS points straight at Render, the association has no Cloudflare account; a real CDN added later changes this: re-check); decides `req.ip` (`src/lib/trustProxy.js`). Check on `/admin/diagnostics/client-ip` |
| `APP_BASE_URL` | yes once preview is off | `https://umasbooks.org`; the only base URL used on a live site, and other Hosts are redirected to it (`src/middleware/canonicalHost.js`); other methods on another Host get 421, except `/healthz` and `/webhooks/helloasso` |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` | no | only orders of this HelloAsso form (its `formSlug`) grant membership; unset = any Membership-type form |
| `PREVIEW_MODE` | no (off when unset) | `true` or `1` (any case) turns on [preview mode](#preview-mode): coming-soon banner, payments off, search engines kept out. Set in the Render dashboard, not in `render.yaml` |

`render.yaml` lists every variable above that a rebuild needs (secrets as
`sync: false`), except `PREVIEW_MODE`, which is deliberately left out.

CI (`.github/workflows/ci.yml`) has its own separate set of throwaway
values for these (a Postgres service container, a dummy
`SESSION_SECRET`, etc.) — see that file, not this table, for what CI
actually uses.

## Preview mode

- **Preview mode** (`PREVIEW_MODE=true`, parsed by `isPreviewMode()` in
  `src/lib/preview.js`; a middleware mounted first in `src/index.js` sets
  `res.locals.preview`) is for showing the site, with sample data only, before
  it opens. Off by default. While on:
  - every customer page shows a bilingual banner (`views/partials/preview_banner.ejs`,
    included by `partials/mkt_chrome_header.ejs`; marketing pages also get the strings
    in `assets/site.js` COMMON `preview.*`), linking to `/contact?topic=feedback`
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
  in `src/index.js`, before `db.js` loads. Missing `DATABASE_URL` /
  `SESSION_SECRET` → one error naming all of them, exit 1. Unset Gmail,
  HelloAsso, base-URL or `ALERT_TO` variables → a loud `[env] WARNING` line, since
  those features otherwise fail silently (no Gmail also means no error-
  alert emails). A live-site misconfiguration also raises a launch alert, at
  most once per 24 h each (`alert_flags`), and a red banner on every admin page.
  Test/dev are untouched.
- **Graceful shutdown** (`src/index.js`): SIGTERM/SIGINT clear the two
  maintenance timers, `server.close()` (in-flight requests, e.g. a
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
- **Monitoring and backups** (all GitHub Actions, independent of Render; every
  alert goes to the repository variable `ALERT_TO`, default admin@umasbooks.org; a
  weekly "Send a test alert" proves the channel; the restore test also checks
  the dump holds the till, shop, outbox and audit tables and the newest migration;
  the freshness check also watches the `monthly/` copy):
  `uptime-check.yml` polls `/healthz` every 30 minutes (Actions minutes are metered on a private repo) and emails once on
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
- `purgeExpiredPersonalData(pool)` runs at boot and daily from `index.js`:
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
unless `PREVIEW_MODE` is on (`--allow-live` overrides); unknown flags refused;
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
  `req.langFromCookie`, `req.tr` and `res.locals.tr`, and replaces the date
  helpers in views with French-aware ones (`fr-FR` / `en-GB`, still Europe/Paris;
  also `formatDateLong`, "3 octobre 2026"). `app.locals` dates stay en-GB for
  non-request callers such as emails. Responses with `Cache-Control: public`
  get `Vary: Cookie, Accept-Language` (static assets are mounted earlier and
  untouched).
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
  confirmation, reminders and inactivity warning follow it (the legal blocks of the
  order email stay bilingual FR/EN in both languages); `sendResetLink`, the verification
  mails and the other account mails use `user.lang`; password-policy messages take a
  translator (`validateNewPassword(pw, req.tr)`). Use `normLang` / `pickLang` for untrusted values.
  NULL means English.
- **Marketing pages** (`views/marketing`) are written in English with
  `data-i18n` / `data-i18n-html` / `data-i18n-attr` hooks and one EN and one FR
  dictionary (`pageI18nEn/Fr` in the page, `COMMON` in `assets/site.js`). They are
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
  prices (the books search in `views/marketing/books.ejs`, `public/favorites-page.js`) read
  `<html lang>`. JSON APIs keep numbers. Never print a price with `toFixed(2)`
  to a customer.
- **Safety net:** `test/helpers/i18nAudit.js` (`visibleText`, `untranslated`,
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
  rows in a single statement, and a daily step in `src/index.js` runs it and
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

## Reservations: reserve online, pay in the shop

**Reserving requires an account.** A guest can browse, search and fill the cart
(a list of lines in the session, at most 20), but `POST /cart/reserve` (and the
old `GET /cart/checkout`, which only redirects) send them to
`/login?returnTo=/cart` (checked server-side, after the preview-mode refusal and
before anything is validated, locked or created). Login regenerates the session
but copies the cart across; the returnTo (local paths only, `src/lib/returnTo.js`)
travels in the login form and, through signup, inside the single-use
`email_verification_tokens.return_to` / `password_reset_tokens.return_to`, so
signup -> confirm -> choose password -> login ends back on the cart. The
reservation is placed under the account's confirmed email (`orders.user_id`,
`buyer_email` from the `users` row, never from the form; an unconfirmed account
is refused); the name is pre-filled from `display_name` and stored on the order.
Orders from before this rule have `user_id` NULL and keep working by token
(`/cart/return`, exports by email).

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
- **Old online checkout.** `runCartMaintenance` (every 10 min) only releases
  leftover `in_cart` holds from before the change; no payment provider is asked,
  nothing creates a `pending` order any more, and `/webhooks/helloasso` only handles
  membership payments (an old notification naming a checkout order is logged).

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
- Worker `processOutbox` runs every 60 s from `index.js` (advisory lock key
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

`expiryFromPayments` chains payments (`max(paid_at, previous end) + 365 d`);
only Authorized orders over 0 EUR on `HELLOASSO_MEMBERSHIP_FORM_SLUG` (when
set) count; a result in the past grants nothing. A payer email with no
confirmed account is stored in `membership_payments` with `user_id NULL`,
`unmatched_at` set, and alerted (once an hour, from `alertUnmatchedPayments`,
also run by the outbox tick); `/admin/members` lists them and
`linkUnmatchedPayment` attaches one and grants in one transaction.
`lib/memberStatus.js` is the one definition of "active member now"
(`attachUser`, login, favorites, member counts) and `isoDateParis` formats end
dates in Paris time.

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
   The Node version is pinned to 22 (`engines` in `package.json`,
   `.node-version`, CI's `NODE_VERSION`), and `render.yaml` sets
   `healthCheckPath: /healthz` (a `SELECT 1`) so a deploy that can't
   reach the database never goes live.
4. Migrate runs as Render's pre-deploy command and seed in `startCommand`.
   Rolling back is covered in [`../docs/runbook.md`](../docs/runbook.md).

A failing migration stops the deploy (the old version keeps serving). Nothing
blocks a bad app boot or a bad-but-valid migration automatically — the safety
net is keeping migrations small and safe, keeping CI green, and watching the
deploy.
