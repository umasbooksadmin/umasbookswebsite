# Uma's Books — architecture overview

A complete picture of how the site is built, runs, is deployed, backed up and
protected. Every diagram below is [Mermaid](https://mermaid.js.org/) and renders
directly on GitHub. For file-level detail (route table, environment variables,
migration rules) see [`umas-books/ARCHITECTURE.md`](../umas-books/ARCHITECTURE.md);
for running and restoring it see [`umas-books/README.md`](../umas-books/README.md);
for day-to-day operations see [`docs/runbook.md`](runbook.md).

This describes `main` as of 4 October 2026.

## Contents

1. [The system at a glance](#1-the-system-at-a-glance)
2. [Technology](#2-technology)
3. [Inside the web app](#3-inside-the-web-app)
4. [Request lifecycle](#4-request-lifecycle)
5. [Accounts, sessions and roles](#5-accounts-sessions-and-roles)
6. [Data model](#6-data-model)
7. [Money: checkout and payment reliability](#7-money-checkout-and-payment-reliability)
8. [Membership](#8-membership)
9. [Background jobs](#9-background-jobs)
10. [Dates and times](#10-dates-and-times)
11. [Build, test and deploy](#11-build-test-and-deploy)
12. [Backups, restore and monitoring](#12-backups-restore-and-monitoring)
13. [Security model](#13-security-model)
14. [Configuration reference](#14-configuration-reference)
15. [Limits, trade-offs and known gaps](#15-limits-trade-offs-and-known-gaps)

---

## 1. The system at a glance

One Node.js process serves **everything**: the public marketing site, the
members area and the admin. It talks to one Postgres database and a handful of
outside services. GitHub holds the code, runs the tests, and takes the backups;
the backups are stored in Backblaze, not in the code repository.

```mermaid
flowchart LR
  subgraph People
    direction TB
    V[Visitors]
    M[Members and volunteers]
    A[Admins]
  end

  subgraph Render["Render (Frankfurt)"]
    direction TB
    W["umas-books web service<br/>Node 22, Express 5, EJS"]
    DB[("Postgres<br/>umas-books-db<br/>text, orders, images")]
    W <--> DB
  end

  subgraph External["Outside services"]
    direction TB
    HA["HelloAsso<br/>payments, membership form"]
    GM["Gmail SMTP<br/>all outgoing mail"]
    AN["Anthropic API (optional)<br/>cover scan, descriptions,<br/>price and awards web search"]
    OL["Open Library, archive.org<br/>ISBN lookup, covers"]
    WD["Wikidata, NYT Books API<br/>awards and best-seller lists"]
    PW["Have I Been Pwned<br/>breach check"]
  end

  subgraph GitHub["GitHub (private repo)"]
    direction TB
    REPO["main branch<br/>6 required checks"]
    ACT["Actions: CI, backups, restore test,<br/>backup freshness check, uptime check"]
  end

  OFF[("Backblaze B2<br/>private bucket, EU")]

  People -->|"browse, log in, buy"| W
  W -->|"API calls and mail"| External
  HA -->|"webhook: a hint only"| W
  REPO -->|"merge deploys"| W
  ACT -->|"nightly pg_dump"| DB
  ACT -->|"GET /healthz"| W
  ACT -->|"uploads the dump"| OFF
  ACT -->|"daily: newest dump fresh?"| OFF
```

**Two layers of backup.** Render keeps its own seven-day point-in-time recovery
for the database; on top of that a nightly dump (uploaded photos included) goes
to a private Backblaze B2 bucket that Render cannot touch. See §12.

**Preview mode.** While the shop is still being shown to outsiders, setting
`PREVIEW_MODE=true` puts the whole site in "coming soon" mode: a banner on every
page, online checkout and the membership payment widget switched off, and
search engines told to stay away. See §3 and §13.

**Why one app.** Squarespace was retired; the marketing pages are EJS views in
the same Express process as the members area, so there is one deployment, one
login, one database and one thing to monitor.

---

## 2. Technology

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 (`engines: 22.x`) | pinned in `package.json`, `umas-books/.node-version` and CI |
| Web | Express 5 | rejected async handler promises reach the error handler natively |
| Views | EJS, server-rendered | marketing views in `views/marketing/`; English and French via `tr()` (§3) |
| Database | PostgreSQL (Render, `1c-2g`) | `pg` pool; `timestamptz` everywhere |
| Sessions | `express-session` + `connect-pg-simple` | rows in table `session`; 30-day sliding cookie |
| Security middleware | `helmet` (CSP, HSTS), `express-rate-limit`, custom CSRF | |
| Uploads | `multer` (memory) + `sharp` re-encode to JPEG | admin only; bytes stored in the `images` table, served at `/img/<hash>.jpg` |
| Two-step login | TOTP authenticator app (`lib/totp.js`) | required for admins; the secret is encrypted in the database |
| Languages | server-side English and French | `tr()` in views, cookie `umasbooks_lang`; emails follow the reader's stored language (§3) |
| Mail | `nodemailer` over Google Workspace SMTP | one mailbox (`admin@umasbooks.org`) for human and system mail |
| Optional AI | Anthropic API (Claude) | cover scan, book descriptions and genre, market price lookup, awards web search; every use is optional and off without `ANTHROPIC_API_KEY` |
| Payments | HelloAsso (checkout intents + hosted membership form) | OAuth client credentials |
| Hosting | Render Blueprint (`render.yaml`) | web `1c-2g`, database `1c-2g`, Frankfurt; migrations run as the pre-deploy command |
| CI/CD | GitHub Actions + Dependabot | six required checks; Render deploys on merge; actions pinned by commit |

---

## 3. Inside the web app

The app lives in [`umas-books/`](../umas-books/). The repo root holds only the
static files the marketing pages load (`assets/`, `logo.png`), `render.yaml`, CI
config and docs.

```mermaid
flowchart TB
  IDX["src/index.js<br/>middleware order, route mounting,<br/>background timers, shutdown"]

  subgraph MW["src/middleware"]
    MA["auth.js<br/>attachUser, requireAuth/Admin/Member/Volunteer"]
    MC["csrf.js<br/>lazy token, constant-time compare"]
    MR["rateLimits.js<br/>per-IP limiters"]
    MI["idParams.js<br/>bad ids give 404"]
    ML["lang.js<br/>English or French per request"]
    MP["lib/preview.js<br/>preview mode: banner, noindex"]
    MS["noStoreForUsers.js<br/>no caching of logged-in pages"]
  end

  subgraph RT["src/routes"]
    direction LR
    PUB["Public<br/>books, events, sessions, blog, contact,<br/>book requests, img, seo"]
    MEMB["Members<br/>dashboard, account, privacy, forum,<br/>charity, volunteer, meetings"]
    COM["Commerce<br/>cart, helloassoWebhook"]
    AUTH["auth.js, twoFactor.js<br/>signup, verify, login, two-step,<br/>reset, password"]
    ADM["admin/*<br/>members, inventory (scan, move, sell),<br/>pricing, price suggestions, awards, reports,<br/>requests, forum moderation, events, sessions,<br/>meetings, volunteer shifts, blog,<br/>announcements, charity, dashboard, audit"]
  end

  subgraph LIB["src/lib"]
    direction LR
    L1["cart.js<br/>orders, holds, reconcile, late recovery"]
    L2["helloasso.js<br/>API client, 10 s timeouts"]
    L3["membership.js<br/>sync, expiry, backstop"]
    L4["reservations.js<br/>2-week holds, reminders"]
    L5["tz.js, dates.js, calendar.js<br/>Paris time, calendar grids"]
    L6["validation.js, passwordPolicy.js,<br/>resetTokens.js, sanitizeHtml.js"]
    L7["emailVerification.js, passwordReset.js,<br/>errorAlert.js, session.js, env.js"]
    L8["bookLookup.js, coverVision.js,<br/>uploadImage.js, imageStore.js, health.js"]
    L9["totp.js, audit.js, privacy.js,<br/>memberExport.js, lang.js, inventory.js"]
    L10["pricing/*<br/>rules, market lookup, clearance, settings"]
    L11["awards/*<br/>Wikidata, NYT, AI, display"]
    L12["bookRequests.js, reports.js,<br/>forumModeration.js, orderEmail.js"]
    L13["jobGuard.js, imageCleanup.js,<br/>preview.js, errorHandler.js"]
  end

  DBM["src/db.js<br/>pg Pool, withTransaction,<br/>error handler and timeouts"]
  MIG["src/migrate.js + migrations/*.sql<br/>tracked in schema_migrations"]
  VIEWS["views/ (EJS)<br/>marketing/, admin/, partials/"]

  IDX --> MW --> RT
  RT --> LIB --> DBM
  RT --> VIEWS
  MIG --> DBM
```

Conventions that hold across the code:

* **No ORM.** Plain parameterised SQL; the only interpolated pieces are constants.
* **`withTransaction(pool, fn)`** is the only way multi-step writes are done; a
  failing `ROLLBACK` can't mask the original error.
* **Comments explain why**, and reference the incident that caused the code.

**Languages.** Everything visitors and members see is available in English and
French; admin screens stay English. A cookie, `umasbooks_lang`, is written by
the EN/FR toggle in the page header. The `lang.js` middleware runs before the
login check and reads only headers (so it never touches the session or the
database): French when the cookie says `fr`, otherwise the browser's
`Accept-Language`, otherwise English. Views call `tr('English', 'Français')`
and server code calls `req.tr(...)`. This covers the marketing pages too: they
are EJS views rendered in the chosen language on the server (a small script
only re-applies the strings after a client-side toggle), with localised dates. Emails follow the reader's stored language:
`users.lang` (set at signup, refreshed at login), `orders.lang` (set at
checkout) and `book_requests.lang`; an empty value means English. Book
descriptions have a French column (`description_fr`). Admin screens, and the
admin-only alert emails, stay English.

**Preview mode.** `lib/preview.js` reads `PREVIEW_MODE` (`true` or `1`) on every
request. When on, views get `res.locals.preview`: a "coming soon" banner is shown
on every customer page, an `X-Robots-Tag: noindex, nofollow` header and a robots
meta tag go out, `robots.txt` turns every crawler away, the sitemap is empty, the cart refuses
checkout, the membership page shows a notice instead of the HelloAsso widget, and
the contact form offers a "Feedback on the preview" topic. Admin pages show a
reminder that the mode is on. Unset (the default) means the site behaves
normally.

---

## 4. Request lifecycle

Order matters here — the registration order in `src/index.js` *is* the design.
Static files and uploaded images are served before the session so that they
never cost a session or user lookup, and the HelloAsso webhook is mounted before
CSRF because it is an external POST with no token. The preview-mode flag is set
first of all so that even static files and error pages carry the `noindex`
header when the site is in preview.

```mermaid
flowchart TD
  R([Incoming request]) --> PV["preview mode flag<br/>res.locals.preview, noindex header"]
  PV --> C["compression"]
  C --> S1["Static files<br/>/public, /assets, /logo.png<br/>(7-day cache)"]
  S1 --> IM["GET /img/hash.jpg<br/>photo bytes from the images table,<br/>cached for a year, no cookie"]
  IM --> H["GET /healthz<br/>SELECT 1, 3 s limit, 503 on failure"]
  H --> SEO["robots.txt, sitemap.xml"]
  SEO --> HEL["helmet<br/>CSP, HSTS, no-referrer"]
  HEL --> U["urlencoded body parser"]
  U --> SES["express-session<br/>Postgres store, cookie umasbooks.sid"]
  SES --> REF["session refresh<br/>saved at most once a day"]
  REF --> LG["language<br/>cookie or Accept-Language"]
  LG --> AU["attachUser<br/>re-reads role flags, disabled,<br/>password_changed_at by primary key"]
  AU --> NS["logged-in pages: no-store"]
  NS --> LOC["view locals<br/>user, cart count, lazy CSRF token"]
  LOC --> UP["admin upload mounts<br/>requireAdmin first, then multer"]
  UP --> WH["POST /webhooks/helloasso<br/>rate-limited, before CSRF"]
  WH --> CS["csrfProtection<br/>every other POST"]
  CS --> API["/api/csrf-token, /api/session"]
  API --> MK["marketing pages, legal pages<br/>(MARKETING_PAGES list)"]
  MK --> RM["route modules<br/>auth, two-step, dashboard, account, privacy,<br/>forum, charity, volunteer, meetings, events,<br/>blog, sessions, books, cart, contact,<br/>book requests, admin"]
  RM --> NF["404 page"]
  NF --> ER["error handler<br/>log, alert email, 500 page"]
```

---

## 5. Accounts, sessions and roles

Roles are flags on `users`: `is_admin`, `is_member`, `is_volunteer`, plus
`is_disabled`. They are **re-read from the database on every logged-in request**
by `attachUser`, so disabling someone, demoting an admin, or changing a password
takes effect on their very next request — including on other devices.

```mermaid
stateDiagram-v2
  [*] --> Anonymous
  Anonymous --> Signup: POST /signup
  Signup --> Unverified: neutral notice, same page whether or not the email exists, plus a verification email
  Unverified --> Verified: GET /verify-email/:token, sets email_verified_at
  Unverified --> LoggedIn: login (allowed before verifying)
  Verified --> LoggedIn: login
  Verified --> TwoStep: password right, two-step switched on
  TwoStep --> LoggedIn: authenticator code or one-time recovery code
  TwoStep --> Anonymous: 5 minutes pass or too many wrong codes
  LoggedIn --> LoggedIn: attachUser re-checks the row every request
  LoggedIn --> Anonymous: logout, disabled, deleted, or password changed elsewhere
  Anonymous --> Reset: POST /forgot-password (neutral reply)
  Reset --> Verified: reset link used once; also verifies the email and clears the lockout
```

Key rules:

* **Passwords** — bcrypt cost 12, minimum policy plus a Have-I-Been-Pwned
  k-anonymity breach check; a locked account (5 failures, 15 min) answers like a
  wrong password; the lockout counter is one atomic `UPDATE`. Wrong two-step
  codes count toward the same lockout.
* **Sessions** — id regenerated at login; the session is **saved before the
  redirect** (`lib/session.js`) because `express-session` otherwise answers
  before its write lands; cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
* **Two-step verification (TOTP).** Any authenticator app works. It is
  **mandatory for admins** and optional for everyone else: `requireAdmin` sends an
  admin who has not enrolled to `/account/2fa` and nothing else works until they
  do. At login the password only opens a five-minute "pending" step; the 6-digit
  code (or a one-time recovery code, ten are issued at setup) completes the
  login. A code cannot be replayed, and enrolling needs the account password
  again. The secret is stored encrypted (AES-256-GCM) with the key
  `TOTP_ENCRYPTION_KEY`, so a database copy alone does not reveal it. An admin
  who loses their phone and codes is reset by another admin (**Reset Two-Step**
  on the Members page, written to the audit log); non-admins can switch it off
  themselves, admins cannot.
* **Email verification gates identity-sensitive features**: order history on
  `/account` and automatic membership attribution both require
  `email_verified_at`. Accounts created by an admin are verified immediately
  (the invite link proves the mailbox); existing accounts at migration 032 were
  grandfathered as verified.
* **CSRF** — a per-session token created lazily, compared in constant time;
  `/api/csrf-token` saves the session before answering.
* **Rate limits** are in memory (reset on restart) and mostly per IP: login 20
  failures / 15 min, sign-up 30/h, password reset requests 10 / 15 min, checkout 10/h, cart edits 60 / 15 min, event sign-up 10/h,
  forum posts 10/h and replies 30/h, charity ideas 10/h, contact 5 / 15 min,
  webhook 300 / 5 min, book requests 5/day, "find my requests" 5/h (plus 3 a day
  per address). A few are per account instead: wrong two-step codes,
  wrong current password (password change, download or delete of your own data),
  forum reports, and admin price checks (30 a minute, since one can cost an AI
  call). See `src/middleware/rateLimits.js` and the route files.

---

## 6. Data model

37 application tables (plus `schema_migrations` and the session table), grouped by what they belong to. Foreign keys below are the real
ones from `migrations/`. (`event_rsvps` is unused; `wishlist_requests` was dropped
in migration 029.)

```mermaid
erDiagram
  users ||--o{ email_verification_tokens : "proves mailbox"
  users ||--o{ totp_recovery_codes : "one-time codes"
  users ||--o{ password_reset_tokens : "resets"
  users ||--o{ membership_payments : "HelloAsso payments"
  users ||--o{ forum_threads : writes
  forum_threads ||--o{ forum_replies : has
  users ||--o{ forum_replies : writes
  users ||--o{ favorites : saves
  books ||--o{ favorites : "is saved as"

  books ||--o{ book_copies : "physical copies"
  books ||--o{ book_awards : "awards, best-seller lists"
  users ||--o{ book_awards : "decided by"
  book_copies ||--o{ shop_sales : "sold over the counter"
  users ||--o{ shop_sales : "sold by"
  users ||--o{ book_requests : "may link"
  book_copies ||--o{ book_requests : "matched copy"
  orders ||--o{ book_copies : "holds in cart"
  orders ||--o{ order_items : contains
  book_copies ||--o{ order_items : "sold as"
  classes ||--o{ class_dropin_seats : "paid seats"
  orders ||--o{ class_dropin_seats : holds
  class_dropin_seats ||--o{ order_items : "sold as"

  events ||--o{ event_signups : "public sign-ups"
  classes ||--o{ class_signups : "pre-registration"
  events ||--o{ announcements : "linked from"
  users ||--o{ blog_posts : writes

  volunteer_shifts ||--o{ volunteer_signups : "slots"
  users ||--o{ volunteer_signups : books
  meetings ||--o{ meeting_rsvps : "RSVPs"
  users ||--o{ meeting_rsvps : answers

  charity_rounds ||--o{ charity_options : offers
  charities ||--o{ charity_options : "appears as"
  charity_options ||--o{ charity_votes : "receives"
  users ||--o{ charity_votes : casts
  charities ||--o{ charity_ideas : "approved from"
  users ||--o{ charity_ideas : suggests
```

| Domain | Tables | Notes |
|---|---|---|
| Accounts | `users`, `email_verification_tokens`, `password_reset_tokens`, `totp_recovery_codes`, `session`, `schema_migrations` | tokens and recovery codes stored as hashes; `users` also holds `lang`, the encrypted two-step secret and `inactivity_warned_at`; `session` is created by the store |
| Shop | `books`, `book_copies`, `orders`, `order_items`, `class_dropin_seats`, `shop_sales` | an order line is *either* a copy *or* a seat (CHECK constraint); copy status `in_stock / reserved / in_cart / sold / donated / damaged` (`in_cart` is set by checkout only); one row per ISBN (unique index); `shop_sales` is the over-the-counter equivalent of an online order line |
| Awards | `book_awards` | awards, shortlists and best-seller lists per book, with `source` (`wikidata / nyt / ai / manual`) and review `status` (`verified / pending / approved / rejected`) |
| Pricing | `pricing_settings`, `price_lookups` | one settings row (`id = 1`) holding every number the rules use; one cached market lookup per ISBN-13 |
| Book requests | `book_requests`, `book_request_list_tokens` | customer "ask us for a book" requests, identified by an emailed link instead of an account; personal columns are cleared when a request ends |
| Images | `images` | content-addressed: id is the SHA-256 of the bytes; `books.cover_url` and the announcement, charity and blog image columns hold only the short `/img/<hash>.jpg` URL |
| Admin | `admin_audit_log` | who, what, numeric target id, time and IP; no member emails or names; purged after 12 months |
| Membership | `membership_payments` | one row per HelloAsso membership order; drives `member_expires_at` |
| Programs and events | `events`, `event_signups`, `classes`, `class_signups` | a `classes` row is a program session; `dropin_price` set = bookable |
| Community | `forum_threads`, `forum_replies`, `announcements`, `blog_posts`, `favorites` | rich text goes through `sanitize-html`; threads and replies carry `hidden_at / hidden_reason / hidden_by` for moderation |
| Volunteering | `volunteer_shifts`, `volunteer_signups`, `meetings`, `meeting_rsvps` | |
| Charity vote | `charity_rounds`, `charity_options`, `charity_votes`, `charities`, `charity_ideas` | a library of charities reused across rounds |

Details of the shop tables worth knowing:

* **Condition grades and binding.** `book_copies.condition` is one of four
  grades, `new`, `like_new`, `very_good` (the default) or `acceptable`,
  enforced by a CHECK constraint (migration 048 remapped the old values; a copy
  that cannot be sold at all has status `damaged`, not a condition).
  `books.binding` is `hardcover`, `paperback` or `mass_market` (optional; older
  books are NULL until filled in). Both are shown in English and French.
* **Copy source.** `book_copies.source` records where a copy came from:
  `donation`, `purchase`, `lot` (job lot) or `other`; NULL means unknown (every
  copy added before migration 045). The Reports pages group by it.
* **Price history for the learning loop.** Each copy also stores
  `suggested_price`, `suggested_level`, `price_basis` (`suggested`, `adjusted` or
  `manual`) and `is_clearance`, so that later the shop can see how often a
  volunteer kept the suggested price (see "Pricing" below). The data is collected but nothing
  reads it back yet.
* **Inventory locations.** `book_copies.location` is free text per physical copy
  (trimmed, upper-case); there is no locations table, the drop-down is simply the
  distinct values already used. The admin **Move books** page moves one copy per
  scanned ISBN and writes each move to the audit log.
* **Fixed price for new books (loi Lang).** A copy whose condition is `new` must
  carry `publisher_price` and be priced between 95% and 100% of it, checked on
  the server when a copy is added or edited. Used copies are free-priced.
* **Order extras.** `orders.withdrawal_waiver_at` records the buyer's tick-box
  asking for a drop-in session to take place on its date (no withdrawal after);
  `orders.cgv_accepted_at` / `orders.cgv_version` record when the buyer accepted
  the terms of sale and which version (`TERMS_OF_SALE_VERSION` in
  `src/lib/legal.js`, bump it when the terms page changes); they are in the
  member data export and survive anonymisation;
  `orders.client_ip` supports the pending-order cap in §7; `orders.lang` sets the
  language of the confirmation email.

### Pricing: suggested prices for used books

When a volunteer adds a copy (or presses *Suggest* on an existing one),
`src/lib/pricing/` proposes a price. It is only ever a **suggestion**: nothing is
saved or published until the volunteer accepts or changes it. The copy's
condition never changes the price; it only marks a `new` book.

```mermaid
flowchart TD
  IN["Copy entered:<br/>ISBN, binding, condition,<br/>publisher price"] --> NEW{"Condition new?"}
  NEW -- yes --> LANG["Publisher's price<br/>(loi Lang: 95% to 100%, never clearance)"]
  NEW -- no --> ISBN{"Has an ISBN?"}
  ISBN -- no --> REV["Manual review:<br/>no price suggested"]
  ISBN -- yes --> MKT["Market value in EUR<br/>1. cached or fresh AI web lookup (optional)<br/>2. else publisher price x 35%<br/>3. else typical value by binding"]
  MKT --> HI{"Not mass market and<br/>value 50 EUR or more?"}
  HI -- yes --> REV
  HI -- no --> CLR{"Book already has 2 or more<br/>copies, and Rule A or mass market?"}
  CLR -- yes --> CP["Clearance: EUR 1"]
  CLR -- no --> MM{"Mass market?"}
  MM -- yes --> P5["EUR 5"]
  MM -- no --> RS["Rule A under 6: EUR 5<br/>Rule B under 20: EUR 8<br/>Rule C under 50: 75% of value,<br/>rounded to 0.50"]
  RS --> HC["Hardcover floor:<br/>raised to EUR 10"]
```

* **Rules are pure functions** (`pricing/rules.js`, no network or database), so
  they always answer instantly and are fully unit-tested. First match wins, as in
  the diagram; the thresholds shown are the defaults.
* **All the numbers live in one database row** (`pricing_settings`, `id = 1`),
  edited by admins on `/admin/pricing`: the standard price levels (3, 5, 8, 10
  EUR), the mass-market price (EUR 5), the hardcover floor (EUR 10, optionally
  applied to clearance too), the Rule A/B/C limits, the clearance count, price and
  scope, the rounding step, fallback values by binding and the USD and GBP rates.
* **Clearance** applies when the shop already holds two or more copies of a book
  (in stock or reserved); the next copies (or, by setting, all of them) go to
  EUR 1, by default only for Rule A and mass-market books. It is
  sticky: `book_copies.is_clearance` only changes when a volunteer changes that
  copy's price. `/admin/pricing/review` is a price check of the whole stock that
  shows what would change and applies clearance only on confirmation.
* **Market lookups** (`pricing/market.js`) are the optional AI step: Claude with
  web search, switched on by `PRICING_AI=true` plus `ANTHROPIC_API_KEY`, capped
  per day by `PRICING_AI_DAILY_MAX` (default 150) and cached per ISBN-13 in
  `price_lookups` (a successful lookup for 30 days, an empty one for 7, a failed
  one for an hour). Without it the rules still work from the publisher price or the
  binding fallback, and the admin price-check endpoint is rate-limited because
  one call can cost an AI request.
* **Learning loop (data only).** `suggested_price`, `suggested_level` and
  `price_basis` record what was suggested and whether it was kept; no report
  reads them yet.

### Awards and best-seller lists

Each book page can show prizes and best-seller lists. `src/lib/awards/` looks
them up in order of trust and stores them in `book_awards`.

```mermaid
flowchart LR
  SAVE["Book saved"] --> CHK["checkBookAwards<br/>(in the background)"]
  JOB["Every 2 min:<br/>drainAwards, 5 books"] --> CHK
  CHK --> WD["Wikidata"]
  CHK --> NY["NYT Books API<br/>(only if NYT_API_KEY)"]
  CHK --> AI["Claude web search<br/>(only if AWARDS_AI=true,<br/>daily cap)"]
  WD --> V["status: verified<br/>shown at once"]
  NY --> V
  MAN["Admin types one"] --> V
  AI --> PEN["status: pending<br/>hidden"]
  PEN --> ADM{"Admin review<br/>/admin/awards"}
  ADM -- approve --> APP["approved: shown"]
  ADM -- reject --> REJ["rejected: kept, never<br/>suggested again"]
```

Customers only ever see `verified` and `approved` rows. The background drain
takes never-checked books newest first, then retries errors after a day, then
runs the AI step for books checked before AI was on, then refreshes books last
checked over a year ago; it does not run at boot, so a restart never hammers
Wikidata. `AWARDS_AI_DAILY_MAX` (default 100) caps AI checks per UTC day, counted
in the database so it survives restarts. `AWARDS_LOOKUPS=off` stops every lookup
(the tests use it so no test reaches the network).

### Customer book requests

"Can't find a book? Ask us" (`/request-a-book`) needs no login or membership. The
requester is identified by an email address confirmed with a link (double
opt-in); every email link carries a random token that is stored only as a hash.

```mermaid
stateDiagram-v2
  [*] --> unconfirmed: form sent, confirmation email
  unconfirmed --> open: link opened and Confirm pressed
  unconfirmed --> [*]: deleted after 7 days
  open --> matched: copy added that fits (or admin matches by hand)
  matched --> notified: admin presses Notify (optionally holds the copy 7 days)
  notified --> fulfilled: admin marks done
  open --> expired: 12 months
  matched --> expired: 12 months
  notified --> expired: 12 months
  open --> cancelled: requester or admin
  matched --> cancelled: requester or admin
  notified --> cancelled: requester or admin
```

* **Matching on intake.** When a copy is added, or a book edited, open requests
  for the same ISBN (10 or 13 form) or the same normalised title with a
  compatible author become `matched` to that copy.
* **Hold.** *Notify and hold* reserves the copy for the requester for 7 days using
  the ordinary reservation machinery (§9), so it expires and shows as reserved like
  any other reservation.
* **Self-service.** Each request has a private manage link (`/my-requests/:token`)
  to cancel it; "find my requests" emails a 30-day link listing every request of
  one address (`book_request_list_tokens`), and a logged-in member can cancel from
  their account. Limits: 3 pending requests per email, 5 submissions a day per IP.
* **Privacy.** Email, name, note and account link are cleared when a request
  ends (cancelled, expired, or closed 30 days); only title, author and ISBN stay
  for anonymous demand counts. Erasing a member cancels and strips their requests
  (`lib/privacy.js`).

### Reports, copy source and in-shop sales

* **Reports** (`/admin/reports`, `lib/reports.js`) are read-only and made of a few
  aggregate queries each, never one query per book. Six reports: *Inventory on
  hand* (by genre, condition, location and source), *Aging stock*, *Sales over
  time* (online plus in-shop by day, week, month or year, drop-in seats shown
  apart), *Sell-through by genre*, *Membership* and *Intake log*. Date ranges
  are Paris calendar days. Any table can be downloaded as CSV; no report shows
  email addresses or buyer names, and every CSV download is written to the audit
  log (report name only).
* **Sell in shop** (`/admin/inventory/sell`) records a counter sale: scan the ISBN,
  choose the copy, confirm the price and an optional payment method (cash, card,
  other). One transaction inserts a `shop_sales` row and sets the copy to `sold`;
  only the admin's id is kept, never buyer details. New books keep the fixed-price
  rule. The sale is audit-logged and joins online orders in the Sales report.
* **Move books** (`/admin/inventory/move`) is described under inventory
  locations above.

### Forum moderation

An admin can hide a thread or reply from the forum page with a reason (illegal
content, harassment, spam or other) and an optional note. The text stays in the
row (so it can be reviewed and restored); members see a placeholder. Hiding sends
the author a **statement of reasons** by email in their language, as the EU
Digital Services Act requires, with `admin@umasbooks.org` as the contact for
contesting it. Hide and restore are audit-logged with the kind and reason code
only, never the post text or the note.

**Migrations** (`src/migrate.js`, files `migrations/001` to `054`; numbers 049,
051 and 052 were never used) are run by Render's **pre-deploy command**,
`npm run migrate`, before a new version takes traffic (§11), not by the web
process at boot. Each file applies exactly once: a `schema_migrations` table, a
per-file transaction and an advisory lock, so running it twice is harmless. A
pre-existing database is baselined, not re-migrated. If a migration fails the
deploy is aborted and the old version keeps serving. Never edit a deployed
migration — add a new numbered file.

---

## 7. Money: checkout and payment reliability

Principle: **the webhook body is never trusted.** HelloAsso's notification and
the buyer's return URL are only *hints to re-ask HelloAsso*; the authoritative
payment state always comes from a server-to-server lookup with our own
credentials.

```mermaid
sequenceDiagram
  autonumber
  actor B as Buyer
  participant W as Web app
  participant DB as Postgres
  participant HA as HelloAsso
  participant GM as Gmail

  B->>W: POST /cart/checkout (name, email, terms ticked,<br/>drop-in waiver ticked if a seat is in the cart)
  W->>DB: one transaction: create order,<br/>lock copies and seats as in_cart
  W->>HA: create checkout intent (10 s timeout)
  W->>DB: save intent id (one retry, admin alert if it fails)
  W-->>B: redirect to HelloAsso payment page
  B->>HA: pays
  par notification
    HA->>W: POST /webhooks/helloasso (untrusted hint)
  and return
    B->>W: GET /cart/return
  end
  W->>HA: look up the intent (authoritative)
  alt payment Authorized
    W->>DB: one transaction: order paid (WHERE status = pending),<br/>copies and seats sold
    W->>GM: order confirmation (after commit)
  else refused or abandoned
    W->>DB: one transaction: release copies,<br/>seats marked released, order closed
  end
```

What keeps it correct:

| Concern | Mechanism |
|---|---|
| Double delivery / webhook racing the sweep | `UPDATE orders SET status='paid' … WHERE status='pending'`; the loser gets `rowCount = 0` and stops |
| Crash between "paid" and "sold" | both happen in **one transaction** (`markOrderPaid`) |
| Abandoned checkouts | a hold lasts 60 minutes; every 10 minutes the sweep releases stale holds, including drop-in-only ones |
| Releasing an order that actually paid | `releaseCartHold` locks the order row first; if already paid it finishes marking copies sold instead |
| Drop-in seat rows | marked `released`, never deleted (`order_items` references them); capacity ignores released seats |
| Payment lands **after** the hold expired | hourly, orders closed in the last 7 days are re-checked; if every item can still be claimed the order is completed, otherwise nothing is changed and the admin gets an alert email naming order, buyer and amount for a manual refund |
| Checkout crashes before saving the intent id | the same alert, with order and intent ids; the webhook may adopt the id if HelloAsso confirms the order id |
| Overselling | atomic `UPDATE … WHERE status='in_stock'` and `FOR UPDATE` on class rows |
| Hoarding stock without paying | a cart holds at most 20 lines; at most 2 unpaid orders per email and per IP address (`orders.client_ip`), checked under an advisory lock so two simultaneous checkouts cannot both slip through |
| Terms and withdrawal | checkout requires accepting the terms of sale; a cart with a drop-in seat also requires the withdrawal waiver, whose time is stored on the order |

---

## 8. Membership

Membership is sold on a **HelloAsso-hosted form** (embedded as an iframe — the
marketing CSP needs `frame-src https://www.helloasso.com`), not through our
cart, so there is no local order row. The link back to an account is the **payer's
email address**.

```mermaid
flowchart LR
  P["Person pays on the<br/>HelloAsso form"] --> T{{"Trigger"}}
  T -- "webhook (any payload)" --> S
  T -- "every 6 h: orders from the last 3 days" --> S
  T -- "account verified, password reset,<br/>or created by an admin" --> S
  S["syncMembershipForEmail<br/>asks HelloAsso for that payer's<br/>Membership orders (exact email match)"]
  S --> V{"Account exists with a<br/>VERIFIED email?"}
  V -- no --> W["skip, log;<br/>retried when the account is verified"]
  V -- yes --> R["record payment,<br/>member_expires_at = payment date + 365 days,<br/>is_member = true"]
  R --> X["revoke only on positive evidence:<br/>order returned without an Authorized payment"]
```

Manual admin grants (`/admin/members`) have no `member_expires_at` and are never
touched by the sync or the expiry sweep.

---

## 9. Background jobs

There is no job queue: a few `setInterval` timers in the web process, plus
GitHub Actions for work that must survive the site being down. Each timer's job
is wrapped by `guardJob` (`lib/jobGuard.js`): a run that is still in progress is
never overlapped by the next tick, which is skipped with one log line.


```mermaid
flowchart LR
  subgraph proc["Web process (setInterval)"]
    A["every 10 min<br/>cart sweep"] 
    B["hourly (every 6th tick)<br/>late-payment re-check"]
    C["every 6 h<br/>reservations, reminders,<br/>membership expiry + backstop"]
    P["daily and at boot<br/>retention purge,<br/>30-day inactivity warnings"]
    IC["daily and at boot<br/>unused-image cleanup"]
    AW["every 2 min (not at boot)<br/>awards drain, 5 books"]
  end
  subgraph gha["GitHub Actions (independent of Render)"]
    D["every 30 min<br/>uptime check"]
    E["03:00 UTC nightly<br/>database backup to Backblaze"]
    F["1st of month, 05:00 UTC<br/>restore test"]
    FR["09:00 UTC daily<br/>backup freshness check"]
  end
  A --> DB[("Postgres")]
  B --> HA["HelloAsso lookups"]
  C --> DB
  C --> HA
  D --> W["GET /healthz"]
  P --> DB
  E --> DB
  E --> BK[("Backblaze B2")]
  BK --> F
  FR -->|"newest full/ dump older than 36 h,<br/>empty or unreachable: email"| BK
  IC --> DB
  AW --> DB
  AW --> EXT["Wikidata, NYT, Anthropic"]
```

| Job | Where | Cadence | Notes |
|---|---|---|---|
| Cart hold expiry, order reconcile | web process | 10 min | also on boot |
| Late-payment re-check | web process | hourly | only orders closed in the last 7 days |
| Reservation expiry, pickup reminder (day 11 of 14), membership expiry, membership backstop | web process | 6 h | read-time expiry also keeps pages right while idle |
| Retention purge | web process | daily, and at boot | see below; also clears ended book requests and expired "find my requests" links |
| Unused-image cleanup | web process | daily, and at boot | deletes at most one batch of images older than 7 days that no row references (`lib/imageCleanup.js`) |
| Awards drain | web process | 2 min, not at boot | looks up awards for a few books at a time (§6); a no-op when `AWARDS_LOOKUPS=off` |
| Uptime check | Actions | 30 min | emails on the **second** consecutive failure and on recovery |
| Database backup | Actions | 03:00 UTC | full dump to Backblaze B2 (required); a second copy on the 1st of the month |
| Restore test | Actions | monthly + manual | restores the newest Backblaze dump into a scratch Postgres and checks it |
| Backup freshness check | Actions | 09:00 UTC daily + manual | emails if the newest nightly dump in Backblaze is older than 36 hours, empty, missing, or Backblaze cannot be reached (§12) |

**The daily retention purge** keeps the promises on the privacy page. It removes
event and class sign-ups 12 months after the date, expired reset and
verification tokens after 7 days, orders and payment records after 10 years,
contact details on ended reservations and on expired or cancelled orders after
30 days, audit-log rows after 12 months, and book requests (never-confirmed ones
after 7 days, open ones after 12 months, and the contact details of closed ones
after 30 days). Accounts with no login for 3 years
(never admins, never current members) get an email warning first and are
deleted 30 days later unless they log in. Each step runs on its own, so one
failure does not stop the others.

On shutdown (`SIGTERM`/`SIGINT`) the timers are cleared, the server stops taking
connections, in-flight requests finish, the pool closes, and the process exits
(hard stop after 10 s).

---

## 10. Dates and times

Uma's Books is in Albi, so **every typed and displayed time means Europe/Paris**.
Render's servers run in UTC, which used to store a typed 18:00 as 18:00Z (20:00
in Paris in summer).

```mermaid
flowchart LR
  F["Admin types<br/>18:00"] --> P["parseLocalDateTime<br/>read as Paris time"]
  P --> I["stored as an instant<br/>timestamptz: 16:00Z in summer,<br/>17:00Z in winter"]
  I --> D1["Pages and emails:<br/>formatted in Europe/Paris"]
  I --> D2["Calendar file .ics:<br/>UTC instant, correct in any calendar app"]
  I --> D3["Admin edit form:<br/>pre-filled with the Paris wall time"]
```

`src/lib/tz.js` pins the process timezone; weekly repeats keep the same wall-clock
time across the October and March clock changes; migration 033 corrected rows
stored the old way. Date-only fields (blog dates, announcement expiry) are
UTC-midnight values and unaffected.

---

## 11. Build, test and deploy

`main` is protected: nothing reaches it except through a pull request whose six
checks pass and whose branch is up to date. **A merge to `main` deploys to
production.**

```mermaid
flowchart LR
  DEV["Change on a branch"] --> PR["Pull request"]
  PR --> CI

  subgraph CI["GitHub Actions: six required checks"]
    direction TB
    c1["lint"]
    c2["test<br/>unit + integration,<br/>throwaway Postgres"]
    c3["migration-test<br/>all migrations on an empty DB + seed"]
    c4["dependency-audit<br/>npm audit"]
    c5["secret-scan"]
    c6["smoke-crawl<br/>log in as each persona,<br/>walk every page"]
  end

  CI --> MRG["Squash-merge to main<br/>(branch must be up to date)"]
  MRG --> RB["Render builds<br/>npm ci --omit=dev"]
  RB --> PD["preDeployCommand:<br/>npm run migrate<br/>a failed migration aborts the deploy,<br/>the old version keeps serving"]
  PD --> ST["start command:<br/>npm run seed && npm start"]
  ST --> HC["Render health check<br/>GET /healthz"]
  HC --> LIVE(["Live"])
```

* **Dependabot** opens weekly update pull requests for GitHub Actions and npm
  packages. It never merges anything: each one goes through the same six checks
  and a human review. Major upgrades of Express, EJS, bcryptjs and dotenv are
  deliberately not proposed (they need a planned migration). Third-party Actions
  are pinned to an exact commit, not a moving tag.
* Tests use a real Postgres; locally every test file gets its own throwaway
  database, but **in CI all files share one database and run concurrently** —
  tests must never do anything global to a shared table (use
  `startTestApp({ isolated: true })`).
* The smoke crawl and the tests switch the admin two-step requirement off
  (`ADMIN_2FA_REQUIRED=false`); the setting is ignored when `NODE_ENV=production`.
* Reproduce production's UTC environment on a Paris-timezone machine with
  `TZ=UTC PGOPTIONS='-c timezone=UTC'`.
* The smoke crawl is the slowest check (~10 minutes) and the main consumer of
  Actions minutes, which are metered on a private repo.

---

## 12. Backups, restore and monitoring

```mermaid
flowchart TB
  subgraph nightly["Nightly 03:00 UTC (GitHub Actions)"]
    G{"offsite settings<br/>all set?"} -- no --> E["any failure: email to admin"]
    G -- yes --> D["pg_dump --format=custom<br/>(client 18, 3 attempts,<br/>images included, sessions left out)"]
    D --> U[("Backblaze B2<br/>full/ every night,<br/>monthly/ copy on the 1st")]
    D --> E
    U --> E
  end

  subgraph monthly["Monthly restore test"]
    N["newest dump from Backblaze B2 (full/)"] --> RS["pg_restore into a scratch postgres:18"]
    RS --> CK["check key tables exist, row counts,<br/>at least one admin, image bytes present"]
    CK --> E2["failure: email to admin"]
  end

  subgraph fresh["Backup freshness check, daily 09:00 UTC"]
    FL["list newest dump under full/"] --> FQ{"exists, not empty,<br/>written within 36 hours?"}
    FQ -- no --> E5["email to admin"]
    FQ -- yes --> FOK["ok, nothing sent"]
  end

  subgraph watch["Uptime check every 30 min"]
    H["GET /healthz"] --> OK{"database reachable?"}
    OK -- "fails twice in a row" --> E3["one alert email"]
    OK -- "recovers" --> E4["one recovery email"]
  end
```

* **Two layers.** Render's own point-in-time recovery (seven days) is the quick
  way back after a bad deploy or a mistaken delete; the Backblaze dumps are the
  independent copy that survives even losing the Render account.
* **Retention in Backblaze** is set by two lifecycle rules on the bucket, not by
  the workflow: nightly dumps under `full/` are hidden after 30 days and the
  1st-of-the-month copies under `monthly/` after 730 days (about two years).
* **Freshness check.** The nightly workflow emails when it *fails*, but cannot email
  if it never runs at all (workflow disabled, schedule dropped, a GitHub outage).
  `.github/workflows/backup-freshness.yml` therefore runs six hours after the
  backup, looks at Backblaze itself, and emails `admin@umasbooks.org` if the newest
  `full/` dump is older than 36 hours, is empty, or is missing, or if Backblaze
  cannot be reached or its settings are absent. It uses the same `BACKUP_S3_*`
  settings and the Gmail secrets as the nightly job.
* **Dumps never go into the code repository**: they contain member names,
  emails, order details and password hashes, so they live only in the private
  Backblaze B2 bucket. All three backup workflows (nightly, restore test, freshness check) have read-only repository access.
* **What a dump holds.** Everything, including uploaded photos (they live in the
  database now) but not login sessions; after a restore everyone logs in again.
* **Restore procedure**: `umas-books/README.md` → "Restoring from a backup".
* **Application errors** go through `alertOnError` (one email per 15 minutes, so
  an outage can't flood the inbox); payment-money alerts bypass that throttle.
* **Offsite status**: Backblaze B2 is the only backup location and is required;
  the nightly job fails (and emails) if its settings are missing. The
  repository variables and secrets it needs are listed in `umas-books/README.md`.

---

## 13. Security model

Layers, outermost first. A request must pass every one that applies to it.

```mermaid
flowchart TD
  NET["Internet"] --> TLS["Render edge: TLS, trust proxy = 1<br/>(real client IP)"]
  TLS --> HL["helmet: CSP, HSTS, no-referrer,<br/>frame-ancestors none"]
  HL --> RL["Rate limits (per IP)<br/>login, checkout, cart, sign-ups,<br/>forum, contact, webhook"]
  RL --> SE["Session cookie: HttpOnly, Secure,<br/>SameSite=Lax; regenerated at login"]
  SE --> CF["CSRF token on every POST<br/>(webhook excepted: never trusts its body)"]
  CF --> AU["attachUser: role flags re-read from the DB<br/>every request; disabled, deleted or<br/>password-changed sessions drop"]
  AU --> RG["Role guards per route<br/>requireAuth, Member, Volunteer, Admin<br/>(admin also needs two-step set up;<br/>guard runs before file uploads)"]
  RG --> AUD["Audit log<br/>sensitive admin actions are recorded"]
  AUD --> VAL["Input handling<br/>validation helpers, parseId 404s,<br/>parameterised SQL, EJS escaping,<br/>sanitize-html for rich text"]
  VAL --> DBX[("Postgres")]
```

| Area | What is in place |
|---|---|
| Secrets | environment variables only (`sync: false` on Render; GitHub secrets for CI); `.env` is git-ignored; a secret scan runs on every PR; startup fails fast in production if `DATABASE_URL` or `SESSION_SECRET` are missing |
| Authentication | see §5; enumeration-resistant signup, login, reset; HIBP breach check; two-step verification mandatory for admins, secrets encrypted with `TOTP_ENCRYPTION_KEY` |
| Authorization | admin guard (including two-step) before multer; admins cannot demote, disable or delete themselves |
| Preview mode | `PREVIEW_MODE=true` switches checkout and the membership widget off, adds a banner, and sends `noindex, nofollow` (header, meta tag, `robots.txt`, empty sitemap), so an unfinished site cannot take payments or be indexed |
| Moderation | admins can hide forum posts with a reason code; the author gets a statement of reasons (EU Digital Services Act) and the action is audit-logged without the post text |
| AI features | optional and off without `ANTHROPIC_API_KEY`; price and awards lookups have separate switches and daily caps; AI-found awards stay hidden until an admin approves them; a suggested price is never saved without a person confirming it |
| Book requests | double opt-in by emailed link, tokens stored as hashes, rate-limited, personal data cleared when a request ends |
| Admin audit log | member changes, erasure, data export, two-step resets, deletes, bulk deletes, book moves and repricing, shop sales, pricing-rule changes, award edits, book-request handling, forum hide and restore, report CSV downloads and admin logins are appended to `admin_audit_log` and shown read-only at `/admin/audit`; it keeps the admin's id and email, the action and a numeric target, never member emails or names; rows are purged after 12 months |
| Payments | never trust webhook or return-URL content; amounts computed server-side; idempotent state change |
| Output | EJS auto-escapes; the only unescaped output is sanitised rich text or fixed markup; `esc()` in client code |
| Uploads | admin only, size-capped, decoded and re-encoded by `sharp` with a pixel cap; stored in the `images` table and served from `/img/<hash>.jpg` (hash-named, immutable, no cookie) |
| Email | one address only (no list separators), names stripped of links and angle brackets before going into mail |
| Transport to the database | `rejectUnauthorized: false` is deliberate: Render's internal Postgres uses a per-instance self-signed certificate on a private network |
| Supply chain | `npm audit` in CI; lockfile-exact builds; third-party Actions pinned by commit; weekly Dependabot pull requests, never auto-merged |
| Caching | pages shown to a logged-in visitor are sent `no-store` (the Back button after logout shows nothing private); only `/img/` photos stay cacheable |

**Personal data (GDPR).** Most personal data is keyed by email address, not by
account id, so deleting a user row alone would leave orders, sign-ups and
reservations behind. The code handles it in one place (`lib/privacy.js`):

* **Erase member** (admin, Members page) deletes the account, its sign-ups and
  sessions, releases an active reservation, and *anonymises* paid orders and
  HelloAsso payment rows, which French accounting law requires us to keep for 10
  years. Forum posts keep their text without an author name.
* **Retention**: the daily purge in §9 enforces the periods the privacy policy
  states; the policy page and the constants in the code must change together.
* **Members can help themselves** on **Account, Privacy** (`/account/privacy`):
  download their own data as a file, or delete their own account. Both need the
  current password (wrong attempts are throttled per account); deletion also
  needs the typed word DELETE (or SUPPRIMER), is refused for admins, sends a
  confirmation email and then runs the same erase as above.
* **Admin data export**: on a member's page an admin can download everything held
  about them as JSON (right of access). Password hashes, tokens and two-step
  secrets are never included.
* Contact-form messages stay in the Gmail inbox and server logs stay with Render;
  neither is purged automatically. The processing register and breach log are in
  `docs/privacy/`.

---

## 14. Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Render's internal connection string |
| `SESSION_SECRET` | yes | generated by Render |
| `TOTP_ENCRYPTION_KEY` | yes in prod (set once) | generated by Render; encrypts admins' two-step secrets. Falls back to `SESSION_SECRET` if unset. Changing it makes everyone set up two-step again, so do not rotate casually |
| `NODE_ENV` | yes in prod | `production` enables secure cookies and the startup check |
| `PORT` | no | Render sets it |
| `PGSSLMODE` | no | `disable` for local/CI databases |
| `APP_BASE_URL` | recommended | absolute links in emails (verification, reset); Render's `RENDER_EXTERNAL_URL` is the fallback |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | recommended | all outgoing mail, including error alerts |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG` | for online payment | optional `HELLOASSO_API_BASE` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | optional | cover scan, book descriptions and genre in admin inventory; also needed (with the switches below) for AI price and awards lookups |
| `PRICING_AI` | optional | `true` or `1` turns on the AI market-price lookup behind price suggestions (needs `ANTHROPIC_API_KEY`); off by default, rules still work without it |
| `PRICING_AI_DAILY_MAX`, `PRICING_AI_MODEL` | optional | daily cap on price lookups (default 150) and model override |
| `NYT_API_KEY` | optional | enables best-seller lists from the New York Times Books API; without it that source is skipped |
| `AWARDS_AI` | optional | `true` turns on AI web search for awards (needs `ANTHROPIC_API_KEY`); results wait for admin approval |
| `AWARDS_AI_DAILY_MAX`, `AWARDS_AI_MODEL` | optional | daily cap on AI award checks (default 100) and model override |
| `AWARDS_LOOKUPS` | optional | `off` stops every awards lookup (used by tests) |
| `PREVIEW_MODE` | optional | `true` or `1` puts the site in preview: coming-soon banner, checkout and membership payment off, `noindex`. Unset to open the shop |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first boot | creates the first admin if none exists |
| `CONTACT_TO` | optional | contact-form and forum-report recipient (default `admin@umasbooks.org`) |
| `TZ` | no | forced to `Europe/Paris` by `lib/tz.js` at startup |
| `ADMIN_2FA_REQUIRED` | tests only | `false` turns the admin two-step requirement off in CI; ignored in production |

On Render, `render.yaml` declares the core variables (database, session secret,
`TOTP_ENCRYPTION_KEY`, mail, HelloAsso, Anthropic, seed admin); the optional
switches above (`PRICING_AI`, `AWARDS_AI`, `NYT_API_KEY`, `PREVIEW_MODE`, caps and
model overrides) are added by hand in the service's environment settings.
Startup validation (`lib/env.js`, production only) stops the boot if
`DATABASE_URL` or `SESSION_SECRET` is missing and logs a warning when mail,
payment or the base URL are not configured.

GitHub (repository **secrets** unless noted): `DATABASE_URL` (the database's
*external* URL, for backups), `GMAIL_USER`, `GMAIL_APP_PASSWORD`; required offsite
backup (Backblaze B2), used by the nightly backup, the restore test and the
freshness check: **repository variables** `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_REGION` (and `BACKUP_S3_PREFIX`) plus **repository secrets**
`BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY`.

---

## 15. Limits, trade-offs and known gaps

Deliberate trade-offs (revisit only if traffic or risk changes):

* **One instance, in-memory rate limits and timers.** Limits reset on restart; two
  instances would each run every sweep (the inactivity-warning email is claimed
  before sending so it would not be doubled, the other jobs are not guarded). Fine
  for one small shop; a shared store or advisory-lock-guarded jobs would be the
  first scale-up step.
* **Per-request user lookup** (`attachUser`) — one primary-key read per logged-in
  request, deliberate for instant revocation.
* **Photos live in Postgres.** They have their own `images` table and are served
  with a year-long cache, so they no longer bloat pages or JSON, but they do make
  the database and every backup bigger. A daily job deletes images that are over
  7 days old and that no row references any more (a replaced cover is cleaned up
  after a week); re-uploads of the same file share one row. Object storage is the proper next step
  and would need no change to the URLs.
* **Search is `ILIKE '%q%'`** over a few thousand books — fine now; trigram or
  full-text indexes when the catalogue grows.
* **One Google Workspace mailbox** (`admin@umasbooks.org`) sends both human and
  system mail: roughly 2,000 messages a day, signed by Google (SPF is in place;
  confirm DKIM in the Google Admin console and add a DMARC record in the
  Squarespace DNS). Plenty for this site; a transactional provider is not needed.
* **Languages are English and French only**, and admin screens (and admin-only
  alert emails) are English only. French is rendered on the server everywhere
  else; the marketing pages still carry small in-page dictionaries that a script
  re-applies after a client-side toggle, so a new marketing string has to be added
  in both places.
* **Awards and price lookups depend on outside services.** Wikidata, the NYT
  API and the AI web searches can be slow, wrong or unavailable; every call has a
  timeout, failures are retried later, AI-found awards need an admin's approval
  and a price is only ever a suggestion. Daily caps bound the Anthropic cost.

Open items worth knowing:

* Reservations hold a copy for two weeks. There is no public reservation form (the old `POST /books/:id/reserve` route was removed because anyone could hold copies under any email address); holds are made by admins or by the book-request flow.
* The 6-hourly membership backstop only looks at orders from the last 3 days;
  older missed payments rely on the webhook or account verification.
* If the only admin loses their phone and recovery codes there is nobody to reset
  them; the fix is a one-line database update in the Render shell (see
  `umas-books/ARCHITECTURE.md`).
* The unique-ISBN index is skipped by its migration if duplicate ISBNs existed
  when it ran; it has to be created by hand after merging them.
* Backblaze lifecycle rules are set in the Backblaze console, not in code. The
  freshness check notices a missing or stale newest nightly dump, but would not
  notice the rules being changed (for example the monthly copies expiring early).
* Only the newest `full/` dump is checked for freshness; the `monthly/` copy on
  the 1st is not checked separately.
* Price suggestions record what was suggested and what the volunteer chose
  (`suggested_price`, `price_basis`) but nothing yet uses that data to tune the
  rules or reports on it.
* Migration numbers 049, 051 and 052 do not exist (the sequence has gaps); that is
  harmless, the runner applies whatever files exist, but do not "fill" the gaps.
* The daily image cleanup only keeps images that a known column references;
  a new image-bearing column must be added to `IMAGE_REFERENCES` in
  `lib/imageCleanup.js` (a test fails if it is forgotten).
* Squarespace-era files (`SQUARESPACE.md`, `squarespace-*.html`, `tools/`) remain
  in the repo root, unused.
