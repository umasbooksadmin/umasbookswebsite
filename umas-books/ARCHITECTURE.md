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
**and** the members-area app (accounts, forum, admin, checkout, …). There
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

Static assets are served directly from the repo root, not rendered:
`/assets/*` (CSS/JS/images) and `/logo.png`. The app's own static assets
(favicons, `admin.css`, `public/app.js`, …) are served separately from
`umas-books/public/` at the site root (`/style.css`, `/admin.css`, etc.)
— two different `express.static` mounts, one per directory.

Every marketing route sets its own restrictive CSP (`marketingCsp` in
`src/index.js`) before rendering — stricter than default since these
pages need no forms/scripts beyond the shared header's language toggle.

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

28 application tables (`migrations/`), plus `schema_migrations` and the
`session` store table (created by `migrate.js` / `connect-pg-simple`
rather than by a numbered migration), grouped by what they belong to:

- **Condition grades and binding** — `book_copies.condition` is one of four
  grades, `new`, `like_new`, `very_good`, `acceptable` (default `very_good`),
  defined once in `CONDITIONS` in `src/lib/inventory.js` (value, English and
  French label, one-line description) and used by the admin forms, the public
  book page (every in-stock copy is listed with its grade, plus a "What the
  grades mean" legend), the cart and the order lines/emails (`orderItemLabel`
  appends the grade, joined from the copy via `order_items.book_copy_id`).
  Migration 047 remapped the old grades (good to very_good, fair and poor to
  acceptable) and added a CHECK constraint. A copy that cannot be sold at all
  is not a grade: it gets the status `damaged`. `books.binding` (migration
  047, NULL when unknown) is `hardcover`, `paperback` or `mass_market`
  (`BINDINGS`, `normalizeBinding`); it belongs to the edition, is prefilled
  from Open Library's `physical_format` (`mapBinding` in
  `src/lib/bookLookup.js`) and never overwritten by a second copy.
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
- **Accounts & auth** — `users`, `password_reset_tokens`,
  `email_verification_tokens`
- **Shop / checkout** — `books`, `book_copies`, `orders`, `order_items`
  (an order line references *either* a book copy *or* a class drop-in
  seat, never both — see the `order_items_one_item_type` check
  constraint)
