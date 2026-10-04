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
- **Errors in the running site** (`src/lib/errorAlert.js`) and the **contact
  form** (`src/routes/contact.js`): sent to the Render env var `CONTACT_TO`,
  or `admin@umasbooks.org` if it is not set.
- All of these are *sent from* the Gmail account in `GMAIL_USER`.

To add a second person: for the workflows, edit the `to:` line in those three
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
