# umas-books (backend)

A real, separate web app for Uma's Books and Adventures: member accounts,
a community forum, volunteer shift and meeting scheduling, a quarterly
charity vote, and admin-side book inventory management. Node.js +
Express + PostgreSQL, server-rendered with EJS, sessions stored in
Postgres.

This is **independent of Squarespace** — Squarespace stays the public
website and shop; this app runs on its own (Render) and members reach it
via a link from the main site.

See [ARCHITECTURE.md](ARCHITECTURE.md) for routing, shared views, data
domains, environment variables, and the migration/deploy process — this
file is about what each feature does, that one is about how it's built.

## Local development

Requires Node 22 and a local PostgreSQL server.

```bash
npm install
createdb umas_books
cp .env.example .env        # edit DATABASE_URL / SESSION_SECRET if needed
npm run migrate
SEED_ADMIN_PASSWORD='pick-a-password' npm run seed   # creates admin@umasbooks.org
npm start                   # http://localhost:3000
```

`npm run seed` only creates the first admin account if none exists yet —
safe to re-run. Change `SEED_ADMIN_EMAIL` too if you don't want
`admin@umasbooks.org`.

## What's included

- **Accounts** — signup/login/logout, sessions stored in Postgres
  (`connect-pg-simple`), passwords hashed with bcrypt.
- **Dashboard** (`/dashboard`) — recent announcements, forum preview,
  upcoming volunteer shifts and meetings, the active charity vote.
- **Forum** (`/forum`) — threads and replies, any logged-in member can post.
- **Charity vote** (`/charity`) — admin starts a round with named options;
  each member gets one vote per round, changeable while the round is open.
- **Volunteer shifts** (`/volunteer`) — a month-calendar view. Admin creates
  shifts (role, time range, optional notes), optionally repeating weekly
  for several weeks in one go; each shift takes one volunteer. Members
  browse the calendar and sign up or cancel.
- **Meetings** (`/meetings`) — a month-calendar view. Admin schedules
  meetings (title, date/time, location, agenda) and posts minutes
  afterward; members RSVP ("I'll be there") or cancel, and see past
  meetings with minutes once posted.
- **Events** (`/events`, public, no login, guest sign-up with name/email)
  and **Sessions** (`/sessions`, calendar public/no login, but signing up
  requires a member account) — month-calendar views, each backed by its
  own table. Admin creates/edits/deletes entries (title, description,
  location, time range, capacity) from `/admin/events` / `/admin/sessions`
  and sees who's signed up; capacity is enforced on both.
- **Password reset** — a member can request a reset link at
  `/forgot-password` (emailed via Gmail/Google Workspace SMTP, one-hour
  expiry, single use), or a logged-in member can change their password
  directly at `/account/password`.
