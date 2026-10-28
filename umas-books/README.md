# umas-books (backend)

A real, separate web app for Uma's Books and Adventures: member accounts,
a community forum, volunteer shift and meeting scheduling, a quarterly
charity vote, and admin-side book inventory management. Node.js +
Express 5 + PostgreSQL, server-rendered with EJS, sessions stored in
Postgres.

This app is the whole site: Squarespace has been retired, and the public
marketing pages (home, about, books, events, …) are rendered by this same
Express process alongside the members area — see
[ARCHITECTURE.md](ARCHITECTURE.md#one-app-two-front-ends). It runs on
Render.

**Which document is authoritative for what:** this README says what each
feature does and how to run, deploy and restore it. [ARCHITECTURE.md](ARCHITECTURE.md)
is the authoritative file-level map: routing, shared views, data domains,
the **environment-variable inventory** (if a table here ever disagrees with it,
ARCHITECTURE.md wins), where each newer feature lives (Browse page, collections,
ISBNdb price, pricing exception), and the migration/deploy process.
[`../docs/architecture.md`](../docs/architecture.md) is the same system as
diagrams; [`../docs/runbook.md`](../docs/runbook.md) is for operating it.

Newer features in one line each (details and file paths in
[ARCHITECTURE.md](ARCHITECTURE.md#newer-features-where-they-live)): the Browse
page (search, collection / New In / genre carousels, paged results), admin-reviewed
curated collections with public pages in English and French, an ISBNdb publisher's
price suggestion on Add Book, the two-year exception to the fixed book price, and
case-insensitive shelf locations.

## Local development

Requires **Node 22** (production and CI run the exact version pinned in `.node-version`, currently `22.23.4`, which CI and Render also read; `package.json` says `22.x`) and a
local PostgreSQL server. If you have a newer Node installed, use a version
manager (`nvm use`, `fnm use` or `brew install node@22`) rather than
running on the newer one: native modules and test timing can differ.

### Where to keep your working copy

Keep it **outside `~/Documents`**, for example `~/dev/umasbooks`. A checkout
inside the iCloud-synced `~/Documents` folder makes git operations (checkout,
rebase, worktree) fail with `mmap failed`, and files can be evicted or
conflicted mid-operation. Any such old checkout is likely far behind: do not
try to repair it, clone fresh:

```bash
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/umasbooksadmin/umasbookswebsite.git umasbooks
cd umasbooks/umas-books
```

### Setup

```bash
npm ci                      # installs exactly package-lock.json (not `npm install`, which can change it)
createdb umas_books
cp .env.example .env        # edit DATABASE_URL / SESSION_SECRET if needed
npm run migrate
SEED_ADMIN_PASSWORD='pick-a-password' npm run seed   # creates admin@umasbooks.org
npm start                   # http://localhost:3000
```

`npm run seed` only bootstraps a brand-new database: it creates the first admin
account if no admin exists yet (and the email is not already taken), and in
that same run adds a sample announcement and charity vote round. It is safe to
re-run, never changes an existing account or password, and never stops the site
from starting (a failure is logged and emailed, and the exit code stays 0; set
`SEED_STRICT=true` to get exit 1, as CI does). Change `SEED_ADMIN_EMAIL` too if
you don't want `admin@umasbooks.org`. `SEED_SAMPLE_CONTENT=true` forces the
sample content on a database that already has an admin (only if the tables are
empty or have no active round).

### Running the tests

```bash
TZ=UTC PGOPTIONS='-c timezone=UTC' npm test   # the safe way to run everything (see the note below)
node --test --test-concurrency=4              # same idea, but caps how many app servers boot at once
npm run lint
```

Time zone note: the app forces `Europe/Paris` itself, but one test is sensitive to the
machine's time zone and daylight-saving date (it is queued for a fix). Until then run the
suite with `TZ=UTC PGOPTIONS='-c timezone=UTC'` in front, as above; a failure of a date test that disappears with those two settings is that test,
not your change.

The integration tests (`test/integration/`) boot the real app as a child
process and hit it over HTTP. With no `DATABASE_URL` set they create (and
drop) a throwaway `umasbooks_test_<port>_<timestamp>` database per test
file, so a local Postgres with `createdb`/`dropdb` on your `PATH` is all
they need. Each test file uses its own fixed port (see the `PORT` constant
at the top of the file); pick an unused one for a new file.

#### French (the second language of the whole customer side)

Everything customers see must be French when they choose French. A test
(`test/integration/i18nCrawler.test.js`) checks it page by page, form message by form
message and email by email, and fails when a new English text appears on the French side.
Write every customer-facing text as `tr('English', 'Français')` (views, routes) or in the
page's EN and FR dictionaries (marketing pages). `node scripts/i18n-audit.js` shows what is
left; [`../docs/i18n-audit.md`](../docs/i18n-audit.md) has the "definition of done" and the
allow-list rules, and [`../docs/testing/french-review.md`](../docs/testing/french-review.md)
is the list of screens and emails to read when you review the French.

French also has its own web addresses: every public page exists at `/<page>` (English first; it still
follows the language cookie / the browser's `Accept-Language`) and at `/fr/<page>` (always French), for
example `/books.html` and `/fr/books.html`, `/books/12` and `/fr/books/12`, `/` and `/fr/`. Each page's
`<head>` names both (`canonical`, `hreflang`) and `sitemap.xml` lists both. Admin, cart, login, accounts
and the forms exist once, unprefixed. The rules live in `src/lib/frUrls.js`; when you add a public page,
add it to `isPublicPath()` (and to the matching pattern in `assets/site.js`), and keep image/script paths in
marketing views root-relative (`/assets/...`). `test/integration/frenchUrls.test.js` crawls `/fr/` and fails on a
link that leaves it. Submitting the sitemap to Google and Bing after launch is in `../docs/runbook.md`
("Search engines: submit the sitemap").

#### Writing tests that are safe on the shared CI database

With `DATABASE_URL` set (as in CI) there is ONE Postgres database and node
runs several test files against it at the same time, so anything global — row
counts, the `session` table, `DELETE`/`TRUNCATE`,
dropping `schema_migrations` — is visible to, or wrecked by, other files.
That made the suite fail at random. The rule: **every test file that gets a
database gets its own.** Pass `{ isolated: true }` to `startTestApp({ port,
isolated: true })`, `prepareDatabase("label", { isolated: true })` (in-process
tests) or `adminHarness(label, routers, { isolated: true })`; it creates a
throwaway database on the same server and drops it afterwards (locally every
file already has its own, so it is a no-op). `test/unit/sharedDatabaseGuard.test.js`
fails if a new file forgets (a file may opt out with a `// shared-db-ok: <why>`
comment, but then it must not contain a global destructive statement). Two
more things to keep in mind:

- **Wait for the thing you are testing, never sleep for it.** Fire-and-forget
  work (a mail sent in the background, the awards check at intake) must be
  awaited with `waitFor(...)` on its visible effect, or held open with a
  promise "gate" in the stub — not a `setTimeout` and not a stopwatch
  assertion, which a loaded CI machine overruns. A test that follows a
  fire-and-forget mail with a "no mail was sent" check must first wait for
  the mail it caused, or that mail lands in the next test's count.
- **Never assert a gap between two real events, or a "winner" of a race.** Under CI load a timer fires
  late and "simultaneous" requests are not: `stamps[1] - stamps[0] >= 100` on real fetches, or "the second
  of two concurrent requests gets the last-admin notice" (it may instead arrive after the first finished and
  be refused with 403), fail one run in fifty. Check a schedule on an injected clock/`sleep` (the ISBNdb
  limiter takes `now` and `sleep`), and for a race assert what must hold whichever way it goes (exactly one
  admin left, one change made) and test the lock directly (`setAccountFlag` called twice with
  `Promise.all`), where both calls really do reach it together.
- **Wait for background work through its promise, not a guessed sleep.** Hooks that run "in the background"
  usually return their promise for tests (`createCreditAlert`): keep them and await them
  (`test/integration/aiCreditAlert.test.js` `settle()`), or `waitFor(...)` their visible effect.
- **Rewriting a stored session row races express-session's late save.** It ends a response only after
  storing the session, so read the response body to the end (`await res.arrayBuffer()`) before changing the
  row with SQL; `test/integration/adminSessionTimeouts.test.js` does this in `login()` and `get()`.
- **A 302 after a session change can arrive before the session is stored.**
  express-session answers before its store write finishes (see
  `src/lib/session.js`), so "POST `/cart/add`, then GET `/cart`" can see the
  old cart. Use `waitForCartCount(base, jar, n)` from `test/helpers/httpClient.js`
  between the two.

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
- **Email verification** — signup asks for no password: the emailed
  link confirms the address and leads to "choose your password", and only then
  can the person log in (`src/lib/emailVerification.js`); an admin
  changing a member's email re-triggers it.
- **Membership** (`/membership.html`) — needs an account, created in one step
  on that page (name + email, then pay on HelloAsso and confirm the email
  afterwards); a logged-in account holder sees only the payment form and a
  "Check my membership" button (`src/lib/membershipPage.js`). **The membership
  is the only thing paid online** (`src/lib/helloasso.js`, webhook at
  `/webhooks/helloasso`; payments are matched to accounts by email).
- **Reservations** (`/cart`) — **with an account or as a guest**: anyone can
  browse and fill the cart, then either logs in / signs up (the cart is kept and
  they return to it) or continues as a guest (name, email, optional phone; the
  hold is confirmed from an emailed link within 2 hours, and a private link views
  and cancels it). Book copies and class drop-in seats are **reserved online and
  paid in person**: "Reserve (free, no commitment)" holds the books for 14 days (an admin
  can extend once by 7 days) and a drop-in seat until the session is over; the
  customer pays at the shop when collecting, or at the session. At most 10
  books and 3 open reservations per account (or per email for guests); the customer can cancel from
  their account page (a seat until 24 hours before the session). Nothing is
  paid on the website. The numbers are in `src/lib/legal.js`. See
  ARCHITECTURE.md's "Reservations" section.
- **Inventory** (`/admin/inventory`, admin only) — full CRUD for the book
  catalog. Each title (`books`, with a genre/`categories` field) can have
  several individually-tracked physical copies (`book_copies`, each with
  its own condition, price, acquisition cost, acquisition date, and
  status: in stock / reserved / sold / donated / damaged; see "How to
  describe a book" below). Adding a book
  can start from a scan at `/admin/inventory/scan`: typing/scanning an
  ISBN looks up metadata via the free Open Library API, or a photo of the
  cover or barcode is read by Claude's vision API (`ANTHROPIC_API_KEY`,
  see below) to extract the title/author/ISBN, which is then matched
  against Open Library. Either path lands on a prefilled "confirm before
  saving" form — nothing is saved without a look. Books can also be added
  or edited by hand with no scan at all. If a book has no description, one
  is generated automatically by Claude (also re-generatable by hand from
  the book's page). The report **Reports > Book lookup sources used**
  (`/admin/reports/lookup-sources`) counts how often each catalog (Open
  Library, BnF, Google Books, ISBNdb) was used, supplied the title or failed
  (counts only, see `docs/runbook.md`, "Which catalogs are used"). The same
  report ends with **AI usage**: calls, errors, tokens and an estimated cost
  per AI feature (description, French translation, genres, cover photo,
  price check), and a red banner when the Anthropic credit has run out
  (`docs/runbook.md`, "AI usage"). When the credit runs out the site also
  emails the alert address once (at most once per 24 hours, re-armed by the next
  successful AI call), shows a red line on the Dashboard, and the report has a
  **Send a test credit alert** button (`lib/aiCreditAlert.js`).
- **Book search** (`/books`, public, no login) — anyone can search
  in-stock inventory by title, author, or genre, and add copies to the
  cart (the reservation flow above). A copy is held (status `reserved`) when
  an account holder reserves it, when an admin reserves it from the book's
  admin page, or when a book request is notified with a hold. An online
  reservation is collected, cancelled or extended from its reservation page
  (`/admin/orders/<id>`); the others stay held until an admin cancels the
  reservation or marks it sold, or they expire.
- **Admin** (`/admin`, admin accounts only) — a proper multi-page section
  with its own navigation (`views/partials/admin_header.ejs`): an overview
  with counts/links, plus dedicated pages for Books & Reservations, English
  Programs (`/admin/sessions`), Events, Volunteer Shifts, Meetings,
  Announcements, Accounts/Members, Charities, and Blog. Add a new admin area by adding a route file under `src/routes/admin/` (mounted in
  `src/routes/admin/index.js`), a view under `views/admin/`, and a link in
  `views/partials/admin_header.ejs`.

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

Until both are set, local development just logs what it would have sent to the
console. **In production the same mistake is not silent**: sending fails with a
clear error, the email outbox keeps the message and retries it, the dashboard
shows it under "Needs attention" and (after an hour) an alert is sent.

**Alert recipients.** Alerts (errors, emails that cannot be sent, failing
background jobs, launch warnings) go to `ALERT_TO` — one address or several
separated by commas (default `admin@umasbooks.org`). Add a second address on a
different mail provider than the Google account that sends them. The GitHub
workflows (backup, uptime, freshness, restore test, weekly test alert) read the
repository **variable** `ALERT_TO` (Settings > Secrets and variables > Actions >
Variables). Contact-form messages go to `CONTACT_TO` (same format).

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

### How to describe a book (for volunteers)

Every copy gets one of five **condition** grades. Pick the first one that is
true; if you hesitate between two, choose the lower one.

- **New**: unread, as published. Must be sold at the publisher's price.
- **Like New**: as new: no marks or wear, possibly read once.
- **Very Good**: looks almost new: clean pages, no writing or highlighting, at most very light wear.
- **Good**: normal wear from reading: a few creases or marks, still clean and complete.
- **Acceptable**: clearly used but complete and readable: wear, creases or
  some markings.

A book that is not fit to sell (pages missing, mouldy, falling apart) is not a
grade: set its **status** to "Damaged / withdrawn" instead.

The **binding** says what kind of book it is: **Mass Market** (the small
pocket paperback, "poche"), **Trade** (a normal paperback, in French
"broché"), **Hardback** (in French "relié") or **Other** (board book,
spiral-bound, anything else).
It is filled in automatically when the scan finds it; check it, and choose
"Not specified" if unsure.
Customers see the grade of each copy, the binding, and a "What the grades
mean" box on the book's page.

### Alphabetical order (for volunteers)

Alphabetical order ignores a leading "The": `The Hobbit` is listed under H, between
`Hamlet` and `Hunger Games`. This applies to the shop's book search, "More by this
author" and the admin inventory list. The title is still shown in full. "A", "An" and
the French "Le", "La", "Les", "L'" are not ignored.

### How to use locations (for volunteers)

Each copy can have a location, such as `Store` or `Fiction A1`, meaning the shelf or box
it sits on.

- **Adding books:** on **Books & Reservations > Scan a book** (the **Add Book** page),
  scan or type the ISBN: the book is looked up at once and the form filled in
  (see "Fast scanning" below). **Location** starts at `Store` and keeps the last
  one you used (pick one from the list, or type a new one; it is added to the
  list as soon as a book is saved with it). Change it whenever you move to
  another shelf.
- **Moving books:** click **Move books**. Choose (or type) where the books are
  going, then scan each book's barcode. Each scan moves one copy of that book
  and the page lists what happened. If you have two copies of a book, scan it
  twice. Sold, donated and in-cart copies are left alone.
- **Finding books:** the inventory list shows each book's locations, and the
  **Location** box filters the list to one place. **Received from** and
  **Received to** find copies by their Acquisition Date (both days included;
  either may be left empty), and **No date received set** finds copies without
  one. Like location, condition and price, one copy has to match them all.
- **Changing one copy:** open the book and edit **Location** on the copy.
- Location names keep the capital letters you type (`Store`, `Fiction A1`); only
  extra spaces are tidied. Capitals do not make a different place: `store`,
  `Store` and `STORE` are one entry in the list, shown in the spelling used most.
  To change how a place is written (for example the old `STORE` to `Store`), use
  **Move books** with the new spelling as the destination and scan the books:
  a change of capitals alone counts as a move.

### Customer book requests (volunteer how-to)

Anyone can ask us to look out for a book at `/request-a-book` ("Can't find a
book? Ask us", linked from the Books page). No account or membership is
needed. They get an email with a link and must press **Confirm** (until then
the request is "unconfirmed" and is deleted after 7 days).

1. **Adding books is the only thing you do first.** When you save a new book
   in **Books & Reservations**, any confirmed request for that title or ISBN turns to
   **Matched**, and the book's page shows "N customers asked for this book".
2. Open **Book Requests** in the admin menu (default view: Open, Matched and
   Notified). Each card shows the person's name and email, the title, and the
   copy that matched.
3. Click **Notify** to email them that the copy is here (in their language),
   or **Notify and hold 7 days** to also put the copy aside for them: it shows
   as Reserved for 7 days and goes back on the shelf by itself. If the copy has
   been sold in the meantime, nothing is sent and you are told so.
4. When they have collected it, click **Mark fulfilled**. **Cancel** drops a
   request and removes the person's details; **Add a note** is for staff only.
5. Nothing matched by itself (different spelling, a book already in stock)?
   Type the book's id or ISBN next to **Match to a book**.

Customers can cancel with the private link in every email, or under **My
Account**, or by asking for a new link at `/my-requests`. Contact details are
deleted when a request is cancelled, after 30 days once it is closed, and at
the latest 12 months after it was made (the privacy policy says so).

### Reports and selling in the shop (for volunteers)

**Selling a book in the shop**

1. Click **Books & Reservations**, then **Sell in shop**.
2. Scan the book's barcode (or type the ISBN) and press Enter.
3. Check the price (it is filled in for you, and you can change it), choose how
   it was paid, and press **Record sale** (or Enter again). The book is now
   marked as sold, and the box for the next ISBN is ready.
4. If there are several copies of the same book, pick the one in your hand. The
   oldest copy is already selected.
5. A new book must be sold at the publisher's price, with at most 5% off: the
   page tells you if the price is outside that.
6. The list at the bottom shows the last 10 sales. If you made a mistake, ask
   the person who looks after the site to fix it.

A book reserved on the website is **not** sold here: it is collected from its
reservation page. Admin > **Books & Reservations** > **Reservations** opens on the reservations
waiting for pickup. When the customer comes, open the reservation, take the
payment (cash, card or cheque), choose how they paid and press **Mark collected
and paid** (**Collect selected items** if they take only some of the books).
The **Pickup list** (and its print version) lists everything to fetch from the
shelves. Step by step: `docs/runbook.md`, section k.

**Where a book came from**

When you add books, choose **Source** (donation, purchase, job lot, other).
On the Add Book page it starts at **Donation** the first time and after that is
the source of the last book you added (the browser remembers it). You can change
it later on the book's page, on each copy.

**Fast scanning (Add Book page)**

`/admin/inventory/new` is made for adding many books in a row, on a phone or a
computer: the cursor is in the **ISBN** box; a scanner (a keyboard that types
the digits then presses Enter) or typing a complete 10 or 13 digit ISBN (hyphens
ignored; it also looks up by itself 150 ms after the last digit) fills the form
in place from `GET /admin/inventory/lookup?isbn=` (admin only, 120 a minute).
**Save and add another** (or Ctrl/Cmd+Enter) saves without leaving the page and
puts the cursor back in the empty ISBN box; **Save book** saves and opens the
book. Location, Source, Binding and Condition are always the **last values
used**: they are carried to the next form after a save and remembered by the
browser (`localStorage`, per browser: it needs no database change and works the
same on the phone and the laptop, but each device has its own memory). The very
first time they are Store, Donation, the last binding in the list (Other) and
Very Good. A binding found by Open Library is only shown as a hint.
Without JavaScript the **Look up** button and a normal form post still work (the
page then comes back with a "Saved" line). `/admin/inventory/scan` is kept for
photo scanning. Setup of the scanner and phone tips: `docs/runbook.md`, section aa.

**Reports**

Click **Reports** in the menu. Pick a report, set the dates if it has date
boxes (without dates it shows the last 12 months), and press **Show**. Press
**Download CSV** under a table to open it in Excel or a similar program. The
reports never show customers' names or email addresses. Every download is
noted in **Admin activity**.

- **Inventory on hand:** books in the shop and their value, by genre,
  condition, place and source.
- **Aging stock:** how long books have been on the shelves, and a list of the
  oldest.
- **Sales over time:** reserved-online (paid in the shop) and walk-in shop sales by day, week, month or year.
  Drop-in class seats are shown separately.
- **Sell-through by genre:** of the books added in a period, how many sold and
  how fast.
- **Membership:** members now, new members and endings per month, and renewals
  due in the next 30 days.
- **Intake log:** books added per month and by source, with what they cost.
### How prices are suggested (for volunteers)

When you add a book, the shop suggests a price. It is only a suggestion: you
can always pick another price, and nothing is published until you save.

- **What you see:** next to the price, a line such as *Suggested EUR 10.00
  (range 5.00-10.00, medium confidence)* and the matching choice marked
  *Suggested*. Click **Why this price?** to read the reasons and, when the
  online check found them, links to the listings it used.
- **How it works:** the price depends on what the book is worth online (what
  used copies typically sell for), its binding, and how many copies we already
  have. **The condition of your copy does not change the price.**
  - A **new** book is always sold at the publisher's price (French law).
  - **Mass market** and **Trade** paperbacks are a flat EUR 5, whatever they
    are worth online and whatever their condition.
  - Other books (hardback and **Other**): worth under EUR 6 online = EUR 5; EUR 6 to 19.99 = EUR 10;
    EUR 20 to 49.99 = about three quarters of the online value. **Hardbacks
    are never under EUR 10.** The standard prices are EUR 3, 5 and 10 (EUR 8 was
    retired; a book that would have been EUR 8 is now EUR 10, or EUR 5 for trade).
  - If we already have **2 or more copies** of the same book (in stock or
    reserved), the next one goes to the **clearance** bin at EUR 1 (this
    applies to the cheaper books; see the rules page).
  - **No ISBN, or a book worth EUR 50 or more:** no price is suggested. Look
    at the listings and choose the price yourself; the book then shows up on
    the **Price check** page under *Needs review* until it has a price.
- **If the number looks wrong:** just choose another price. Set the *Binding*
  first if you can (it changes the suggestion), then press **Suggest price**.
  On a copy that is already saved, **Suggest price** shows the suggestion
  without changing anything; **Use this price** puts it in the form (or saves
  it, if your browser has JavaScript switched off). If the rules themselves
  seem off, tell the person who looks after the shop's settings.
- **Changing the rules:** **Pricing rules** in the admin menu shows every rule
  in plain language with its numbers, which you can change, and a calculator
  to try values. Changes apply straight away to new suggestions (not to prices
  already saved) and are written to the admin activity log.
- **Price check** (on the same page): lists copies in stock whose price differs
  from what the rules suggest, with a **Use suggested** button for each; lists
  the books waiting for review; and previews **clearance candidates** (books
  with more than 2 copies whose extra copies are not on clearance yet) with a
  button to apply clearance after you have looked at the list.
- **Reprice** (reached from the Pricing rules page): a one-off tool for the
  change to flat EUR 5 Trade and Mass Market prices and the end of EUR 8. It
  previews three groups of copies already in stock (A: Trade not at EUR 5,
  B: Mass Market not at EUR 5, C: any other binding at exactly EUR 8, which
  moves to EUR 10), each with its own confirm button. Clearance, new, reserved,
  sold and in-cart copies are never touched. Each confirmed group is one
  transaction, is logged in Admin activity, and can be downloaded as a CSV
  (price before and after) so it can be reversed by hand.
- **Privacy:** when the online check is switched on, only the book's ISBN,
  title, author and binding are sent to the AI service (Anthropic), to find
  prices for that exact edition. No names, emails or anything about members or
  customers is ever sent.

## Deploying to Render

`render.yaml` at the repo root is a Render Blueprint that provisions:
- a paid-plan Postgres database (`umas-books-db`)
- this app as a web service (`umas-books`) with a generated `SESSION_SECRET`
  (`DATABASE_URL` is entered by hand, see the table below)

To deploy: in the Render dashboard, **New +** → **Blueprint**, connect the
`umasbookswebsite` GitHub repo, and Render will read `render.yaml` and set
both up.

Render's *Pre-Deploy Command* (`preDeployCommand: npm run migrate` in
`render.yaml`) runs before each new version takes traffic, so migrations run
automatically on every deploy — new migration files just need to be committed
and pushed, no manual step — and a failing migration stops the deploy while
the old version keeps serving. `src/migrate.js` records each file in the
`schema_migrations` table and applies it exactly once.
Redeploying an older commit does **not** undo a migration; see
[`docs/runbook.md`](../docs/runbook.md) before rolling back.

### Environment variables

This is the short deploy-time list. The complete inventory (every variable, default, secret or not, and where it is set) is in [ARCHITECTURE.md](ARCHITECTURE.md#environment-variables) and wins if the two differ.

Set in Render under the service's **Environment** tab. `render.yaml` lists every
one, so a Blueprint rebuild starts correctly; values marked "by hand" are
`sync: false` secrets you enter once.

| Variable | What it is | In `render.yaml` |
|---|---|---|
| `DATABASE_URL` | the database connection | `sync: false`: set by hand in the dashboard to the database's Internal Database URL; update it when the DB password is rotated ([runbook](../docs/runbook.md), "Rotating the database password") |
| `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY` | session signing; encrypts admins' two-step secrets | generated |
| `NODE_ENV` | `production` | `production` |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | first admin (delete the password after first login) | by hand |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | the mailbox that sends every email and alert | by hand |
| `APP_BASE_URL` | public address, no trailing slash (emailed links, payment return, canonical redirect) | `https://umasbooks.org` |
| `CONTACT_TO` | contact-form and forum-report recipient(s) | `admin@umasbooks.org` |
| `ALERT_TO` | alert recipient(s), comma separated, no spaces | `admin@umasbooks.org,sharonbje@gmail.com` |
| `ADMIN_SESSION_IDLE_HOURS`, `ADMIN_SESSION_MAX_DAYS` | optional: admin and Till accounts are signed out after this many idle hours (0.25 to 72) / days since login (1 to 30); everyone else keeps 30 days (runbook section ab) | `8` / `7` (defaults, not in the file) |
| `ANON_SESSION_LIMIT` | leave unset: stored guest sessions one IP may create per 10 minutes (default 60; only the local end-to-end run raises it) | `60` (default, not in the file) |
| `TRUST_PROXY_HOPS` | proxies in front of the app (visitor IP) | `2` |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG` | online payment | by hand |
| `HELLOASSO_API_BASE` | leave empty/unset for production (the sandbox address is only for tests) | by hand |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` | optional: only this HelloAsso form grants membership | by hand |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | photo scanning and book descriptions | by hand |
| `AI_DAILY_MAX_CALLS` | optional: the most Anthropic calls per Paris day for ALL AI features together (default `600`; `0` = AI off). Raise it in Render > Environment (runbook section ae, "AI limits"; the AI price-check cap `PRICING_AI_DAILY_MAX` is a part of it) | by hand |
| `NYT_API_KEY` | optional: New York Times Books API key for the awards / best-seller badges (runbook section i) | by hand |
| `PRICING_AI`, `PRICING_AI_DAILY_MAX`, `PRICING_AI_MODEL` | optional online price check (see docs/runbook.md) | by hand |
| `ISBNDB_API_KEY`, `ISBNDB_API_BASE`, `ISBNDB_MIN_INTERVAL_MS`, `ISBNDB_PRICE_TTL_MS`, `ISBNDB_PRICE_TIMEOUT_MS`, `ISBNDB_DAILY_MAX_CALLS` | optional paid book catalog (ISBNdb): a last resort for title/author when the free catalogs find nothing, and the suggested publisher's price (prix éditeur) for New books on Add Book (never auto-filled; rates on Admin > Pricing); key = secret, add by hand in Render (runbook section aa, "ISBNdb"); `ISBNDB_DAILY_MAX_CALLS` (default 500, `0` = none) caps paid calls per Paris day (a Render environment variable) | by hand |
| `GOOGLE_BOOKS_API_KEY` | optional: removes Google's cap on keyless Google Books lookups | by hand |
| `SCAN_LOOKUP_TIMEOUT_MS`, `SCAN_LOOKUP_HEDGE_MS`, `SCAN_LOOKUP_GRACE_MS`, `SCAN_LOOKUP_SOURCES`, `SCAN_CACHE_TTL_MS`, `SCAN_NEGATIVE_TTL_MS`, `SCAN_COVER_WAIT_MS`, `SCAN_PRICE_WAIT_MS`, `SCAN_SLOW_LOG_MS` | optional speed settings of the Add a book page (runbook section aa, "Scan speed") | defaults, not in the file |
| `COVER_BACKFILL` | `off` stops the background cover copy (tests); otherwise on | `on` |
| `PREVIEW_MODE` | `true` = coming-soon mode. **Deliberately not in `render.yaml`**: set and removed by hand in the dashboard | not in the file |

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
runs on every boot (it does nothing once an admin exists, and it can never
block the site from starting): set `SEED_ADMIN_PASSWORD` (and optionally `SEED_ADMIN_EMAIL`)
in the service's **Environment** tab before the first deploy, then delete
`SEED_ADMIN_PASSWORD` from that tab once you can log in. Never demote the last
admin; see the runbook (section c) for adding or restoring one. Or, to do it
by hand, point `DATABASE_URL` at the production database locally:

```bash
SEED_ADMIN_PASSWORD='a-real-password' npm run seed
```

In production (`NODE_ENV=production`) the app checks its environment at
boot: it refuses to start, naming every missing variable, if `DATABASE_URL`
`SESSION_SECRET` or `TOTP_ENCRYPTION_KEY` is unset, and logs a loud `[env] WARNING` at startup
if the Gmail or HelloAsso variables are unset (email, including error
alerts, or online membership payment would then be silently off). On `SIGTERM` (every
Render deploy/spin-down) it stops taking new connections, lets in-flight
requests — notably HelloAsso membership webhooks — finish, closes the database pool and
exits 0; after 10 seconds it exits anyway.

## Nightly inventory export

Every evening at 21:00 (Paris) the *Nightly inventory export* workflow
(`.github/workflows/inventory-export.yml`, script `scripts/export-inventory-csv.js`,
columns and format in `src/lib/inventoryExport.js`) emails a CSV of all inventory (one
row per copy, plus one row per book) to the alert addresses and stores it in the Backblaze
bucket under `inventory-exports/`. No customer data in it. The same file is
available any time from Admin > Inventory > **Download all inventory (CSV)**. Set-up and how
to open it in Excel: `docs/runbook.md`, section af.

## Backups in Backblaze B2

The nightly workflow uploads one complete dump (image bytes included, login
sessions left out) to a private **Backblaze B2** bucket
(`<bucket>/store-backups/full/umas_books_full_<UTC timestamp>.dump.age`, encrypted client-side with `age`; plain `.dump` while `BACKUP_AGE_RECIPIENT` is unset; plus a
copy under `store-backups/monthly/` on the 1st of each month). Nothing is
committed to the code repository. B2 speaks the S3 protocol, so the workflow
uses the standard AWS CLI pointed at B2's endpoint. The upload is required:
if any setting below is missing, or the upload fails, the job fails and sends
the usual failure email.

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
| Variables | **Repository variables** | `BACKUP_AGE_RECIPIENT` | the age **public** key (`age1...`) that encrypts every dump before upload; unset = dumps uploaded unencrypted, with a loud warning. Runbook section ad) |
| Secrets | **Repository secrets** | `BACKUP_AGE_IDENTITY` | optional, **not recommended**: the age private key, lets the monthly restore test decrypt and restore (runbook section ad) |

(Not *environment* variables/secrets: the workflows don't name a GitHub
environment, so those would be invisible to them and the upload would
fail the backup.)

**Retention:** the workflow doesn't delete anything. In Backblaze, open the
bucket → *Lifecycle Settings* → *Use custom lifecycle rules*. Only two
folders are used now:

| File path | Days to hiding | Days to deleting |
|---|---|---|
| `store-backups/full/` (nightly) | **30** | **1** |
| `store-backups/monthly/` (long term) | **730** | **1** |

Older rules for `store-backups/umas_books_` (the old plain nightly copy) are
no longer needed and can be removed once their files have expired.

**Check it works:** run the *Nightly database backup* workflow by hand
(Actions tab → Run workflow, branch `main`) and look for the new file under
`store-backups/full/` in the bucket, then run *Monthly backup restore test*
by hand — it downloads the newest dump from B2 and restores it.

## Restoring from a backup

`.github/workflows/nightly-db-backup.yml` dumps the production database
every night (03:00 UTC) with `pg_dump --format=custom`, **encrypts it with
`age`** (when the repository variable `BACKUP_AGE_RECIPIENT` is set: runbook
section ad), and uploads it to the
private Backblaze B2 bucket as `store-backups/full/umas_books_full_<UTC
timestamp>.dump.age` (`.dump` while unencrypted; kept 30 days; the 1st-of-month copy under
`store-backups/monthly/` is kept 2 years). Once a month,
`.github/workflows/backup-restore-test.yml` downloads the newest dump,
restores it into a scratch Postgres and checks the data (including that it is as
new as the newest migration in the repository), emailing the alert
address(es) (`ALERT_TO`) if that fails. For an **encrypted** dump it only checks
the file's integrity (header, size) unless the optional secret
`BACKUP_AGE_IDENTITY` is set, so the real decrypt-and-restore is the quarterly
drill in runbook section ad).

> **Each dump is complete** — book covers and other uploaded photos
> included. Only login sessions are left out (everyone simply logs in again
> after a restore).

> **A dump contains member data** (names, emails, reservation details, password
> hashes). Download it only to a machine you control, restore it only into
> a database you control, never commit or share it, and delete the local
> copy when you are done.

You need the PostgreSQL **18** client tools (the dumps are made with 18;
an older `pg_restore` cannot read them), the AWS CLI and, for a `.age` file,
`age` (`brew install age`) and the **private key** from the password manager.

1. **Download a dump** from Backblaze B2. Fill in the three values (the
   bucket name, the endpoint, and the B2 key pair from the Backblaze
   *App Keys* page):

   ```bash
   export AWS_ACCESS_KEY_ID=<B2 keyID>
   export AWS_SECRET_ACCESS_KEY=<B2 applicationKey>
   export AWS_DEFAULT_REGION=eu-central-003                  # your region
   export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
   export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
   EP=https://s3.eu-central-003.backblazeb2.com              # your endpoint
   BUCKET=<bucket name>

   aws s3 ls s3://$BUCKET/store-backups/full/ --endpoint-url $EP | tail
   aws s3 cp s3://$BUCKET/store-backups/full/umas_books_full_<timestamp>.dump restore.dump --endpoint-url $EP
   ```

   Pick the newest file from the list (names sort by date), or one from
   `store-backups/monthly/` for an older copy.

   If the file ends in **`.age`** it is encrypted: decrypt it first (the key
   file must be readable only by you, and deleted afterwards):

   ```bash
   umask 077
   pbpaste > key.txt     # the private key, copied from the password manager
   age -d -i key.txt -o restore.dump umas_books_full_<timestamp>.dump.age
   rm -P key.txt
   ```

   Then continue with `restore.dump`. (An unencrypted `.dump` can be
   downloaded straight to `restore.dump`.) `bash scripts/backup-encrypt-selftest.sh`
   rehearses the encrypt-decrypt round trip with a dummy file and a throwaway key.

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
   save — Render redeploys. `render.yaml` does not manage `DATABASE_URL`
   (`sync: false`), so a Blueprint sync will not change what you set here. Migrations do
   **not** run when the app boots: they run in Render's **pre-deploy command**
   (`npm run migrate`, see `render.yaml`) the next time the service deploys, and
   that applies any migrations newer than the dump. After pointing
   `DATABASE_URL` at the restored database, trigger a deploy (**Manual Deploy >
   Deploy latest commit**) and check the deploy log shows
   "Running migration: ..." for each newer file (or "Migrations complete."),
   then that `/healthz` returns 200.

5. **Clean up:** `rm restore.dump umas_books_full_*.age`, and `dropdb umas_books_restored` if it
   was only a drill.

**If the whole Render account is gone** (not just the data), restoring the
database is only one step of several: see "Rebuild everything if the Render
account is lost" in [`docs/runbook.md`](../docs/runbook.md).

The database is on a paid Render plan (`render.yaml`), so it does not
expire. These backups are the extra safety net on top of Render's own.

More operational how-tos (rolling back a deploy, rotating secrets, a
locked-out admin, who gets alerts, the yearly checklist) are in
[`docs/runbook.md`](../docs/runbook.md).

## Security

- Passwords hashed with bcrypt (cost 12); reset tokens are 256-bit random,
  only a SHA-256 hash is ever stored, single-use, 1-hour expiry.
- Session cookies are `httpOnly`, `secure` in production, `SameSite=Lax`.
- CSP `form-action` is `'self'` only: nothing is paid online for books and seats, so no form of ours posts to another site and no redirect to another site follows a form POST. The HelloAsso membership form is an iframe the visitor loads by pressing a button, allowed by `frame-src` on the marketing pages (`src/lib/marketingCsp.js`).
- **CSRF protection** — every form carries a per-session token
  (`src/middleware/csrf.js`); any POST without a matching token is
  rejected with 403. New forms must include
  `<%- include('partials/csrf_field') %>` right after `<form ...>`.
- **CSP** (`src/app.js`'s `helmet` config) — `script-src 'self'` with no
  `unsafe-inline`/`unsafe-eval`; `style-src` allows inline styles (used
  throughout the views) and Google Fonts' stylesheet host.
- **Login hardening** — a login attempt against a nonexistent email still
  runs a same-cost bcrypt compare (against a fixed dummy hash) so response
  timing can't be used to enumerate registered emails; 5 wrong passwords from
  one address lock THAT address out of that account for 15 minutes (a stranger
  cannot lock the owner out), and 20 across all addresses in 15 minutes refuse
  new addresses for the rest of the window (`src/lib/loginThrottle.js`).
- **Marketing pages CSP** — `script-src 'self'` and `script-src-attr 'none'`
  there too (they share an origin with `/admin`); no inline scripts: page
  strings are a JSON data block read by `public/page-i18n.js`.
- **Live host** — any request for another Host than `APP_BASE_URL`'s (the
  `onrender.com` address) is redirected (page views) or answered 421
  (anything else), except `/healthz` and `/webhooks/helloasso`.
- **Mail abuse** — signup, reset and book-request mails are throttled per
  recipient (1 per 10 minutes per kind, 5 a day, a shop-wide hourly cap); links
  in failed or lapsed mails are blanked (`src/lib/outbox.js`).
- **Data requests** — admin > Privacy requests (`/admin/privacy`) looks up,
  downloads or erases everything under an email address, with or without an
  account (runbook, "A data request").
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
- Forum moderation is limited to hiding and restoring a thread or reply
  (`src/routes/admin/forum.js`, with a statement of reasons emailed to the
  author); there is no editing of a post's text and no queue of reported posts
  beyond the reports emailed to `CONTACT_TO`.
- No general JSON API — this is a server-rendered app. The few `/api/...`
  routes (book search, new in, cart count, favorites) exist for
  the site's own pages.
