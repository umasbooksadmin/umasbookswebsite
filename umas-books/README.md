# umas-books (backend)

A real, separate web app for Uma's Books and Adventures: member accounts,
a community forum, volunteer shift and meeting scheduling, a quarterly
charity vote, and admin-side book inventory management. Node.js +
Express + PostgreSQL, server-rendered with EJS, sessions stored in
Postgres.

This app is the whole site: Squarespace has been retired, and the public
marketing pages (home, about, books, events, …) are rendered by this same
Express process alongside the members area — see
[ARCHITECTURE.md](ARCHITECTURE.md#one-app-two-front-ends). It runs on
Render.

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

### Running the tests

```bash
npm test                          # node --test: unit + integration
node --test --test-concurrency=4  # same, but caps how many app servers boot at once
npm run lint
```

The integration tests (`test/integration/`) boot the real app as a child
process and hit it over HTTP. With no `DATABASE_URL` set they create (and
drop) a throwaway `umasbooks_test_<port>_<timestamp>` database per test
file, so a local Postgres with `createdb`/`dropdb` on your `PATH` is all
they need. With `DATABASE_URL` set (as in CI) every file shares that one
database and runs concurrently — a test that does something global to it
must use `startTestApp({ port, isolated: true })`. Each test file uses its
own fixed port (see the `PORT` constant at the top of the file); pick an
unused one for a new file.

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
- **Email verification** — a new signup must click an emailed link before
  the account counts as verified (`src/lib/emailVerification.js`); an admin
  changing a member's email re-triggers it.
- **Online checkout** (`/cart`) — book copies and class drop-in seats are
  paid for through HelloAsso (`src/lib/helloasso.js`, webhook at
  `/webhooks/helloasso`); membership payments are matched to accounts the
  same way. See ARCHITECTURE.md's "Payment reliability" section.
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
  copy for pickup with just a name and email (reserving takes no online
  payment — you pay in person when you collect it; paying online is the
  separate cart/checkout flow above). A reserved copy is held (status
  `reserved`) until an admin cancels the reservation or marks it sold from
  the book's admin page.
- **Admin** (`/admin`, admin accounts only) — a proper multi-page section
  with its own sub-nav (`views/partials/admin_subnav.ejs`): an overview
  with counts/links, plus dedicated pages for Books & Orders, English
  Programs (`/admin/sessions`), Events, Volunteer Shifts, Meetings,
  Announcements, Accounts/Members, Charities, and Blog. Add a new admin area by adding a route in `src/routes/admin.js`,
  a view under
  `views/admin/`, and a link in the subnav partial.

Note: an earlier, member-only events feature was removed and later
replaced by the public **Events** and **Sessions** features above (the
latter's tables are still named `classes`/`class_signups`). The old
`event_rsvps` table (member-only sign-ups) is left in place, unused —
public sign-ups now go through `event_signups`/`class_signups` instead.

### Email setup (Gmail/Google Workspace SMTP)

All outgoing email — password reset, email verification, the contact
form, reservation/pickup mail, and the admin error alerts — sends through
`admin@umasbooks.org` (or whichever mailbox you configure) via SMTP. This
needs a Google **App Password**, not
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
creates the first admin; that account can then promote (or demote) other
accounts from `/admin/members`.

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

The first admin account is created by `npm run seed`, which `startCommand`
runs on every boot (the free plan has no Shell tab, so this is the only
route there): set `SEED_ADMIN_PASSWORD` (and optionally `SEED_ADMIN_EMAIL`)
in the service's **Environment** tab before the first deploy. Or, to do it
by hand, point `DATABASE_URL` at the production database locally:

```bash
SEED_ADMIN_PASSWORD='a-real-password' npm run seed
```

In production (`NODE_ENV=production`) the app checks its environment at
boot: it refuses to start, naming every missing variable, if `DATABASE_URL`
or `SESSION_SECRET` is unset, and logs a loud `[env] WARNING` at startup
if the Gmail or HelloAsso variables are unset (email, including error
alerts, or online payment would then be silently off). On `SIGTERM` (every
Render deploy/spin-down) it stops taking new connections, lets in-flight
requests — notably HelloAsso webhooks — finish, closes the database pool and
exits 0; after 10 seconds it exits anyway.

## Offsite backups in Backblaze B2

Besides the `db-backups` branch, the nightly workflow also uploads each dump
to a private **Backblaze B2** bucket (`<bucket>/store-backups/umas_books_<UTC
timestamp>.dump`, plus a copy under `store-backups/monthly/` on the 1st of
each month). B2 speaks the S3 protocol, so the workflow uses the standard
AWS CLI pointed at B2's endpoint. The upload is skipped silently until it is
configured, and it runs *after* the GitHub copy, so a misconfigured bucket
can never cost you that night's backup — a failed upload fails the job and
sends the usual failure email.

**One-time setup, in Backblaze:**

1. Create a **private** bucket in an EU region. Turn **Default Encryption**
   on (SSE-B2) — dumps contain member data. Leave *Object Lock* off unless
   you want undeletable backups (it also blocks the lifecycle rule below).
2. *App Keys → Add a New Application Key*: limit it to **that one bucket**,
   type **Read and Write** (the restore test needs to list and read). Copy
   the **keyID** and the **applicationKey** immediately — the key is shown
   only once. Never paste either into chat, issues or code.
3. Note the bucket's **Endpoint** (e.g. `s3.eu-central-003.backblazeb2.com`);
   the region is the middle part (`eu-central-003`).

**One-time setup, in GitHub** (repo → Settings → Secrets and variables →
Actions). The type matters — the workflows read these two kinds only:

| Tab | Section | Name | Value |
|---|---|---|---|
| Variables | **Repository variables** | `BACKUP_S3_BUCKET` | the bucket name |
| Variables | **Repository variables** | `BACKUP_S3_ENDPOINT` | `https://` + the endpoint, e.g. `https://s3.eu-central-003.backblazeb2.com` |
| Variables | **Repository variables** | `BACKUP_S3_REGION` | e.g. `eu-central-003` (just the code) |
| Variables | **Repository variables** | `BACKUP_S3_PREFIX` | optional; defaults to `store-backups` |
| Secrets | **Repository secrets** | `BACKUP_S3_KEY_ID` | the B2 keyID |
| Secrets | **Repository secrets** | `BACKUP_S3_APPLICATION_KEY` | the B2 applicationKey |

(Not *environment* variables/secrets: the workflows don't name a GitHub
environment, so those would be invisible to them and the upload would
quietly skip itself.)

**Retention:** the workflow doesn't delete anything. In Backblaze, open the
bucket → *Lifecycle Settings* → *Use custom lifecycle rules* and add two
rules: file path `store-backups/umas_books_`, days from uploading to hiding
**35**, days from hiding to deleting **1**; and file path
`store-backups/monthly/`, days to hiding **730**, to deleting **1**.

**Check it works:** run the *Nightly database backup* workflow by hand
(Actions tab → Run workflow, branch `main`) and look for the new file in the
bucket, then run *Monthly backup restore test* by hand — once the settings
exist it restores the newest dump **from B2**. Once that has passed you can
decide whether to stop writing the GitHub copy.

## Restoring from a backup

`.github/workflows/nightly-db-backup.yml` dumps the production database
every night (03:00 UTC) with `pg_dump --format=custom` and commits the file
to the private **`db-backups`** branch as `backups/umas_books_<UTC
timestamp>.dump`, keeping the newest 30. Once a month,
`.github/workflows/backup-restore-test.yml` restores the newest dump into a
scratch Postgres and checks the data, emailing admin@umasbooks.org if that
fails — so this procedure is exercised regularly, not just on a bad day.

> **A dump contains member data** (names, emails, order details, password
> hashes). Download it only to a machine you control, restore it only into
> a database you control, never commit or share it, and delete the local
> copy when you are done. If the repository were ever made public the
> `db-backups` branch would become world-readable — both backup workflows
> refuse to run on a public repo for that reason.

You need the PostgreSQL **18** client tools (the dumps are made with 18;
an older `pg_restore` cannot read them) and the GitHub CLI (`gh`),
logged in with access to the repo.

1. **Download a dump.** From Backblaze B2 (once configured — see above),
   with the AWS CLI configured for B2 (`aws configure` with the B2 keyID and
   applicationKey, region from the endpoint):

   ```bash
   EP=https://s3.eu-central-003.backblazeb2.com   # your endpoint
   aws s3 ls s3://YOUR-BUCKET/store-backups/ --endpoint-url $EP | tail
   aws s3 cp s3://YOUR-BUCKET/store-backups/umas_books_<timestamp>.dump restore.dump --endpoint-url $EP
   ```

   Or from the GitHub branch — list the available ones, then fetch one:

   ```bash
   REPO=umasbooksadmin/umasbookswebsite
   gh api "repos/$REPO/contents/backups?ref=db-backups" --jq '.[].name'
   # pick a name from the list, e.g. umas_books_2026-09-30T03-00-12Z.dump
   gh api -H "Accept: application/vnd.github.raw" \
     "repos/$REPO/contents/backups/umas_books_2026-09-30T03-00-12Z.dump?ref=db-backups" \
     > restore.dump
   ```

   (Alternatively `git fetch origin db-backups` and
   `git show origin/db-backups:backups/<file> > restore.dump`. The contents
   API caps a single file at 100 MB; use the git route if the dump ever
   grows past that.)

2. **Restore into a fresh database.** Never restore over a database you
   still need:

   ```bash
   createdb umas_books_restored
   pg_restore --no-owner --no-privileges --exit-on-error \
     -d umas_books_restored restore.dump
   ```

   For a managed target (a new Render Postgres), use its **external**
   connection string instead of a database name:
   `pg_restore --no-owner --no-privileges --exit-on-error -d "$NEW_EXTERNAL_DATABASE_URL" restore.dump`.
   If your default `pg_restore` is older than 18, call the 18 binary by path
   (e.g. `/usr/lib/postgresql/18/bin/pg_restore` on Debian/Ubuntu).

3. **Sanity-check it:**

   ```bash
   psql umas_books_restored -c "SELECT
     (SELECT count(*) FROM users)  AS users,
     (SELECT count(*) FROM books)  AS books,
     (SELECT count(*) FROM orders) AS orders,
     (SELECT max(applied_at) FROM schema_migrations) AS last_migration;"
   ```

   The counts should look like the live site's, and `last_migration`
   should be recent.

4. **Point the app at it (disaster recovery only).** In the Render
   dashboard, open the `umas-books` service → **Environment**, set
   `DATABASE_URL` to the restored database's connection string (for a
   database in the same Render account/region use its **Internal** URL), and
   save — Render redeploys. `render.yaml` normally wires `DATABASE_URL` to
   `umas-books-db`, so if you later re-sync the Blueprint, either restore
   into `umas-books-db` itself or update `render.yaml` to match. Boot runs
   `npm run migrate`, which applies any migrations newer than the dump.
   Check `/healthz` returns 200.

5. **Clean up:** `rm restore.dump`, and `dropdb umas_books_restored` if it
   was only a drill.

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

- No event/announcement notification emails yet (email covers password
  reset, signup verification, the contact form, reservations and error
  alerts; the `sendMail` helper in `src/mailer.js` is ready to reuse).
- No moderation UI for forum threads/replies — an admin can edit or delete
  announcements and blog posts, but removing a forum post means deleting
  the row in the database.
- No general JSON API — this is a server-rendered app. The few `/api/...`
  routes (book search, latest arrivals, cart count, favorites) exist for
  the site's own pages.