- **Legacy trust decision (one-time):** migration 032 marked every
  account that existed at the time as email-verified, since forcing
  re-verification would lock out real members. Email squatting that
  predates it (someone registering another person's address first) is
  therefore not detectable and can only be fixed by an admin editing or
  disabling the account at `/admin/members`. Changing an account's email
  there clears verification and sends a link to the new address. Accounts
  an admin creates are verified immediately, justified because the invite
  link must be clicked from that same inbox to set a password.
- **Membership** — `membership_payments` (HelloAsso payment records,
  matched to a `users` row by verified email — see
  `src/lib/membership.js`). The sync also re-runs (in the background)
  when an account becomes eligible: email verified, password reset
  completed (which also verifies the email), or admin-created. A recorded
  payment is revoked only when HelloAsso returns that order without an
  Authorized payment, never merely because the fuzzy search omitted it.
- **Community** — `forum_threads`, `forum_replies`, `announcements`,
  `blog_posts`, `favorites`
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
| `APP_BASE_URL` | no | overrides the auto-detected base URL (emailed links, HelloAsso return URLs) |
| `RENDER_EXTERNAL_URL` | no | set automatically by Render; same purpose as `APP_BASE_URL` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | no | outgoing email (password reset, email verification, contact form); logs to console instead of sending when unset |
| `CONTACT_TO` | no (defaults `admin@umasbooks.org`) | where the Contact form delivers |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `SEED_ADMIN_PASSWORD` required the first time `npm run seed` creates an admin | one-time bootstrap of the first admin account |
| `ANTHROPIC_API_KEY` | no | powers inventory photo-scan and auto-generated book descriptions |
| `ANTHROPIC_WORKSPACE_ID` | no | optional workspace header on Anthropic API calls |
| `HELLOASSO_CLIENT_ID` / `HELLOASSO_CLIENT_SECRET` / `HELLOASSO_ORG_SLUG` | no (checkout shows "not set up yet" without them) | HelloAsso Checkout API credentials |
| `HELLOASSO_API_BASE` | no (defaults to production) | set to HelloAsso's sandbox URL for testing |

CI (`.github/workflows/ci.yml`) has its own separate set of throwaway
values for these (a Postgres service container, a dummy
`SESSION_SECRET`, etc.) — see that file, not this table, for what CI
actually uses.

## Process lifecycle and operations

- **Startup checks** (`src/lib/env.js`, production only): called first thing
  in `src/index.js`, before `db.js` loads. Missing `DATABASE_URL` /
  `SESSION_SECRET` → one error naming all of them, exit 1. Unset Gmail,
  HelloAsso or base-URL variables → a loud `[env] WARNING` line, since
  those features otherwise fail silently (no Gmail also means no error-
  alert emails). Test/dev are untouched.
- **Graceful shutdown** (`src/index.js`): SIGTERM/SIGINT clear the two
  maintenance timers, `server.close()` (in-flight requests, e.g. a
  HelloAsso webhook, are allowed to finish; idle keep-alive sockets are
  dropped), then `pool.end()`, then exit 0. A 10-second hard-exit timer
  exits 1 if requests do not drain. A listen failure (e.g. `EADDRINUSE`)
  logs a clear message and exits 1.
  Covered by `test/integration/gracefulShutdown.test.js`.
- **Monitoring and backups** (all GitHub Actions, independent of Render):
  `uptime-check.yml` polls `/healthz` every 30 minutes (Actions minutes are metered on a private repo) and emails once on
  the second consecutive failure and once on recovery;
  `nightly-db-backup.yml` uploads one complete `pg_dump` (image bytes
  included, login sessions excluded) to the private Backblaze B2 bucket and
  fails if the offsite settings are missing; `backup-restore-test.yml` downloads the newest
  dump from B2, restores it into a scratch postgres:18 monthly and checks it. The manual restore procedure
  is in [README.md](README.md#restoring-from-a-backup).

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
  `TOTP_ENCRYPTION_KEY` (generated by render.yaml; falls back to
  `SESSION_SECRET` if unset). Changing that
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
  releases any active book reservation, and **anonymises** (never deletes)
  paid orders and HelloAsso payment rows, which French accounting law makes
  us keep for 10 years. Forum posts keep their text with no author name.
- `purgeExpiredPersonalData(pool)` runs at boot and daily from `index.js`:
  sign-ups 12 months after the event, expired reset/verification tokens
  after 7 days, orders and payment records after 10 years, accounts with no
  login for 3 years (never admins or current members) — emailed a warning
  first (`users.inactivity_warned_at`), deleted 30 days later unless they log
  in, which clears the warning (any signed-in request also counts as
  activity: `attachUser` refreshes `last_login_at` at most once a day).
  Contact details on `book_copies` that are no longer reserved (sold or
  cancelled) and on `expired`/`cancelled` orders are removed after 30 days.
  The warning email is claimed (`inactivity_warned_at` set) before it is
  sent and released if the send fails, so overlapping instances don't
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
  says they are kept until the sender asks us to delete them), and server
  logs sit with Render. Log lines never contain emails.


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
  when the visitor has chosen a language; NULL for admin-created accounts) and
  `orders.lang` (set at checkout). The order confirmation, reservation
  confirmation/reminder and inactivity warning follow it (the legal blocks of the
  order email stay bilingual FR/EN in both languages); `sendResetLink`, the verification
  mails and the other account mails use `user.lang`; password-policy messages take a
  translator (`validateNewPassword(pw, req.tr)`). Use `normLang` / `pickLang` for untrusted values.
  NULL means English.
- **Marketing pages** (`views/marketing`) keep their client-side dictionaries
  (`data-i18n`, `pageI18nEn/Fr`); the shared header/footer chrome is also
  rendered in French on the server.
