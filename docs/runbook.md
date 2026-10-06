# Runbook

Short, step-by-step instructions for the things that go wrong or need doing
now and then. Where something lives is always named exactly:

- **Render environment variable** = Render dashboard > the `umas-books`
  service > **Environment**.
- **GitHub repository secret** = GitHub > the repo > **Settings > Secrets and
  variables > Actions > Secrets** tab > *Repository secrets*.
- **GitHub repository variable** = same page, **Variables** tab > *Repository
  variables*.

Do not use "Environment secrets" in GitHub: the workflows do not use a GitHub
environment, so they would not see them.

Never paste a password or key into chat, an issue, a pull request or a file in
the repo.

## a) Rolling back a deploy

**Important:** on every deploy Render first runs `npm run migrate` (the
*Pre-Deploy Command*; if it fails the deploy stops and the old version keeps
running), then starts the site with `npm run seed; npm start`
(`render.yaml`; the seed can never block the start). Migrations (database changes) are applied once and recorded. Redeploying an old commit
does **not** undo them. The old code then runs against the newer database,
which usually works if the migration only added things, but can break if it
renamed or removed something.

**Preferred: fix forward.**

1. Open a pull request that reverts the bad change (on the PR page of the bad
   change, click **Revert**) or fixes it.
2. Wait for the CI checks to pass, merge. Render deploys it.

**Quick stop-gap: redeploy the previous version** (use when the site is broken
now and a fix will take a while):

1. Render dashboard > `umas-books` service > **Deploys**.
2. Find the last deploy that was working (green, "Live").
3. Click the **...** menu on it > **Rollback** (or **Redeploy**).
4. Check https://umas-books-cmvv.onrender.com/healthz shows OK.
5. Then do the fix-forward steps above, because the next push to `main` will
   deploy the broken code again.

If the broken change included a database migration, ask a developer before
rolling back: do not roll back blindly.

