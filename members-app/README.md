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
- **Admin** (`/admin`, admin accounts only) — post announcements, add
  events, manage volunteer shifts, start/close charity vote rounds.

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
both up. After the first deploy, run the migration and seed once against
the production database — either via Render's shell for the service
(`Shell` tab in the dashboard) or by pointing `DATABASE_URL` at the
production database locally:

```bash
npm run migrate
SEED_ADMIN_PASSWORD='a-real-password' npm run seed
```

Render's free Postgres plan is time-limited (currently expires after a
period of inactivity/trial per Render's terms) — worth checking their
current free-tier database policy before relying on it long-term, and
upgrading to a paid database if this needs to stay up indefinitely.

## Known gaps for a v1

- No password reset flow (forgot password) yet.
- No email at all yet — no verification, no notification emails.
- No admin UI for promoting other members to admin, or for editing/deleting
  posted content (edit user roles or delete a thread directly in the
  database for now).
- No CORS/API layer — this is a server-rendered app, not a JSON API, so it
  can't be embedded as a widget inside a Squarespace page; members follow a
  link to it instead.