- **Safety net:** `test/helpers/i18nAudit.js` (`visibleText`, `untranslated`,
  shared `ALLOWLIST` for brand names and legal identifiers) reports text that is
  identical in the English and French render of a page. Append each translated
  customer page to `PAGES` in `test/integration/i18nCoverage.test.js`.
  `test/integration/i18nCore.test.js` covers the plumbing.

## Dates and times (Europe/Paris)

Uma's Books is in Albi, so every date and time an admin types and every one a
visitor sees means **France time**, not UTC (Render's servers run in UTC).
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
`schema_migrations` table. `npm run migrate` still runs on every deploy
and restart (see below), but only files not yet recorded do anything. Each
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
`blog_posts.image_url`); remote http(s) URLs (Open Library) are stored
as-is and never copied.

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
  CSP `imgSrc` already allows `'self'`.
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

## Payment reliability (online checkout)

Order flow: checkout inserts a `pending` order and locks its copies/seats
(`in_cart`), creates a HelloAsso checkout intent, then saves the intent id
on the order. Orders become `paid` via the webhook, `/cart/return`, or the
10-minute sweep — all through `reconcileOrder` (`src/lib/cart.js`), which
re-asks HelloAsso rather than trusting any payload. Status values stay
`pending`/`paid`/`cancelled`/`expired` (no CHECK constraint, no new
statuses).

- **Intent id gap.** If saving the intent id fails, `persistCheckoutIntentId`
  retries once, then logs and force-alerts the admin with the order id and
  intent id (the buyer is still redirected to pay). If HelloAsso's webhook
  later names such an order, `adoptCheckoutIntent` records the intent id
  only after HelloAsso confirms the intent's `metadata.orderId` matches.
- **Late payments.** `reconcileOrder` also considers orders `expired` or
  `cancelled` within the last 7 days (by `created_at`) that have an intent
  id. If HelloAsso says paid, `recoverLatePayment` runs one transaction
  with row locks: every copy still `in_stock` (or `in_cart` for this order)
  and every drop-in seat row still held is marked `sold`, and the order
  becomes `paid`. If any item can't be claimed (resold, reserved in shop,
  seat gone), **nothing** is changed; the admin gets an unthrottled email
  naming order id, buyer email and amount for a manual refund. Either way
  `helloasso_order_id` is set on the closed order as the "already handled"
  marker, so retries and sweeps never re-alert or re-process it.
- **Sweep cost.** The periodic sweep includes closed orders only once an
  hour (`index.js`), since each costs a HelloAsso API call.
- **Drop-in seats on release.** Releasing an unpaid order marks its
  `class_dropin_seats` rows `released` rather than deleting them:
  `order_items.class_dropin_seat_id` references the seat (no ON DELETE
  action), so a delete used to fail and roll back the whole release. A
  released seat stops counting toward the session's capacity and is not on
  the roster; the expired order keeps its line items. The expiry sweep
  finds stale holds through book copies *and* seats (a drop-in-only
  checkout has no copy). A late payment for a released seat is treated as
  unclaimable (admin alert), since the capacity may already be resold.
- **Sweeps and races.** `markOrderPaid` returns whether it won. If
  `reconcileOrder` loses (the expiry sweep closed the order after its
  snapshot), it re-reads the row and runs `recoverLatePayment` instead of
  stamping `helloasso_order_id` and reporting paid. The cart job
  (`runCartMaintenance`) runs expiry then reconcile sequentially; each
  timer job is wrapped by `guardJob` so a slow run is skipped, not stacked.
  One order failing to release no longer stops the expiry loop (alerted
  once). The reconcile sweep stops at the first HelloAsso auth/network
  failure and alerts (first run, then ~hourly while it persists). A 401
  from HelloAsso clears the cached token and retries once. `/cart/return`
  also reconciles recently closed orders; a paid-but-unfulfillable one
  shows "we received your payment" rather than "nothing was charged".

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
   `npm run seed && npm start` every time the service starts. `migrate`
   is tracked (each file runs once) and takes an advisory lock; `seed` is
   safe to re-run (it only creates the first admin account if none exists
   yet). Rolling back to an older commit does NOT undo migrations.
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
