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
running), then starts the site with `npm run seed && npm start`
(`render.yaml`). Migrations (database changes) are applied once and recorded. Redeploying an old commit
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

**HELLOASSO_\*.** Render env vars only. If wrong, online payment stops (the
site logs an `[env] WARNING` at boot).

1. In HelloAsso, create a new API client (or regenerate the secret).
2. Render > `umas-books` > Environment > update `HELLOASSO_CLIENT_ID` and
   `HELLOASSO_CLIENT_SECRET` > **Save**.
3. Make a small test payment.

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

**How the first admin is created.** At every start `npm run seed` runs
(`src/seed.js`). If **no admin exists yet** it creates one from the Render env
vars `SEED_ADMIN_EMAIL` (default `admin@umasbooks.org`) and
`SEED_ADMIN_PASSWORD` (required, must be a strong password). If any admin
exists it does nothing, so it cannot reset a password. After the first boot,
**delete `SEED_ADMIN_PASSWORD` from Render's environment** (Render >
`umas-books` > Environment > trash icon > Save) so the password does not sit
there forever. Deleting it is safe while an admin exists.

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
- **Contact-form emails:** delete contact-form emails older than 12 months
  from the admin@umasbooks.org mailbox (Gmail search: `older_than:12m`, review,
  then delete). Keep any conversation that is still ongoing. This is what the
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
checkout and the membership payment form are switched off, and search engines
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
5. Check the site: no banner on the home page, the cart shows the checkout
   form, `/membership.html` shows the HelloAsso form, and
   `https://<your site>/robots.txt` no longer says `Disallow: /`. The red
   "PREVIEW MODE is ON" strip is gone from the admin screens.

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