- **Inventory** (`/admin/inventory`, admin only) — full CRUD for the book
  catalog. Each title (`books`, with a genre/`categories` field) can have
  several individually-tracked physical copies (`book_copies`, each with
  its own condition, price, acquisition cost, acquisition date, and
  status: in stock / reserved / sold / donated / damaged). Adding a book
  can start from a scan at `/admin/inventory/scan`: typing/scanning an
  ISBN looks up metadata via the free Open Library API, or a photo of the
  cover or barcode is read by Claude's vision API (`ANTHROPIC_API_KEY`,
  see below) to extract the title/author/ISBN, which is then matched
  against Open Library. Either path lands on a prefilled "confirm before
  saving" form — nothing is saved without a look. Books can also be added
  or edited by hand with no scan at all. If a book has no description, one
  is generated automatically by Claude (also re-generatable by hand from
  the book's page).
- **Book search** (`/books`, public, no login) — anyone can search
  in-stock inventory by title, author, or genre, and reserve a specific
  copy for pickup with just a name and email (no online payment — you pay
  in person when you collect it). A reserved copy is held (status
  `reserved`) until an admin cancels the reservation or marks it sold from
  the book's admin page.
- **Admin** (`/admin`, admin accounts only) — a proper multi-page section
  with its own sub-nav (`views/partials/admin_subnav.ejs`): an overview
  with counts/links, plus dedicated pages for Members, Announcements,
  Volunteer Shifts, Meetings, Events, Classes, Inventory, and Charity
  Vote. Add a new admin area by adding a route in `src/routes/admin.js`,
  a view under
  `views/admin/`, and a link in the subnav partial.

Note: an earlier, member-only events feature was removed and later
replaced by the public **Events** and **Classes** features above. The old
`event_rsvps` table (member-only sign-ups) is left in place, unused —
public sign-ups now go through `event_signups`/`class_signups` instead.

### Email setup (Gmail/Google Workspace SMTP)

Password reset emails send through `admin@umasbooks.org` (or whichever
mailbox you configure) via SMTP. This needs a Google **App Password**, not
the regular account password:

1. In that Google account, turn on **2-Step Verification** (required before
   App Passwords are available).
2. Go to Google Account → Security → **App passwords**, create one for
   "Mail" / "Other", and copy the 16-character password it gives you.
3. Set `GMAIL_USER` (the full email address) and `GMAIL_APP_PASSWORD` (that
   16-character password, no spaces) as env vars — locally in `.env`, or in
   Render's dashboard under the service's **Environment** tab (they're
   marked `sync: false` in `render.yaml`, so Render won't auto-fill them —
   you add them once by hand).

Until both are set, the app doesn't fail — it just logs what it would have
sent to the console instead, which is enough for local development.

There's no separate "customer" vs "admin" signup flow — the seed script
creates the first admin; that account can be used to promote others later
by hand (`UPDATE users SET is_admin = TRUE WHERE email = '...'`) since
there's no admin-management UI yet.

### Photo scanning setup (inventory)

The ISBN-lookup half of `/admin/inventory/scan` works with no setup —
Open Library needs no API key. The photo-scanning half (reading a cover
or barcode photo) needs an Anthropic API key:

1. Get a key at [console.anthropic.com](https://console.anthropic.com).
2. Set `ANTHROPIC_API_KEY` as an env var — locally in `.env`, or in
   Render's dashboard under the service's **Environment** tab (marked
   `sync: false` in `render.yaml`, so you add it once by hand).

Until it's set, the scan page just hides the photo option and says so —
ISBN entry and manual add still work fully.

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint that provisions:
- a free Postgres database (`umas-books-db`)
- this app as a web service (`umas-books`), wired to that database's
  `DATABASE_URL` and a generated `SESSION_SECRET` automatically

To deploy: in the Render dashboard, **New +** → **Blueprint**, connect the
`umasbookswebsite` GitHub repo, and Render will read `render.yaml` and set
both up.

`render.yaml`'s `startCommand` runs `npm run migrate` before `npm start`,
so migrations run automatically on every boot — new migration files just
need to be committed and pushed, no manual step. (Render's dedicated
`preDeployCommand` would be the more obvious fit, but it needs a paid
instance type; the free plan used here rejects it outright at Blueprint
creation time with "pre-deploy command is not supported for free tier
services" — confirmed by trying it. Running migrate in `startCommand`
works on free tier and is safe because every migration file is written
to be idempotent, so re-running the whole set on every boot — including
free-tier spin-down/wake cycles — is harmless.)

Because `rootDir` is `umas-books`, Render by default only auto-deploys
when a push changes files inside `umas-books/` — a push that only touches
the marketing pages at the repo root (`index.html`, `assets/`, …) would be
silently skipped, even though this service serves those pages too. The
`buildFilter` in `render.yaml` (paths `"**"`) is meant to make any change in
the repo trigger a deploy, but Render only applies `render.yaml` edits when
the Blueprint syncs — in practice a root-only push was still skipped after
adding it. The reliable fix is one-time, in the Render dashboard: the
`umas-books` service → **Settings → Build & Deploy → Build Filters** →
add an included path of `**` (or sync the Blueprint so it picks up
`render.yaml`). Until then, if a push doesn't show up live, use **Manual
Deploy → Deploy latest commit**.

Seeding the first admin account is still a one-time manual step (it
needs a password only you should choose) — via Render's **Shell** tab for
the service, or by pointing `DATABASE_URL` at the production database
locally:

```bash
SEED_ADMIN_PASSWORD='a-real-password' npm run seed
```

Render's free Postgres plan is time-limited (currently expires after a
period of inactivity/trial per Render's terms) — worth checking their
current free-tier database policy before relying on it long-term, and
upgrading to a paid database if this needs to stay up indefinitely.

## Security

- Passwords hashed with bcrypt (cost 12); reset tokens are 256-bit random,
  only a SHA-256 hash is ever stored, single-use, 1-hour expiry.
- Session cookies are `httpOnly`, `secure` in production, `SameSite=Lax`.
- **CSRF protection** — every form carries a per-session token
  (`src/middleware/csrf.js`); any POST without a matching token is
  rejected with 403. New forms must include
  `<%- include('partials/csrf_field') %>` right after `<form ...>`.
- **CSP** (`src/index.js`'s `helmet` config) — `script-src 'self'` with no
  `unsafe-inline`/`unsafe-eval`; `style-src` allows inline styles (used
  throughout the views) and Google Fonts' stylesheet host.
- **Login hardening** — a login attempt against a nonexistent email still
  runs a same-cost bcrypt compare (against a fixed dummy hash) so response
  timing can't be used to enumerate registered emails; 5 failed attempts
  on one account locks it for 15 minutes.
- **Password requirements** — at least 8 characters, with an uppercase
  letter, a lowercase letter, a number, and a symbol (`src/lib/passwordPolicy.js`),
  enforced both client-side (`pattern`/`minlength` on the form inputs) and
  server-side.
- **Breach checking** — new/changed passwords are checked against the
  HaveIBeenPwned range API (`src/lib/passwordPolicy.js`) using k-anonymity
  (only a 5-char hash prefix leaves the server, never the password); fails
  open (allows the password) if that API is unreachable, so a third-party
  outage never blocks signup.
- Deliberately **not** implemented: 2FA.

## Known gaps for a v1

- Email is reset-flow only for now — no signup verification, no event/
  announcement notification emails yet (the `sendMail` helper in
  `src/mailer.js` is ready to reuse for those later).
- No admin UI for promoting other members to admin, or for editing/deleting
  posted content (edit user roles or delete a thread directly in the
  database for now).
- No CORS/API layer — this is a server-rendered app, not a JSON API, so it
  can't be embedded as a widget inside a Squarespace page; members follow a
  link to it instead.
