# Uma's Books — Members Area (backend)

A real, separate web app: accounts, a community forum, event RSVPs, and a
quarterly charity vote for Uma's Books members. Node.js + Express +
PostgreSQL, server-rendered with EJS, sessions stored in Postgres.

This is **independent of Squarespace** — Squarespace stays the public
website and shop; this app runs on its own (Render) and members reach it
via a link from the main site.

## Local development

Requires Node 18+ and a local PostgreSQL server.

```bash
npm install
createdb umasbooks_members
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
  upcoming events, the active charity vote.
- **Forum** (`/forum`) — threads and replies, any logged-in member can post.
- **Events** (`/events`) — admin-created events; members RSVP (capacity
  enforced) or cancel.
- **Charity vote** (`/charity`) — admin starts a round with named options;
  each member gets one vote per round, changeable while the round is open.
- **Volunteer shifts** (`/volunteer`) — admin creates shifts (role, time
  range, capacity), optionally repeating weekly for several weeks in one
  go; members sign up or cancel, capacity enforced.
- **Meetings** (`/meetings`) — admin schedules meetings (title, date/time,
  location, agenda) and posts minutes afterward; members see upcoming
  meetings with their agenda and past meetings with minutes once posted.
- **Password reset** — a member can request a reset link at
  `/forgot-password` (emailed via Gmail/Google Workspace SMTP, one-hour
  expiry, single use), or a logged-in member can change their password
  directly at `/account/password`. An admin can also trigger a reset email
  for any member from `/admin/members`.
- **Admin** (`/admin`, admin accounts only) — a proper multi-page section
  with its own sub-nav (`views/partials/admin_subnav.ejs`): an overview
  with counts/links, plus dedicated pages for Members (send password
  resets), Announcements, Events, Volunteer Shifts, Meetings, and Charity
  Vote. Add a new admin area by adding a route in `src/routes/admin.js`,
  a view under `views/admin/`, and a link in the subnav partial.

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

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint that provisions:
- a free Postgres database (`umasbooks-members-db`)
- this app as a web service (`umasbooks-members`), wired to that database's
  `DATABASE_URL` and a generated `SESSION_SECRET` automatically

To deploy: in the Render dashboard, **New +** → **Blueprint**, connect the
`umasbookswebsite` GitHub repo, and Render will read `render.yaml` and set
both up.

`render.yaml` sets `preDeployCommand: npm run migrate`, so migrations run
automatically before every deploy going forward — new migration files
just need to be committed and pushed, no manual step. (This needs
checking against Render's current plan support: Pre-Deploy Command has
historically required a paid instance type, not the free plan used here
— watch the deploy's logs for a "Running migration: ..." step to confirm
it actually ran; if it's silently skipped on the free plan, fall back to
running `npm run migrate` by hand in the **Shell** tab after each deploy
that adds a migration.)

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
