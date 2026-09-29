# Architecture

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
| `csrf_field.ejs` | every form (~24 views) | the hidden `_csrf` input every POST form must include — see [Security](README.md#security) |
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

29 tables (`migrations/`), grouped by what they belong to:

- **Accounts & auth** — `users`, `password_reset_tokens`,
  `email_verification_tokens`
- **Shop / checkout** — `books`, `book_copies`, `orders`, `order_items`
  (an order line references *either* a book copy *or* a class drop-in
  seat, never both — see the `order_items_one_item_type` check
  constraint)
- **Membership** — `membership_payments` (HelloAsso payment records,
  matched to a `users` row by verified email — see
  `src/lib/membership.js`)
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
| `SESSION_SECRET` | yes (app throws at startup if unset) | signs the session cookie |
| `PORT` | no (defaults 3000) | HTTP listen port |
| `NODE_ENV` | no | only meaningfully checked in `src/lib/baseUrl.js` — `production` requires `APP_BASE_URL`/`RENDER_EXTERNAL_URL` to be set |
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

## Migration process

`src/migrate.js` runs every `.sql` file in `migrations/`, in filename
order (`001_`, `002_`, …), every time it's invoked. There is no
migrations-tracking table and no "already applied" check of any kind.

**Every migration file must therefore be safe to re-run against a
database that already has it applied** — `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, a `DROP CONSTRAINT IF EXISTS` immediately
before re-adding one, guarding a `RENAME COLUMN` with an
`information_schema` check first, and so on. This isn't optional
convention — it's load-bearing, since `npm run migrate` runs on *every*
deploy (see below), not just the first one. Don't trust an in-file
comment that claims otherwise: `029_drop_wishlist.sql` says "Not
auto-applied" but it runs like every other file, and the table it drops
is in fact gone from every environment that's deployed since.

To add a migration: create the next-numbered `.sql` file, write it
idempotently, and commit it — no other step. CI's `migration-test` and
`test` jobs (`.github/workflows/ci.yml`) both apply every migration to a
brand-new database on every run, which is the main thing keeping this
guarantee honest.

## Deploy sequence

Production runs on Render, configured entirely by `render.yaml` (a
Render Blueprint) at the repo root:

1. A push to `main` triggers **two independent things in parallel**:
   Render's own webhook starts a deploy, and GitHub Actions runs the CI
   workflow (`.github/workflows/ci.yml`). Neither currently gates the
   other — CI passing is not required for Render to deploy. Treat a
   CI failure as "go fix this," not as something that already stopped a
   bad deploy.
2. Render's `buildCommand` runs `npm install`.
3. Render's `startCommand` runs `npm run migrate && npm run seed && npm
   start`, in that order, every time the service starts — including a
   free-tier spin-down/wake cycle, not just a real deploy. Both
   `migrate` and `seed` are written to be safe to re-run (see above; the
   seed script specifically only creates the first admin account if none
   exists yet).
4. The free Render plan doesn't support a dedicated pre-deploy command,
   which is why migrate/seed are folded into `startCommand` instead.

Nothing here currently blocks a bad migration or a failing app boot from
reaching production automatically — the safety net is writing migrations
idempotently, keeping CI green, and watching the deploy.