**Restoring the database from a backup** is a last resort (data loss, bad data
change). Follow "Restoring from a backup" in
[`umas-books/README.md`](../umas-books/README.md#restoring-from-a-backup).
Anything members did since that backup is lost.

## b) Rotating secrets

Rotate when a secret may have leaked, someone with access leaves, or a service
asks you to. Always change **every** place listed, then check
`/healthz` and send a test (contact form / password reset).

| Secret | Where it lives |
|---|---|
| `DATABASE_URL` | Render env var (set automatically from the database) **and** GitHub repository secret `DATABASE_URL` (nightly backup) |
| `SESSION_SECRET` | Render env var only |
| `TOTP_ENCRYPTION_KEY` | Render env var only |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Render env var **and** GitHub repository secrets (uptime alerts, backup emails) |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG`, `HELLOASSO_API_BASE` | Render env var only |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` (optional, not a secret: the last part of your membership form's HelloAsso address) | Render env var only. When set, only payments on that form make someone a member; leave it unset to accept any membership form |
| `PREVIEW_MODE` (not a secret; see section g) | Render env var only |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` (and optional `BACKUP_S3_PREFIX`) | GitHub **repository variables** |
| `BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY` | GitHub **repository secrets** |

**DATABASE_URL (the Render database password).**
Render links the web service to the database automatically
(`fromDatabase` in `render.yaml`), but GitHub keeps its own copy.
If you change one and not the other, the site keeps working but the nightly
backup fails (or the reverse).

1. Render dashboard > the database `umas-books-db`. Render has no one-click
   password change in the dashboard for every plan, so if you truly need a new
   password, ask Render support or a developer. If the password is unchanged
   and you only need to refresh GitHub's copy, copy the **External Database
   URL** from this page.
2. Update the GitHub repository secret `DATABASE_URL` with the new
   **External** URL (Settings > Secrets and variables > Actions > Secrets >
   `DATABASE_URL` > pencil icon).
3. In Render, check the `umas-books` service redeployed and the Environment tab
   shows `DATABASE_URL` linked to the database.
4. GitHub > Actions > **Nightly database backup** > Run workflow, and confirm it
   goes green.

**SESSION_SECRET.** Render env var only. Changing it logs everyone out (they
just log in again); nothing else breaks.

1. Render > `umas-books` > Environment > `SESSION_SECRET` > edit > put a long
   random value (or delete it and re-sync the Blueprint to get a generated
   one) > **Save**. Render redeploys.

**TOTP_ENCRYPTION_KEY: do NOT rotate.** (Applies once the two-step
verification change is live.) It encrypts every admin's authenticator-app
secret in the database. If it changes, those secrets can no longer be read:
**every admin has to re-enrol two-step verification from scratch**, and if all
admins are affected you will need the locked-out steps in section c. Set it
once and leave it. If it really leaked, have another admin ready and rotate
deliberately.

**Keep a copy of TOTP_ENCRYPTION_KEY in the password manager.** A restored
backup contains every admin's two-step secret encrypted with this key. If the
service is ever recreated and Render generates a new key, all of that data is
unreadable and every admin loses two-step verification until reset. Copy the
value now (Render > `umas-books` > Environment > show the value) into the
password manager (never a file in the repo or a chat). After a restore into a
new service, set `TOTP_ENCRYPTION_KEY` to the saved value *before* the first
start. If the key is truly lost, recovery is to clear two-step for each admin
in the database (the `UPDATE users SET totp_secret_enc=NULL, ...` statement in
section c) and have each admin enrol again. In production the site refuses to
start without `TOTP_ENCRYPTION_KEY` (it no longer silently falls back to
`SESSION_SECRET` there).

**GMAIL_USER / GMAIL_APP_PASSWORD.** Two copies, and both must match. If only
one is changed, either the site's emails (password reset, contact form, error
alerts) stop, or the uptime and backup alert emails stop.

1. Google account of `GMAIL_USER` > Security > 2-Step Verification > **App
   passwords** > create a new one for "Uma's Books", copy it, delete the old
   one.
2. Render env var: `GMAIL_APP_PASSWORD` > Environment > edit > **Save**.
3. GitHub repository secret: `GMAIL_APP_PASSWORD` > Settings > Secrets and
   variables > Actions > Secrets > pencil icon > paste > Update.
4. Test: use "Forgot password" on the site for your own account, and run
   GitHub > Actions > **Uptime check** > Run workflow.

**HELLOASSO_\*.** Render env vars only. HelloAsso is used for the
**membership only** (books and drop-in seats are reserved on the site and paid
in the shop). If wrong, online membership payment and "Check my membership"
stop (the site logs an `[env] WARNING` at boot).

1. In HelloAsso, create a new API client (or regenerate the secret).
2. Render > `umas-books` > Environment > update `HELLOASSO_CLIENT_ID` and
   `HELLOASSO_CLIENT_SECRET` > **Save**.
3. Open the membership page and check the HelloAsso form still loads (press
   "Show the HelloAsso form"). A real test needs a real membership payment.

**BACKUP_S3_\* (Backblaze B2).** Two kinds, in GitHub: the key pair are
**repository secrets**, the bucket/endpoint/region are **repository
variables**. If one is changed alone, the backup fails and the workflow sends a failure email. Setup details: "Backups in Backblaze
B2" in [`umas-books/README.md`](../umas-books/README.md).

1. Backblaze > App Keys > add a new key limited to the one bucket (Read and
   Write), copy keyID and applicationKey.
2. GitHub repository secrets `BACKUP_S3_KEY_ID` and
   `BACKUP_S3_APPLICATION_KEY`: update both.
3. Run GitHub > Actions > **Nightly database backup** > Run workflow and check
   the new file appears in the bucket. Then delete the old key in Backblaze.

## c) An admin is locked out

Try in this order:

1. **Forgot password.** On the login page click the forgot-password link. The
   email goes to the account's address.
2. **Two-step verification code lost** (applies once two-step verification is
   live): another admin opens the site > Admin > **Members** > finds the person
   > **Reset Two-Step**. The person logs in with their password and enrols again.
3. **The only admin is locked out.** In Render, open the `umas-books` service >
   **Shell** tab, run `psql "$DATABASE_URL"`, then (changing the email):

   ```sql
   UPDATE users SET totp_secret_enc=NULL, totp_enabled_at=NULL, totp_last_step=NULL WHERE email='the-admin@example.org';
   ```

   Type `\q` to leave. Log in with the password and enrol again. (If the
   password is also lost, do step 1 first.) These columns exist only once the
   two-step change is deployed.

   Five wrong passwords lock an account for 15 minutes: just wait.

**A new member says "I can't log in after signing up" or "my confirmation link
doesn't work".** Signup asks for no password: the person gets an email with a
link that confirms their address and lets them choose their password, and only
then can they log in. If the link is lost or expired, the login page has "Just
signed up? Send me the confirmation link again", and **Forgot your password?**
does the same job (its link also confirms the address and sets a password).

**How the first admin is created.** At every start `npm run seed` runs
(`src/seed.js`). If **no admin exists yet** and no account with that email
exists, it creates one from the Render env vars `SEED_ADMIN_EMAIL` (default
`admin@umasbooks.org`) and `SEED_ADMIN_PASSWORD` (must be a strong password),
and in that same run adds a sample announcement and charity round (a database
that already has an admin never gets sample content again, so a closed round
or a deleted announcement stays gone). If any admin exists it does nothing, so
it cannot reset a password. It also never promotes or re-enables an existing
account. After the first boot, **delete `SEED_ADMIN_PASSWORD` from Render's
environment** (Render > `umas-books` > Environment > trash icon > Save) so the
password does not sit there forever. Deleting it is safe: with no password and
no admin the seed just logs a warning and the site starts normally.

**The seed never stops the site from starting.** If it fails for any reason it
logs `[seed] FAILED` or `[seed] WARNING` in the Render logs, emails an alert
(when mail is configured) and the site starts anyway.

**Never demote the last admin.** The site stops an admin from demoting
themselves, but a direct change in the database (or demoting the other admin
first) can still leave no admin at all, and then nobody can reach `/admin` or
fix it from the site. Before demoting anyone, check that another admin exists. Safe ways to add an admin:

- *Another person already has an account:* an existing admin opens Admin >
  **Members** > the person > make admin. Nothing else is needed.
- *No admin is left* (everyone was demoted): Render > `umas-books` > **Shell**,
  run `psql "$DATABASE_URL"`, then (changing the email to the right person's):

  ```sql
  UPDATE users SET is_admin = TRUE WHERE email = 'the-person@example.org';
  ```

  Type `\q` to leave. That person should then log in and enrol two-step
  verification. The seed will not do this for you on purpose: it never
  promotes an existing account, so a leaked env var cannot turn into an admin.
- *A brand-new database with no users at all:* set `SEED_ADMIN_EMAIL` and
  `SEED_ADMIN_PASSWORD` in Render and redeploy, then delete the password again.

## d) Where alerts go

Everything goes to **one mailbox: admin@umasbooks.org**. If that mailbox is
missed, nobody hears about an outage.

**Test the alert emails any time** (for example after Dependabot updates the
mail action): GitHub > **Actions** > **Send a test alert** > **Run workflow**.
An email titled "[umas-books] TEST alert" should arrive within a minute. If it
doesn't, the Gmail secrets (`GMAIL_USER`, `GMAIL_APP_PASSWORD`, both
*repository secrets*) or the mail action need attention.

- **Site down** (and "recovered"): `.github/workflows/uptime-check.yml`, `to:`
  is written in the workflow file.
- **Nightly backup failed / monthly restore test failed**:
  `.github/workflows/nightly-db-backup.yml` and `backup-restore-test.yml`,
  `to:` written in the file.
- **No fresh backup in Backblaze** (daily 09:00 UTC; catches the nightly
  backup not running at all): `.github/workflows/backup-freshness.yml`.
  Fails if the newest dump is missing, empty or older than 36 hours.
- **Errors in the running site** (`src/lib/errorAlert.js`) and the **contact
  form** (`src/routes/contact.js`): sent to the Render env var `CONTACT_TO`,
  or `admin@umasbooks.org` if it is not set.
- **Reservations about to lapse** ("N reservations expiring within 2 days",
  once per reservation): also sent to the same address; see section k.
- All of these are *sent from* the Gmail account in `GMAIL_USER`.

To add a second person: for the workflows, edit the `to:` line in those
files (the action accepts several addresses separated by commas) in a pull
request. For site errors and the contact form, set `CONTACT_TO` in Render
(it is one value shared by both; it may also accept a comma-separated list, but
check by sending a test). Simplest option: make admin@umasbooks.org forward to
two people at the mail provider.

## e) Yearly calendar

- **Domain renewal:** umasbooks.org (the maintainer's notes say it expires
  2027-08-22). Check the registrar and its auto-renew setting and payment
  card a month before.
- **Node 22 end of life: April 2027.** Move to the next LTS before then. The
  version is set in three places and all must change together:
  `umas-books/.node-version`, `engines` in `umas-books/package.json`, and
  `NODE_VERSION` in `.github/workflows/ci.yml` (also check the other
  workflows for a Node version). Do it in one pull request and let CI test it.
- **GitHub Actions minutes:** the repo is private, so minutes are metered and
  when they run out the backups stop. GitHub > your account/organisation >
  **Settings > Billing and plans** > set a spending limit / budget alert, and
  check usage once a quarter.
- **Contact, volunteer and pre-registration emails:** delete the emails sent
  by the website's contact form, volunteer sign-up and English Immersion
  pre-registration (subjects start with `Website contact:`, `Website volunteer
  sign-up` and `Website pre-registration:`) that are older than 12 months from
  the admin@umasbooks.org mailbox (Gmail search:
  `subject:(Website) older_than:12m`, review, then delete; also empty the Trash).
  Keep any conversation that is still ongoing. The pre-registration emails hold
  a child's name and date of birth, so do not skip them. This is what the
  privacy policy promises, and nothing does it automatically.
- Also once a year: confirm the backup restore test emails are arriving, review
  Dependabot pull requests that have been waiting, and check the Backblaze
  and Render invoices.

## f) Render database network access: a decision

Please check this once. Render dashboard > the database `umas-books-db` >
**Networking** (or **Access Control**) > **Inbound IP Rules**.

- If the rule list contains **`0.0.0.0/0`**, the database accepts connections
  from the whole internet. The only protection is the long database password
  (which is in the `DATABASE_URL` secrets). Nobody can get in without it, but
  anyone can try.
- If the list is empty or restricted, only Render's own services (and the IPs
  listed) can connect.

**The catch:** the nightly backup runs on GitHub, which connects from IP
addresses that change all the time. If you restrict the rules to a short
allow-list, the nightly backup will
fail unless the backup is changed to connect another way.

The decision for the maintainer (and a developer if needed):

1. Leave it open and accept "protected by password only" (keep the password
   strong, rotate it if in doubt, see section b); or
2. Restrict it, and first arrange a different route for the backup job
   (for example a different way to take the dump), then test the backup
   works before closing the rule.

Do not close the rule before the backup has a way in: you would silently lose
your backups. Whichever you choose, run **Nightly database backup** manually
afterwards and confirm it is green.

## g) Launching: turn preview mode off

While the site holds only sample books and test data, the Render service runs
in **preview mode**: every customer page shows a "coming soon" banner, online
online reservations and the membership payment form are switched off, and search engines
are told to ignore the site. It is controlled by one **Render environment
variable**, `PREVIEW_MODE` (an environment variable, not a secret file and not
a GitHub secret or variable). It is deliberately not in `render.yaml`.

To launch:

1. Make sure the real inventory is loaded and the sample and test data are gone.
2. Render dashboard > the `umas-books` web service > **Environment**.
3. Find the environment variable `PREVIEW_MODE` and delete it (the trash icon
   next to it).
4. Click **Save changes**. Render redeploys the service by itself; wait until
   it shows **Live**.
5. Check the site: no banner on the home page, a logged-in account holder can
   press "Reserve these books" in the cart, `/membership.html` shows the
   HelloAsso form, and
   `https://<your site>/robots.txt` no longer says `Disallow: /`. The red
   "PREVIEW MODE is ON" strip is gone from the admin screens.

### Clearing the test data

`npm run clear-test-data` removes the test data before launch. It is the one
command in this project that can destroy real orders and members, so it is
built to be hard to run by mistake: it does nothing unless you ask three
separate times, and it only runs while `PREVIEW_MODE` is on.

**What it removes**

- **Shop data**: all books and copies, orders and order lines, in-shop sales,
  awards, book requests, price look-ups, favourites, and pictures no longer used.
- **People**: every account that is **not an admin**, and everything they own
  (sign-ups, RSVPs, forum posts, votes and ideas, membership payments, reset and
  e-mail tokens, volunteer and meeting sign-ups, login sessions), plus guest
  sign-ups for events and classes.
- **Logs**: the admin audit log. (The script then writes one line saying that it ran.)

**What always stays**: every admin account with its two-step verification and
recovery codes, the admins' login sessions, the pricing rules (`pricing_settings`),
and the migration record.

**What stays unless you add an option**: **Content** (events, classes, blog
posts, announcements, charity rounds and charities, meetings, volunteer shifts)
stays unless you add `--include-content`; non-admin accounts stay if you add
`--keep-members`.

**Steps** (do them in this order)

1. **Run the backup.** GitHub > the repo > **Actions** > **Nightly database
   backup** > **Run workflow**. Wait for the green tick. This is your undo button.
2. **Open a command line next to the database.** Either:
   - **From Render (easiest):** Render dashboard > the `umas-books` web service
     > **Shell** tab. A black terminal opens, already connected to the right
     database with the right settings. Or
   - **From a laptop:** in a terminal, `cd` into the `umas-books` folder of the
     project (once: `npm ci`). The command needs the database's **External
     Database URL**: Render dashboard > the database > **Connections** >
     *External Database URL* (it contains the password: never paste it into a
     chat or a file). The database must accept connections from your laptop
     (section f above). Put these two settings in front of every command, with
     your URL in the quotes:
     `PREVIEW_MODE=true DATABASE_URL="postgres://..." npm run clear-test-data -- ...`
     (below the command is shown without them). `PREVIEW_MODE=true` typed on a
     laptop is only your word: first look at Render > `umas-books` >
     **Environment** and check that `PREVIEW_MODE` really is there and `true`.
3. **Check who is kept:** `npm run clear-test-data -- --list-admins` prints the
   e-mail addresses of the admins. Every one that must keep working has to be in
   the list. If the list is wrong or empty, stop.
4. **Dry run** (deletes nothing, safe to repeat): `npm run clear-test-data`.
   It prints the database host and name, then for every table how many rows
   **would** be deleted and how many would remain, grouped as Shop data, People,
   Logs, Content and Always kept. Read it. Anything under *WARNING* (paid orders,
   accounts marked as members) is a reason to stop and ask. Add
   `-- --include-content` or `-- --keep-members` to the dry run to see those
   variants. Note the two dashes: `npm run clear-test-data -- --keep-members`.
   Without the `--`, npm swallows the option.
5. **The real run.** The dry run ends by printing the exact command; it looks like

   ```
   npm run clear-test-data -- --execute --confirm "DELETE TEST DATA FROM <database name>" --i-have-a-backup
   ```

   Copy that one (it already has the right database name). Add
   `--include-content` and/or `--keep-members` if you want them. All three
   (`--execute`, the exact `--confirm` text, `--i-have-a-backup`) are required,
   or it refuses and changes nothing. It does everything in one go: if anything
   looks wrong in its own final checks (an admin missing, pricing rules changed,
   kept content changed) it undoes the whole run and says so.
6. **Check:** log in as an admin (the session stays valid), the inventory is
   empty, the admin list is right, the pricing rules are unchanged. The next
   book you add is number 1.

**Afterwards, what remains**: the admin account(s) with two-step verification,
pricing rules, the content (unless cleared), and the migration record. Counters
of emptied tables start again at 1.

**To undo**: within a week Render's own point-in-time recovery (Render dashboard
> the database > **Recovery**, back to a moment just before the run) is the
quickest; otherwise restore the backup you took in step 1: see **Restoring from
a backup** in `umas-books/README.md`. A restore also brings back the test data,
which is the point of an undo.

**Never run it on the live site.** Once `PREVIEW_MODE` is deleted the script
refuses; `--allow-live` overrides that and exists only for a real emergency with
a developer at your side, because after launch it would delete real orders (which
French accounting law makes you keep for 10 years) and real members.

**New database tables.** The script refuses to run when the database has a table
it does not know, and an automated test fails when a developer adds one without
classifying it in `src/lib/clearTestData.js`. If you ever see "tables this script
does not know", it needs a small code change first.

### Launch checklist (before and right after turning preview off)

Tick each one. Where a variable lives matters: **Render environment variable**
= Render > `umas-books` > Environment; **GitHub repository variable** = GitHub >
Settings > Secrets and variables > Actions > **Variables** tab; **repository
secret** = same page, **Secrets** tab.

- [ ] **Domain.** `https://umasbooks.org` (and `www`) is attached to the Render
  service (Settings > Custom Domains) with a valid certificate, and loads the site.
- [ ] **`APP_BASE_URL`** (Render environment variable) is `https://umasbooks.org`,
  so emailed links and the membership payment return URL point at the real domain.
- [ ] **`PREVIEW_MODE`** (Render environment variable) is deleted, as above.
- [ ] **Real client IP.** Followed "Check the real client IP" below: req.ip is
  your own public IP from mobile data and from home wifi.
- [ ] **No launch alerts.** After the redeploy no email arrived titled
  "APP_BASE_URL missing", "HelloAsso is still in SANDBOX mode" or "HelloAsso
  credentials missing", and admin pages show no red HelloAsso sandbox banner.
  Opening `https://umas-books-cmvv.onrender.com/` redirects to `https://umasbooks.org/`.
- [ ] **`HELLOASSO_API_BASE`** (Render environment variable) is unset or the
  production address, **not** the sandbox one. The `HELLOASSO_*` client id,
  secret and organisation slug are the live ones.
- [ ] **HelloAsso webhook (membership).** In the HelloAsso back office the
  notification URL is `https://umasbooks.org/webhooks/helloasso`. It only
  handles membership payments now; books and seats are not paid online.
- [ ] **`CONTACT_TO`** (Render environment variable) is the mailbox that should
  receive contact-form messages and forum reports (default
  `admin@umasbooks.org`).
- [ ] **Gmail alert test.** GitHub > Actions > **Send a test alert** > Run
  workflow, and the email arrives (it also runs by itself monthly). Boot logs
  must not show the `[env] WARNING ... error alerts ... DISABLED` line.
- [ ] **Uptime check.** Optionally set the GitHub repository variable
  `SITE_URL` (for example `https://umasbooks.org`); unset, the uptime check
  already watches `https://umasbooks.org`.
- [ ] **`TOTP_ENCRYPTION_KEY`** is copied into the password manager (section b).
- [ ] **Sample and test data removed**, using the clearing script in
  "Clearing the test data" below (dry run first, backup first), and the admin
  e-mail list it prints is the right one.
- [ ] **Automated end-to-end tests** run and passed, **while the site is still
  in preview mode** (they refuse a live site unless `E2E_ALLOW_LIVE=1`), for
  example `E2E_BASE_URL=https://umasbooks.org npm run e2e` from the `umas-books`
  folder with the test accounts' details typed into that Terminal window. Set
  them for one run only, never in a file. Instructions and the list of
  manual-only steps: `umas-books/e2e/README.md`. The tests follow the five
  kinds of user (guest, account holder, member, volunteer, admin); the account
  holder login must be a plain account that is not a member. Clean up what they created
  (the README lists how) before launch.
- [ ] **A real reservation, end to end.** As an account holder (not a member)
  reserve one cheap book, check the confirmation email arrives, then in admin >
  **Orders** open the reservation and press **Mark collected and paid** (section
  k). The book shows as sold and the sale shows in the sales report.
- [ ] **Manual test scripts** run and passed, one script per kind of user (guest,
  account holder, member, volunteer, admin, edge cases): every **(must)** step,
  and the manual-only steps the automated tests list, see
  `docs/testing/manual-test-scripts.md`.

### Check the real client IP

Do this once after the deploy that introduced `TRUST_PROXY_HOPS`, and again if
you ever change the Cloudflare or Render set-up. Rate limits (including the one on
"Reserve these books") and the admin activity log all depend on the app seeing the visitor's real
address and not a Cloudflare one.

1. Log in as an admin, on your **phone on mobile data** (wifi off), and open
   `https://umasbooks.org/admin/diagnostics/client-ip`.
2. Search "what is my IP" in another tab. The **req.ip** line must be exactly
   that address (your carrier's public IP).
3. Do the same from **home wifi** (a laptop or phone on the wifi). Again
   **req.ip** must be your own public IP, **not** a Cloudflare address.
4. If it is wrong: Render > `umas-books` > Environment > add or change
   **`TRUST_PROXY_HOPS`** (a Render environment variable), save, wait for the
   redeploy, repeat from step 1. Normal value 2. If req.ip is still a
   Cloudflare address, try 3; if it shows an address that is not yours but
   neither is it Cloudflare, try 1. Never set it higher than needed: too many
   hops let a visitor choose their own IP.

### Turning it on again

Same place: Render dashboard > the web service > **Environment** > **Add
Environment Variable**, name `PREVIEW_MODE`, value `true` > **Save changes**
(the service redeploys). Do this whenever the site holds test data again.
Any value other than `true` or `1` leaves preview mode off.

## h) Price suggestions and the AI market check

Prices suggested when a book is added come from rules the volunteers can edit
(admin menu > **Pricing rules**), so day to day nothing needs doing here. The
optional **online price check** uses the Anthropic API and is **off by
default**. All three settings are **Render environment variables** (the
service's **Environment** tab):

| Variable | What it does |
|---|---|
| `PRICING_AI` | Set to `1` (or `true`) to switch the online price check on. Needs `ANTHROPIC_API_KEY` to be set too. Remove it (or set `0`) to switch it off: suggestions then use the built-in rules only, which still works. |
| `PRICING_AI_DAILY_MAX` | Most online lookups per day (Paris time), default `150`. It is counted from the database, so restarting the service does not reset it. `0` stops all lookups. |
| `PRICING_AI_MODEL` | Optional. A different Anthropic model for the check. It must support the web search tool. Leave unset to use the same model as book descriptions. |

Good to know:

- **Cost control:** each book is looked up at most once a month (results are
  kept in the `price_lookups` table), a book with no result is retried after a
  week, and a failed lookup after an hour. The daily cap is the hard limit.
- **If it misbehaves:** unset `PRICING_AI` and redeploy (or just save the
  variable: Render restarts the service). Nothing else is affected; the rules
  keep working. A lookup that fails never blocks adding a book (the page waits
  at most about 12 seconds).
- **Web search is billed by Anthropic** on top of the normal usage; check the
  Anthropic console usage page after the first week.
- **Privacy:** only the ISBN, title, author and binding are sent. See
  `docs/privacy/processors-checklist.md` (Anthropic row).
- **To start fresh for one book** (its cached online price looks wrong): in the
  database, `DELETE FROM price_lookups WHERE isbn = '<the 13-digit ISBN>';`.

## i) Awards and best-seller lists on books

When a book is added, the website looks up awards and best-seller lists in
the background (a few seconds, up to a couple of minutes) and shows them on the
book page as "Awards & lists". Old books are filled in gradually.

**What customers see.** Only entries that are *verified* (from Wikidata, from
the New York Times list, or typed by an admin) or *approved* (suggested by AI,
then approved by an admin). Nothing else is ever shown.

**Volunteer how-to**

1. **Check suggestions:** admin menu > **Awards to review**. For each line, click
   *Open source*, read that the page really says this about this exact book, then
   **Approve** or **Reject**. When unsure, reject. Several at once: tick them and
   click **Approve selected**.
2. **One book:** admin > Books & Orders > the book > **Awards & lists**. You see
   every entry, where it came from and its status. **Re-check now** looks again.
   **Add awards (comma separated)** adds your own, for example
   `Booker Prize (2019), Prix Goncourt (1999)`; they show at once, and you can
   remove them again. **Hide from customers** rejects a wrong entry.
3. Everything you approve, reject, add or remove is written to *Admin activity*.

**Settings** (all optional; Render dashboard > the `umas-books` service >
**Environment** > these are *environment variables*, not secrets in GitHub):

| Variable | What it does |
|---|---|
| `NYT_API_KEY` | New York Times best-seller history. Get a free key at developer.nytimes.com (create an app and enable the *Books API*). Without it that source is simply skipped. |
| `AWARDS_AI` | Set to `1` to let the AI search the web too. Needs `ANTHROPIC_API_KEY`. Leave unset to keep it off. |
| `AWARDS_AI_DAILY_MAX` | Most books the AI checks per day (default 100). The *Awards to review* page shows today's count. |
| `AWARDS_AI_MODEL` | Optional model name; the default is the one used for book descriptions. |
| `AWARDS_LOOKUPS` | Set to `off` to stop all lookups at once. |

**Known limits.** Wikidata coverage is patchy: no entry means "Wikidata does
not know", not "this book won nothing". Wikidata and the NYT list are trusted
as they are; AI suggestions need your approval because an AI can be wrong or
make things up. A lookup that fails (internet problem, a limit reached) is tried
again after a day. Only the book's title, author and ISBN are ever sent out; no
member or customer data.

## j) Price sticker colors

Every used book gets a colored price sticker so customers and volunteers can
read the price at a glance. The color follows the price: you never choose it
separately, and the admin screens show it as a small colored chip next to the
price.

| Sticker | Meaning |
|---|---|
| Yellow | EUR 3 |
| Green | EUR 5 |
| Blue | EUR 8 |
| Red | EUR 10 |
| Purple | Custom / special price (any other price on a used book) |
| Orange | Clearance (EUR 1) |
| White | New book: sold at the publisher's price (loi Lang). Write the price on the sticker; a discount of up to 5% is allowed |

If a copy is on clearance it is orange whatever its price. A new book is
always white.

**Printing the sticker sheet**

1. Admin > **Books & Orders** > **Price stickers**.
2. **Added since** defaults to the last 7 days: set an earlier date for older
   books. You can also narrow by **Location** and by **Color**.
3. Each row shows the color, price, title, author, ISBN, condition, binding and
   location. Rows are sorted by location, then color, so you can stick all the
   stickers of one shelf together.
4. Click **Print** (menu and buttons are left out, colors are kept; if the
   colors come out gray, tick "Background graphics" in the print dialog) or
   **Download CSV** to open it in a spreadsheet. CSV downloads are written to
   *Admin activity*.

Only copies that are **In Store** are listed. Nothing here changes prices; to
change a price, open the book and use the price choices on the copy.

## k) Reservations, collecting and paying in the shop, refunds

**How it works.** A customer with an account reserves books (and drop-in seats)
on the website. **Nothing is paid online.** The customer comes to the shop
(Rue Peyrolière, Tuesday to Saturday, 10:00 to 19:00), and you take the payment
yourself (cash, card machine or cheque). Then you record it on the website, so
the books count as sold and the sale appears in the reports. For a drop-in seat
the customer pays at the session. **Only the membership is still paid online
(HelloAsso, section n).**

Rules the site applies by itself (they come from `src/lib/legal.js` and the
terms of sale, `/terms-of-sale.html`):

- Books are held **14 days** (until the end of the 14th day, Paris time). You
  can extend a reservation **once, by 7 days**.
- A reserved drop-in seat is held until the session is over.
- One account can hold at most **10 books** and **3 open reservations**.
- A customer can cancel their reservation from their account page; a seat only
  until **24 hours** before the session.
- Customer emails: a confirmation right after reserving (with the deadline, the
  shop address and the withdrawal information the law asks for), a reminder on
  day 10, a short "your reservation has ended" email if it lapses (no penalty),
  and a reminder 24 hours before a reserved drop-in seat.
- You get one email "N reservations expiring within 2 days" (once per
  reservation); the dashboard's **Needs attention** box also lists reservations
  expiring within 3 days.

Everything is on **admin > Books & Orders > Orders** (`/admin/orders`). It opens
on **Reserved: awaiting pickup**. The **Show** menu has **Expiring in 3 days**,
**Expired**, **Paid**, **Refunded**, **Cancelled** and the other lists; **Search**
finds an order by number, email or name.

### A customer comes to collect a reservation

1. Ask for the name or the reservation number (it is in their email). Open
   admin > **Orders** and search, or open the **Pickup list** (link under the
   filters, or `/admin/orders/pickup-list`): every open reservation grouped by
   customer, with the **shelf** of each book and the **amount to collect**.
   **Print version** (`/admin/orders/pickup-list?print=1`) is made for paper:
   print it in the morning and tick the books as you fetch them.
2. Fetch the books from the shelves (the order page also shows each copy's
   shelf).
3. Take the payment in the shop, then open the reservation (`/admin/orders/<number>`)
   and fill **Mark collected and paid**: choose **How did they pay?** (Cash,
   Card at the shop, Cheque or Other). **Amount received** is filled in with the
   total. You may only **lower** it (a discount given at the till), and then the
   note is required. Press **Mark collected and paid**.
4. What happens: the reservation becomes **Paid** and **Collected**, the books
   become **sold**, the sale counts in the dashboard and reports **from that
   day** (the day you press the button, not the day of the reservation), and the
   payment method and amount are kept on the order.
5. If the reservation is already past its deadline (red message on the order
   page) but the customer is standing in front of you with the books still on the
   shelf, you can still collect it.

**The customer takes only some of the books** (partial pickup). On the order
page use **Collect selected items**: tick the books being taken, choose how they
paid, press the button. The ticked books are sold and paid. The books left
behind move to a **new reservation** with the same deadline (the order page
then shows "Related reservations" linking the two). This button only appears
when the reservation holds more than one item.

**A drop-in seat**: the customer pays at the session. After the session, open the
reservation and press **Mark collected and paid** if you took the money (or
leave it: the seat is released by itself once the session is over, and a
reservation that is never collected simply ends as expired).

### Reservations not collected

You do not have to do anything for a reservation that nobody collects: after the
deadline the books go back on sale by themselves (they are released the next
time anyone looks at the shop, and at the latest within 6 hours), the customer
gets the "your reservation has ended" email, and there is no penalty and
nothing to refund (nothing was paid).

If you want to act before that:

1. Open **Show > Expiring in 3 days** (or follow the link in the "N reservations
   expiring within 2 days" email). Contact the customer (email, phone if given).
2. **They need more time:** open the reservation and press **Extend by 7 days**.
   It works **once** per reservation; the button then disappears. Ask them to
   come in the new period.
3. **They say they do not want the books:** press **Cancel reservation** (see
   below), or ask them to cancel from their account page.
4. **They never answer and the deadline has passed:** you can leave it (it
   releases itself) or press **Mark no-show / expired** to put the books back
   on the shelf at once. The difference from "Cancel reservation" is only how it
   is recorded: a no-show is counted as expired in the **Reservations** report.
5. **Show > Expired** lists the reservations that lapsed. A customer who still
   wants a released book must reserve it again on the website (if it is still
   available).

### Cancelling a reservation

- **The customer cancels:** from their account page (or the reservation page)
  they press **Cancel reservation**. Books go back on sale at once; for a
  drop-in seat this works until 24 hours before the session. Within 24 hours they
  must write to you; you can then cancel it yourself.
- **You cancel:** open the reservation and press **Cancel reservation**
  (it asks you to confirm). The books go back on the shelf (listed as in stock
  online) and the seats are freed. The customer is not emailed by the website:
  write to them if it was your decision.
- A cancelled or expired reservation never counts as a sale. Its customer's
  name and contact details are anonymised 30 days later (privacy rule).

### Selling a book that is reserved

A book reserved online belongs to its reservation. You cannot "sell" it from the
inventory screens: **Sell in shop** and the inventory release buttons refuse it
and say which order holds it ("Not sold: ... is reserved by order #N. Open that
order to collect it ... or cancel the reservation first").

- **The reserving customer buys it:** collect the reservation as above.
- **Someone else wants that copy in the shop:** if the shelf has no other
  copy, ask the reserving customer, or cancel their reservation (**Cancel
  reservation**; tell them) and then sell the book normally with **Sell in
  shop**. Do not hand the book over before cancelling: the reservation would
  still show it as held.
- A book that is **not** reserved (In stock) is sold with **Sell in shop**
  exactly as before.

### Refund after collecting

Customers can change their mind after buying only where the law gives a right
(see the terms of sale, "Right of withdrawal"; the shop itself does not take
books back for a change of mind in the shop). The terms say: "Used books: no
returns or exchanges for a change of mind in the shop. The legal guarantees
still apply, and so does the statutory right of withdrawal where the law
provides for it." **Whether that right applies to a reservation paid in the shop
is an open legal question** (`docs/legal-todos.md`, section 7), so **never
refuse a withdrawal email from a customer on the grounds of the no-returns
rule**: answer, look at the book, and ask the association's adviser if you are
unsure.

**The website cannot move money.** The refund is done **in the shop** (cash,
cheque or card), then you record it:

1. Read the customer's email to admin@umasbooks.org (a clear email is enough:
   the withdrawal form in the terms is optional). Open the order: admin >
   **Orders** > search. Check it is **Paid**.
2. Get the book back (it can be kept until the book is back, but never later
   than 14 days after the email) and give the money back: cash, cheque or card.
3. **Only after you gave the money back**, open the order and press **Mark
   refunded**. A confirmation page asks you to tick "I have already given the
   money back to the customer" and to write a note (for example "Withdrawal
   email 3 Oct, book returned 5 Oct, refunded in cash 5 Oct"). Confirm.
4. What the website does at once: the order becomes **Refunded**; the books go
   back **In stock** (a book already sold again is left alone); drop-in seats are
   released; the sale leaves the dashboard, the reports (a **Refunds** table in
   the sales report shows it) and the buyer's totals; the action is written to
   **Admin activity**. Pressing twice changes nothing.
5. Email the customer to confirm (the website does not), and put the book back
   on the shelf.

A **partial** refund (one book of several): do **not** press Mark refunded (it
would put **all** the books back on sale). Write a note in your own records and
ask the developer if you need the order split.

An order from before reservations existed that was **paid online on HelloAsso**
(old orders only; none are created any more) must be refunded in the HelloAsso
dashboard (https://admin.helloasso.com) **before** you press Mark refunded.

### Other order buttons and lists

- **Show > Paid online and not collected (old orders)** and **Cancel unpaid
  order** exist only for orders from the old online checkout (before
  reservations). Nothing new creates them.
- **Reservations report:** admin > **Reports** > **Reservations** (or
  `/admin/reports/reservations`): reserved, collected and paid, expired and
  cancelled, by month, and the conversion rate (collected out of the
  reservations that are over). It can be downloaded as a spreadsheet (CSV).
  Money is counted in **Sales over time** at the day you record the payment.
- **Reservations are switched off in preview mode:** customers see a friendly
  notice and nothing can be reserved (section g).

## l) Emails are not arriving (outbox)

Every email the site sends (reservation confirmations and reminders, account and password links,
book-request and reservation mails, forum notices, the contact form) is first
saved in the **email outbox**, sent at once, and retried automatically if it
fails: after 1, 5, 15 and 60 minutes, then every 4 hours, up to 8 tries.

You are told in three ways: an email "N emails could not be sent" (at most one
per hour), a **Needs attention** box on the admin dashboard, and the list at
Admin > **Email outbox**.

1. Admin > **Email outbox**. Look at the **Last error** column.
   - "Invalid login", "535", "Username and Password not accepted": the Gmail
     app password was revoked: go to section m) below.
   - "daily limit", "550 5.4.5", "Daily user sending quota exceeded": Google
     allows about 2000 messages a day from one mailbox. Nothing is lost: the
     rows stay queued and go out when the limit resets (within 24 hours). If
     it keeps happening, something is sending far too much: check the Render
     logs.
   - "timeout", "ECONNREFUSED": Gmail or the network was down; it retries by
     itself.
2. Once the cause is fixed, click **Retry now** on a row, or just wait: pending
   rows are retried every minute when due. Rows that already gave up (status
   **failed**) are not retried by themselves: use **Retry now** on each, then
   **Mark failed as handled** to clear the warning.
3. A customer says they never got their reservation confirmation: Admin >
   **Books & Orders** > **Orders**, find the reservation: it says "Confirmation:
   sent ..." or "NOT SENT". Click **Resend confirmation** (only for a
   reservation that is still open). The customer can also open the reservation
   page from their account page, which shows the same details.
4. A person never got an account link: ask them to use "Forgot password" again
   (or "Resend confirmation" on the login page) once mail works. Those mails
   lose their text as soon as they are sent, so they cannot be resent from the
   outbox; a new request creates a new link.

The text of sent emails is erased after 30 days (failed ones after 90): old rows
only show who/what/when.

## m) Gmail password revoked

Symptoms: "Invalid login" in the outbox errors, uptime/backup alert emails
missing too, no confirmation emails. The outbox keeps every customer email
safely for retry meanwhile (the alert email about it comes from the same Gmail
account, so it may not arrive: look at the dashboard instead).

1. Google account of `GMAIL_USER` > Security > 2-Step Verification > **App
   passwords**: create a new app password (revoking one stops it working).
2. Replace it in **both** places (section b, GMAIL_USER / GMAIL_APP_PASSWORD):
   Render env var `GMAIL_APP_PASSWORD` (Save: the site restarts) **and** the
   GitHub repository secret `GMAIL_APP_PASSWORD`.
3. Admin > **Email outbox**: **Retry now** on the failed rows, then **Mark failed
   as handled**. Pending rows go out by themselves within a minute.
4. Send a test: run the **Send a test alert** workflow (section d).

## n) A member paid with another email

HelloAsso asks for an email on its own payment form. If it is typed with a
typo, or is not the email of the person's site account, the payment cannot be
matched: the person pays but is not a member on the site.

You are told by an email "Membership payment from <email> matches no confirmed
account" (at most one per hour) and by the dashboard box. Admin > **Accounts**
(top of the page) lists **Unmatched membership payments**.

1. Find which account the payer is (ask them, or look at the typed email: it is
   usually a typo or a second address).
2. Under the payment, type part of their account email or name > **Search** >
   **Link to account** next to the right account. The payment is attached and
   the membership is granted immediately (365 days from the payment, or from the
   end of the current membership when renewing early).
3. If the account's email is not confirmed ("email not confirmed" next to it),
   the link still works, but ask the person to confirm their email.
4. A payment more than a year old, or a payment of 0 EUR, never grants
   membership. A person who simply has no account yet: ask them to create one
   (any email); then link the payment.

If an unmatched payment is really a mistake (not a member payment), leave it:
it does nothing. It is erased with the other payment records after 10 years.

## o) The VAT line ("TVA non applicable") and the footer social links

**The VAT line.** The association does not charge VAT, and French law wants the
legal article that says why written next to "TVA non applicable". Which article
applies (for example 261-7-1° or 293 B of the Code général des impôts) is a
question for the association's accountant, and it has **not** been answered
yet, so the site shows just "TVA non applicable" everywhere: in the terms of
sale, in the order confirmation email, next to the cart total ("Prix TTC, TVA
non applicable") and under the price on every book page.

Once the accountant answers:

1. In the repository, open `umas-books/src/lib/legal.js` and set
   `VAT_NOTICE_ARTICLE` to the article only, without "art." and without "du
   CGI", for example `"293 B"`.
2. Bump `TERMS_OF_SALE_VERSION` in the same file to the day of the change
   (YYYY-MM-DD): the terms changed.
3. Make a pull request as usual. The line then reads, in all four places,
   "TVA non applicable, art. 293 B du CGI". Nothing else needs editing.

**The footer social links.** The Instagram and Facebook icons are hidden until
real pages exist. When they do, put the full addresses in `SOCIAL_LINKS` in the
same file (`umas-books/src/lib/legal.js`, for example
`instagram: "https://www.instagram.com/..."`); an empty value stays hidden.

## p) The till

Written for the person who runs the shop. Nothing here needs a developer.

### What to buy

- **A barcode scanner**: any 2D (or 1D+2D) scanner that works as a **USB or
  Bluetooth keyboard ("HID mode") and presses Enter after each code**. Most
  cost 25 to 60 euros. Check the product page for "keyboard emulation / HID" and
  "Enter (CR) suffix"; ask the seller to confirm it reads Code 128 and EAN-13.
- **A tablet or a laptop** with a keyboard (any recent browser). A tablet needs
  the scanner paired by Bluetooth or a USB adapter.
- **A SumUp Solo card reader** (with its own SumUp account).
- **A cash drawer** you can open by key or button. (Optional later: a receipt
  printer; the receipt page prints on any printer today.)
- **Labels**: a label printer, or sheets of sticky labels for any office printer.
  A 50 x 25 mm label is the default; other sizes are set on the labels page.

### Test the scanner

1. Open **Till** in the admin menu: the cursor is in the big scan box.
2. Scan any label (or a book's barcode). **The code must appear in the box and
   the line must be added at once** (the scanner presses Enter by itself).
3. If the code appears but nothing happens, the scanner has no Enter suffix:
   see its manual ("add CR suffix"). If the characters are wrong (for example
   digits turn into symbols), the scanner is set to the wrong keyboard layout
   (set it to US layout, or the layout of the tablet).
4. The page keeps the cursor in the scan box by itself. After a mistake the
   screen shows a red message and beeps (untick "Beep on errors" to silence).

### Printing copy labels

Every copy gets a label with a barcode `UB-<number>`. After you add a copy
there is a **Print label** button; later use **Books & Orders > book > Label**,
or **Inventory > Labels**, or **Price stickers > Print labels**. Choose the
size (width and height in millimetres) and **a label roll** (one label per
page) or **a sheet of labels** (A4). In the print window choose **100% / actual
size** and no headers or footers, and print one label to check before many.

### Books with no ISBN

Old books, local editions and some second-hand books have no barcode. They work
like all others: **Add Book > "No ISBN? Enter the details by hand"**. Only the
title is required; type the author, genres, binding, condition and price
yourself (the price help says "Manual review": set the price by hand, or leave
it empty and enter it at the till). Print the label and stick it on: the till
sells it by scanning the label (`UB-...`). The label and till screens show
"No ISBN" instead of a number.

### Open the day

At the start, on the Till page type the cash in the drawer (the **opening
float**) and press **Save opening float**. You can also do it on **End of day**.

### Selling

1. Scan each book (its label `UB-...`, or its own ISBN barcode). If a title has
   several copies in stock a big list asks which one (price, grade, place):
   tap it. Prefer the label: it is exactly that copy.
2. A copy with no price asks for one. For a **used** book you can change a
   price by tapping it (type the agreed price, optional reason). A **new** book
   must stay between 95% and 100% of the publisher's price (French fixed book
   price law): the till refuses anything else.
3. **Cash**: type what the customer gave (or tap Exact, 5, 10, 20, 50). The
   big green **Change to give** appears. Open the drawer, press **Confirm sale**.
4. **Card**: the screen says "Charge EUR x on the SumUp reader, then press Card
   paid". Charge it on the reader; when the reader says approved, press **Card
   paid** (you may type the last 4 digits or the terminal receipt number first).
   If the reader says refused, press Back and try again or take cash.
5. **Sale recorded**: press **Next customer** (or tick the 10 second automatic
   option). **Receipt** prints a simple receipt with no customer data.
6. A mistake before paying: **Remove** the line, or **Clear sale**.
7. One method per sale: split payments are not possible; make two sales if you
   must.

### Selling things that are not books

Tote bags, bookmarks, a coffee, a donation...: press **Manual item** (description
of at most 80 characters, price above 0, quantity, category). They need no
stock. For things you sell often, add them under **Inventory > Other stock (not
books)** (or **Other stock (not books)** on the Till page): each becomes a big
button on the till. Give an item a number in **Stock** if you want it counted: it
goes down with each sale, the till refuses to sell it at 0 and the button says
"low" at 3 or fewer. The category (Merchandise, Refreshments, Donation, Books
(other), Other) decides which line of the accounting export it lands in. These
lines also say "TVA non applicable" on the receipt; there is no VAT calculation.

### Barcodes on items

An item can have a barcode so the scanner adds it: on its row of **Other stock
(not books)** click in the **Barcode** box and scan the item (the manufacturer's
code, 8 to 14 digits, is typed for you), then **Save**. Scanning it at the till
adds one; scan again for another one (or use + and - on the line). Items with
no barcode: press **Generate a shop code** (it becomes `ITEM-<number>`), then
**Print barcode label** and stick the label on the item. Rules: each active
item needs its own code; a code cannot start with `UB-` (that is for books) or
look like `ORDER-<number>`; if a code is also a book's ISBN you get a warning,
and the till will add the item rather than the book (sell that book by its
label).

### Voiding a sale

Only **today's** sales, only until the day is closed. On the Till page under
**Today's sales** open **Void sale**, type the reason (required) and confirm.
The books go back in stock and the sale no longer counts in reports. Older
sales cannot be voided: tell the treasurer.

### If the internet is down

Write each sale on paper (what, price, cash or card, time). When the internet
is back, enter them the same day: on the Till, put the books on the sale, open
**Sale made earlier today** and type the time it was really sold, then pay. The
sale keeps that time and the admin activity log records that the time was set
by hand. Take only cash if the card reader needs the internet (or use the SumUp
app on a phone with its mobile data).

### If the card reader fails

Take cash, or charge in the SumUp app on a phone. In both cases record the sale
on the till as Cash or Card (put "app" in the card reference).

### Closing the day (count the drawer)

1. Open **End of day**. Check the numbers: sales by payment method, voided
   sales, and **Expected cash in the drawer** (opening float + cash sales).
2. Count all the cash in the drawer (coins and notes, including the float) and
   type the total in **Counted cash**. The screen shows **over** or **short** as
   you type.
3. Add a note if there is a difference, then **Close the day**. This locks that
   day's voids. **Print summary** prints a plain end-of-day sheet; **Download
   CSV** gives the list of sales.
4. Keep the float for tomorrow in the drawer and take the rest to the bank.
   A day with sales that is not closed appears under **Needs attention** on the
   Dashboard.

### The accounting export for the treasurer

**Reports > Accounting export**: choose the dates, **Download CSV**. One row per
day, category (Books used, Books new, Merchandise, Refreshments, Class seats,
Membership, Donation, Other) and payment method (Cash, Card at the till,
HelloAsso), with the count and the total in euros. It never contains names or
emails. Voided sales and refunded orders are left out. "Books (other)" manual
items appear as Other. Whether Paheko's import accepts this layout is not
confirmed: see `docs/till-todos.md`.

### Later: the SumUp Cloud API

Today the card is charged by hand (`ManualCard`). The code is ready for a SumUp
implementation (`src/lib/cardPayments.js`) but nothing is connected and no
environment variable is read. When it is built it will need a SumUp API key and
a paired Solo reader as Render environment variables (names to be decided then).
