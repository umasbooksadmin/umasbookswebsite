# Uma's Books — architecture overview

A complete picture of how the site is built, runs, is deployed, backed up and
protected. Every diagram below is [Mermaid](https://mermaid.js.org/) and renders
directly on GitHub. For file-level detail (route table, environment variables,
migration rules) see [`umas-books/ARCHITECTURE.md`](../umas-books/ARCHITECTURE.md);
for running and restoring it see [`umas-books/README.md`](../umas-books/README.md).

> **Scope.** This document describes `main` plus the open pull requests #115
> (auth/membership), #116 (reliability/CSP) and #118 (Paris time); it should be
> merged after them. Items from those PRs are marked *(#115)*, *(#116)*, *(#118)*.

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
outside services. GitHub holds the code, runs the tests, and takes the backups.

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
    DB[("Postgres<br/>umas-books-db")]
    W <--> DB
  end

  subgraph External["Outside services"]
    direction TB
    HA["HelloAsso<br/>payments, membership form"]
    GM["Gmail SMTP<br/>all outgoing mail"]
    AN["Anthropic API<br/>book-cover scan"]
    OL["Open Library, archive.org<br/>ISBN lookup, covers"]
    PW["Have I Been Pwned<br/>breach check"]
  end

  subgraph GitHub["GitHub (private repo)"]
    direction TB
    REPO["main branch<br/>6 required checks"]
    ACT["Actions: CI, backups,<br/>restore test, uptime"]
  end

  OFF[("Backblaze B2<br/>private bucket, EU")]

  People -->|"browse, log in, buy"| W
  W -->|"API calls and mail"| External
  HA -->|"webhook: a hint only"| W
  REPO -->|"merge deploys"| W
  ACT -->|"pg_dump"| DB
  ACT -->|"GET /healthz"| W
  ACT -->|"nightly backup"| OFF
```

**Why one app.** Squarespace was retired; the marketing pages are EJS views in
the same Express process as the members area, so there is one deployment, one
login, one database and one thing to monitor.

---

## 2. Technology

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 (`engines: 22.x`) | pinned in `package.json` and `.node-version` |
| Web | Express 5 | rejected async handler promises reach the error handler natively |
| Views | EJS, server-rendered | marketing views in `views/marketing/`; EN/FR strings inline |
| Database | PostgreSQL (Render, `1c-2g`) | `pg` pool; `timestamptz` everywhere |
| Sessions | `express-session` + `connect-pg-simple` | rows in table `session`; 30-day sliding cookie |
| Security middleware | `helmet` (CSP, HSTS), `express-rate-limit`, custom CSRF | |
| Uploads | `multer` (memory) + `sharp` re-encode to JPEG | admin only; images stored as data URIs in rows |
| Mail | `nodemailer` over Google Workspace SMTP | one mailbox (`admin@umasbooks.org`) for human and system mail |
| Payments | HelloAsso (checkout intents + hosted membership form) | OAuth client credentials |
| Hosting | Render Blueprint (`render.yaml`) | web `1c-2g`, database `1c-2g`, Frankfurt |
| CI/CD | GitHub Actions | six required checks; Render deploys on merge |

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
  end

  subgraph RT["src/routes"]
    direction LR
    PUB["Public<br/>books, events, sessions, blog, contact"]
    MEMB["Members<br/>dashboard, account, forum, charity,<br/>volunteer, meetings"]
    COM["Commerce<br/>cart, helloassoWebhook"]
    AUTH["auth.js<br/>signup, verify, login, reset, password"]
    ADM["admin/*<br/>members, inventory, events, sessions,<br/>meetings, volunteer shifts, blog,<br/>announcements, charity, dashboard"]
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
    L8["bookLookup.js, coverVision.js,<br/>uploadImage.js (#116), health.js (#116)"]
  end

  DBM["src/db.js<br/>pg Pool, withTransaction,<br/>error handler and timeouts (#116)"]
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

---

## 4. Request lifecycle

Order matters here — the registration order in `src/index.js` *is* the design.
Static files are served before the session so that images and CSS never cost a
database read, and the HelloAsso webhook is mounted before CSRF because it is an
external POST with no token.

```mermaid
flowchart TD
  R([Incoming request]) --> C["compression"]
  C --> S1["Static files<br/>/public, /assets, /logo.png<br/>(7-day cache)"]
  S1 --> H["GET /healthz<br/>SELECT 1, 3 s limit, 503 on failure (#116)"]
  H --> HEL["helmet<br/>CSP, HSTS, no-referrer"]
  HEL --> U["urlencoded body parser"]
  U --> SES["express-session<br/>Postgres store, cookie umasbooks.sid"]
  SES --> REF["session refresh<br/>saved at most once a day"]
  REF --> AU["attachUser<br/>re-reads role flags, disabled,<br/>password_changed_at by primary key"]
  AU --> LOC["view locals<br/>user, cart count, lazy CSRF token"]
  LOC --> UP["admin upload mounts<br/>requireAdmin first, then multer"]
  UP --> WH["POST /webhooks/helloasso<br/>rate-limited, before CSRF"]
  WH --> CS["csrfProtection<br/>every other POST"]
  CS --> API["/api/csrf-token, /api/session"]
  API --> MK["marketing pages<br/>(MARKETING_PAGES list)"]
  MK --> RM["route modules<br/>auth, dashboard, account, forum, charity,<br/>volunteer, meetings, events, blog,<br/>sessions, books, cart, contact, admin"]
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
  LoggedIn --> LoggedIn: attachUser re-checks the row every request
  LoggedIn --> Anonymous: logout, disabled, deleted, or password changed elsewhere
  Anonymous --> Reset: POST /forgot-password (neutral reply)
  Reset --> Verified: reset link used once; also verifies the email and clears the lockout (#115)
```

Key rules:

* **Passwords** — bcrypt cost 12, minimum policy plus a Have-I-Been-Pwned
  k-anonymity breach check; a locked account (5 failures, 15 min) answers like a
  wrong password; the lockout counter is one atomic `UPDATE` *(#115)*.
* **Sessions** — id regenerated at login; the session is **saved before the
  redirect** (`lib/session.js`) because `express-session` otherwise answers
  before its write lands; cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
* **Email verification gates identity-sensitive features**: order history on
  `/account` and automatic membership attribution both require
  `email_verified_at`. Accounts created by an admin are verified immediately
  (the invite link proves the mailbox); existing accounts at migration 032 were
  grandfathered as verified.
* **CSRF** — a per-session token created lazily, compared in constant time;
  `/api/csrf-token` saves the session before answering.
* **Rate limits** are per IP, in memory (reset on restart): login 20 failures /
  15 min, reserve 5/h, checkout 10/h, cart edits 60/15 min, event sign-up 10/h,
  forum posts 10/h and replies 30/h, charity ideas 10/h, contact 5/15 min,
  webhook 30/5 min. See `src/middleware/rateLimits.js`.

---

## 6. Data model

About 30 tables, grouped by what they belong to. Foreign keys below are the real
ones from `migrations/`. (`event_rsvps` is unused; `wishlist_requests` was dropped
in migration 029.)

```mermaid
erDiagram
  users ||--o{ email_verification_tokens : "proves mailbox"
  users ||--o{ password_reset_tokens : "resets"
  users ||--o{ membership_payments : "HelloAsso payments"
  users ||--o{ forum_threads : writes
  forum_threads ||--o{ forum_replies : has
  users ||--o{ forum_replies : writes
  users ||--o{ favorites : saves
  books ||--o{ favorites : "is saved as"

  books ||--o{ book_copies : "physical copies"
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
| Accounts | `users`, `email_verification_tokens`, `password_reset_tokens`, `session`, `schema_migrations` | tokens stored as SHA-256 hashes; `session` is created by the store |
| Shop | `books`, `book_copies`, `orders`, `order_items`, `class_dropin_seats` | an order line is *either* a copy *or* a seat (CHECK constraint); copy status `in_stock / reserved / in_cart / sold` |
| Membership | `membership_payments` | one row per HelloAsso membership order; drives `member_expires_at` |
| Programs and events | `events`, `event_signups`, `classes`, `class_signups` | a `classes` row is a program session; `dropin_price` set = bookable |
| Community | `forum_threads`, `forum_replies`, `announcements`, `blog_posts`, `favorites` | rich text goes through `sanitize-html` |
| Volunteering | `volunteer_shifts`, `volunteer_signups`, `meetings`, `meeting_rsvps` | |
| Charity vote | `charity_rounds`, `charity_options`, `charity_votes`, `charities`, `charity_ideas` | a library of charities reused across rounds |

**Migrations** (`src/migrate.js`) run on every boot but each file applies
exactly once: a `schema_migrations` table, a per-file transaction and an
advisory lock. A pre-existing database is baselined, not re-migrated. Never edit
a deployed migration — add a new numbered file.

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

  B->>W: POST /cart/checkout (name, email)
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

---

## 8. Membership

Membership is sold on a **HelloAsso-hosted form** (embedded as an iframe — the
CSP needs `frame-src https://www.helloasso.com` *(#116)*), not through our
cart, so there is no local order row. The link back to an account is the **payer's
email address**.

```mermaid
flowchart LR
  P["Person pays on the<br/>HelloAsso form"] --> T{{"Trigger"}}
  T -- "webhook (any payload)" --> S
  T -- "every 6 h: orders from the last 3 days" --> S
  T -- "account verified, password reset,<br/>or created by an admin (#115)" --> S
  S["syncMembershipForEmail<br/>asks HelloAsso for that payer's<br/>Membership orders (exact email match)"]
  S --> V{"Account exists with a<br/>VERIFIED email?"}
  V -- no --> W["skip, log;<br/>retried when the account is verified"]
  V -- yes --> R["record payment,<br/>member_expires_at = payment date + 365 days,<br/>is_member = true"]
  R --> X["revoke only on positive evidence:<br/>order returned without an Authorized payment (#115)"]
```

Manual admin grants (`/admin/members`) have no `member_expires_at` and are never
touched by the sync or the expiry sweep.

---

## 9. Background jobs

There is no job queue: a few `setInterval` timers in the web process, plus
GitHub Actions for work that must survive the site being down.


```mermaid
flowchart LR
  subgraph proc["Web process (setInterval)"]
    A["every 10 min<br/>cart sweep"] 
    B["hourly (every 6th tick)<br/>late-payment re-check"]
    C["every 6 h<br/>reservations, reminders,<br/>membership expiry + backstop"]
  end
  subgraph gha["GitHub Actions (independent of Render)"]
    D["every 30 min<br/>uptime check"]
    E["03:00 UTC nightly<br/>database backup"]
    F["1st of month, 05:00 UTC<br/>restore test"]
  end
  A --> DB[("Postgres")]
  B --> HA["HelloAsso lookups"]
  C --> DB
  C --> HA
  D --> W["GET /healthz"]
  E --> DB
  F --> BK[("newest backup")]
```

| Job | Where | Cadence | Notes |
|---|---|---|---|
| Cart hold expiry, order reconcile | web process | 10 min | also on boot |
| Late-payment re-check | web process | hourly | only orders closed in the last 7 days |
| Reservation expiry, pickup reminder (day 11 of 14), membership expiry, membership backstop | web process | 6 h | read-time expiry also keeps pages right while idle |
| Uptime check | Actions | 30 min | emails on the **second** consecutive failure and on recovery |
| Database backup | Actions | 03:00 UTC | Backblaze B2 (required) |
| Restore test | Actions | monthly + manual | restores the newest backup into a scratch Postgres and checks it |

On shutdown (`SIGTERM`/`SIGINT`) the timers are cleared, the server stops taking
connections, in-flight requests finish, the pool closes, and the process exits
(hard stop after 10 s).

---

## 10. Dates and times

Uma's Books is in Albi, so **every typed and displayed time means Europe/Paris**
*(#118)*. Render's servers run in UTC, which used to store a typed 18:00 as
18:00Z (20:00 in Paris in summer).

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
  MRG --> RB["Render builds<br/>npm ci --omit=dev (#116)"]
  RB --> ST["start command:<br/>npm run migrate, npm run seed, npm start"]
  ST --> HC["Render health check<br/>GET /healthz"]
  HC --> LIVE(["Live"])
```

* Tests use a real Postgres; locally every test file gets its own throwaway
  database, but **in CI all files share one database and run concurrently** —
  tests must never do anything global to a shared table (use
  `startTestApp({ isolated: true })`).
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
    G -- yes --> D["pg_dump --format=custom<br/>(client 18, 3 attempts, images included)"]
    D --> U[("Backblaze B2<br/>store-backups/full/ and monthly/")]
    D --> E
    U --> E
  end

  subgraph monthly["Monthly restore test"]
    N["newest dump from Backblaze B2 (full/)"] --> RS["pg_restore into a scratch postgres:18"]
    RS --> CK["check key tables exist, row counts,<br/>at least one admin"]
    CK --> E2["failure: email to admin"]
  end

  subgraph watch["Uptime check every 30 min"]
    H["GET /healthz"] --> OK{"database reachable?"}
    OK -- "fails twice in a row" --> E3["one alert email"]
    OK -- "recovers" --> E4["one recovery email"]
  end
```

* **Dumps never go into the code repository**: they contain member names,
  emails, order details and password hashes, so they live only in the private
  Backblaze B2 bucket. Both backup workflows have read-only repository access.
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
  HL --> RL["Rate limits (per IP)<br/>login, reserve, checkout, cart, sign-ups,<br/>forum, contact, webhook"]
  RL --> SE["Session cookie: HttpOnly, Secure,<br/>SameSite=Lax; regenerated at login"]
  SE --> CF["CSRF token on every POST<br/>(webhook excepted: never trusts its body)"]
  CF --> AU["attachUser: role flags re-read from the DB<br/>every request; disabled, deleted or<br/>password-changed sessions drop"]
  AU --> RG["Role guards per route<br/>requireAuth, Member, Volunteer, Admin<br/>(admin guard runs before file uploads)"]
  RG --> VAL["Input handling<br/>validation helpers, parseId 404s,<br/>parameterised SQL, EJS escaping,<br/>sanitize-html for rich text"]
  VAL --> DBX[("Postgres")]
```

| Area | What is in place |
|---|---|
| Secrets | environment variables only (`sync: false` on Render; GitHub secrets for CI); `.env` is git-ignored; a secret scan runs on every PR; startup fails fast in production if `DATABASE_URL` or `SESSION_SECRET` are missing |
| Authentication | see §5; enumeration-resistant signup, login, reset; HIBP breach check |
| Authorization | admin guard before multer; admins cannot demote, disable or delete themselves |
| Payments | never trust webhook or return-URL content; amounts computed server-side; idempotent state change |
| Output | EJS auto-escapes; the only unescaped output is sanitised rich text or fixed markup; `esc()` in client code |
| Uploads | admin only, size-capped, decoded and re-encoded by `sharp` with a pixel cap *(#116)* |
| Email | one address only (no list separators), names stripped of links and angle brackets before going into mail *(#115)* |
| Transport to the database | `rejectUnauthorized: false` is deliberate: Render's internal Postgres uses a per-instance self-signed certificate on a private network |
| Supply chain | `npm audit` in CI; lockfile-exact builds; third-party Actions pinned by tag |

---

## 14. Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Render's internal connection string |
| `SESSION_SECRET` | yes | generated by Render |
| `NODE_ENV` | yes in prod | `production` enables secure cookies and the startup check |
| `PORT` | no | Render sets it |
| `PGSSLMODE` | no | `disable` for local/CI databases |
| `APP_BASE_URL` | recommended | absolute links in emails (verification, reset) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | recommended | all outgoing mail, including error alerts |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG` | for online payment | optional `HELLOASSO_API_BASE` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | optional | cover-scan in admin inventory |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first boot | creates the first admin if none exists |
| `CONTACT_TO` | optional | contact-form recipient (default `admin@umasbooks.org`) |

GitHub (repository **secrets** unless noted): `DATABASE_URL` (the database's
*external* URL, for backups), `GMAIL_USER`, `GMAIL_APP_PASSWORD`; required offsite
backup (Backblaze B2): **repository variables** `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_REGION` (and `BACKUP_S3_PREFIX`) plus **repository secrets**
`BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY`.

---

## 15. Limits, trade-offs and known gaps

Deliberate trade-offs (revisit only if traffic or risk changes):

* **One instance, in-memory rate limits and timers.** Limits reset on restart; two
  instances would each run every sweep. Fine for one small shop; a shared store
  or advisory-lock-guarded jobs would be the first scale-up step.
* **Per-request user lookup** (`attachUser`) — one primary-key read per logged-in
  request, deliberate for instant revocation.
* **Images stored as data URIs in rows.** Simple, but makes some JSON endpoints
  large and bloats backups; object storage behind long cache headers is the
  proper fix.
* **Search is `ILIKE '%q%'`** over a few thousand books — fine now; trigram or
  full-text indexes when the catalogue grows.
* **One Google Workspace mailbox** (`admin@umasbooks.org`) sends both human and
  system mail: roughly 2,000 messages a day, signed by Google (SPF is in place;
  confirm DKIM in the Google Admin console and add a DMARC record in the
  Squarespace DNS). Plenty for this site; a transactional provider is not needed.

Open items worth knowing:

* Reservations hold a copy for two weeks without an emailed confirmation link.
* No two-factor login for admins, and no audit log of admin actions.
* The 6-hourly membership backstop only looks at orders from the last 3 days;
  older missed payments rely on the webhook or account verification.
* Squarespace-era files (`SQUARESPACE.md`, `squarespace-*.html`, `tools/`) remain
  in the repo root, unused.
