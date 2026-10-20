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

## Accounts and secrets inventory

The inventory (every service, its owner account, recovery email, 2FA, where the
secret lives and who else has access, including UptimeRobot) is section v) at
the end of this runbook. Add a row there when a new service is set up. The
secrets themselves are listed in section b).

## b) Rotating secrets

Rotate when a secret may have leaked, someone with access leaves, or a service
asks you to. Always change **every** place listed, then check
`/healthz` and send a test (contact form / password reset).

| Secret | Where it lives |
|---|---|
| `DATABASE_URL` | Render env var (set by hand, see "Rotating the database password" below) **and** GitHub repository secret `DATABASE_URL` (nightly backup) |
| `SESSION_SECRET` | Render env var only |
| `TOTP_ENCRYPTION_KEY` | Render env var only |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Render env var **and** GitHub repository secrets (uptime alerts, backup emails) |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG`, `HELLOASSO_API_BASE` | Render env var only |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` (optional, not a secret: the last part of your membership form's HelloAsso address) | Render env var only. When set, only payments on that form make someone a member; leave it unset to accept any membership form |
| `PREVIEW_MODE` (not a secret; see section g) | Render env var only |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` (and optional `BACKUP_S3_PREFIX`) | GitHub **repository variables** |
| `BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY` | GitHub **repository secrets** |
| `BACKUP_AGE_RECIPIENT` (the age **public** key; not a secret) | GitHub **repository variable**. Section ad) |
| `BACKUP_AGE_IDENTITY` (the age **private** key; optional, not recommended) | GitHub **repository secret**, used only by the monthly restore test. Section ad) |
| `ACCOUNTING_TO` (optional, not a secret: the treasurer's address, or several separated by commas) | GitHub **repository variable**. Section ae) |
| `FISCAL_YEAR_START_MONTH` (optional, a number 1-12, default 1 = January) | GitHub **repository variable**. Section ae) |
| age private key (the file `umas-books-backup-key.txt`) | Your password manager, plus a second copy kept elsewhere (section ad). **Never** in GitHub, Render or the repository, unless you choose the optional `BACKUP_AGE_IDENTITY` |

**DATABASE_URL (the Render database password).** The GitHub copy should be the
*read-only backup user's* connection string (`backup_ro`), not the owner's:
section ad), "A read-only database user for the backup". Rotating the owner's
password (steps below) then does not touch GitHub; rotating `backup_ro`'s does
(only the GitHub secret changes, plus the `ALTER ROLE` in step 2 of that section).
The web service's `DATABASE_URL` is set by hand in the Render dashboard
(`render.yaml` marks it `sync: false`, so the Blueprint does not manage it),
and GitHub keeps its own copy.
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
   shows the expected `DATABASE_URL`.
4. GitHub > Actions > **Nightly database backup** > Run workflow, and confirm it
   goes green.

### Rotating the database password

`DATABASE_URL` on the web service is **not** managed by the Blueprint
(`sync: false` in `render.yaml`): its value is the database's **Internal
Database URL**, set by hand. The Blueprint will never overwrite it, so you
must update it yourself, in this order. Keep the old password until the deploy
is verified (step 5).

0. Back up first (GitHub > Actions > **Nightly database backup** > Run
   workflow, confirm it goes green).
1. Change the password inside the database, as the website's own account (see
   "Which account to change" below). Connect with psql using the **External**
   host, from your Mac. Reconnect with the new password to prove it works
   **before** touching Render.
2. Render > `umas-books` > **Environment** > `DATABASE_URL` > edit: take the
   **Internal Database URL** (the host has no `.render.com` in it) and put the
   new password in it, taken from the password manager. **Save**.
3. **Manual Deploy > Deploy latest commit.** The pre-deploy command
   (`npm run migrate`) uses `DATABASE_URL`, so a wrong value makes the deploy
   fail safely: the old version keeps running.
4. Check the deploy log shows "Migrations complete." (or each migration), that
   `/healthz` returns 200, and that you can log in.
5. Only now is the old password safe to forget. If something is wrong, put the
   old password back (same method as step 1) and in `DATABASE_URL`.
6. The GitHub secret `DATABASE_URL` (nightly backup) uses the separate
   `backup_ro` user: change it only if you also rotate `backup_ro`, as
   described above.

**Which account to change.** On this database the login role
`umasbooksdb_lbtc_user` switches itself to the role `umasbooks` as soon as it
connects, so a plain `\password` changes `umasbooks` (the role that owns the
tables, with its own separate password), **not** the website's account. To
rotate the website's account:

1. Connect as `umasbooksdb_lbtc_user` with its current password.
2. Run `SET ROLE umasbooksdb_lbtc_user;`
3. Run `SELECT session_user, current_user;` and check it shows the **same name
   twice**. If the two names differ, stop: you would be changing the wrong
   account.
4. Run `\password umasbooksdb_lbtc_user` and type the new password twice.
5. Reconnect with the new password to prove it works, then continue with step
   2 above.

(`ALTER ROLE ... PASSWORD`, or `\password` while acting as `umasbooks`, fails
with "permission denied to alter role"; that error means step 2 or 3 was
skipped.)

**Render's Connect panel goes stale (expected).** After you change the password
inside the database, Render does not learn it: the database's **Connect** panel
keeps showing the OLD password, so its External, Internal and PSQL addresses
stop working. This is normal. Take the new password from the password manager,
never from that panel. Never paste a full connection address (it contains the
password) into chat or tickets.

**Internal vs external address.** The website uses the **Internal** Database
URL in `DATABASE_URL`. The External host (ends in `.render.com`) is only for
psql on your Mac and for GitHub's nightly backup. The backup uses its own
`backup_ro` account and the GitHub secret `DATABASE_URL`, so rotating the
website's password does not affect it.

**Inbound IP Rules.** In Render > `umas-books-db` > Networking (PostgreSQL
**Inbound IP Rules**) keep `0.0.0.0/0` (everywhere). If the rule is limited to
your own address, GitHub's backup cannot connect. The workspace-level
"everywhere" rule is for web services and is a different list; it does not
cover the database.

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
   live). First, the person's own **recovery codes**: each admin was shown 10
   codes once when they turned two-step on (and they are kept in the shared
   password manager, section w). On the code page they open **Lost your phone?
   Use a recovery code instead**, type one code in the **Recovery code** box
   (works on a phone: it is a letters keyboard; capitals or lowercase, with or
   without the dash and spaces, e.g. `ab3def7gh2` for `AB3DE-F7GH2`) and press
   **Use this recovery code**. Each code works once; afterwards, at
   `/account/2fa`, **Get new recovery codes** (needs a current app code) issues
   a fresh set. If the person has no recovery code left: another admin opens
   the site > Admin > **Members** > finds the person > **Reset Two-Step**. The
   person logs in with their password and enrols again.
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

Alerts go to **two addresses**: `admin@umasbooks.org,sharonbje@gmail.com`
(comma, no spaces; the second is on a different provider, so a locked Google
Workspace account cannot silence everything). Every alert is still *sent from*
the one Google account in `GMAIL_USER`. The value is set in **both** places
below; keep them identical.

**Change or add an alert address (do both places, same value):**

1. **GitHub repository variable** `ALERT_TO` (used by the backup, uptime,
   freshness, restore-test and test-alert workflows): GitHub > the repo >
   **Settings > Secrets and variables > Actions > Variables** tab > **New
   repository variable** (or the pencil next to it if it exists). Name
   `ALERT_TO`, value `admin@umasbooks.org,sharonbje@gmail.com` (signed in as
   `umasbooksadmin`, the repository owner; comma, no spaces) > **Add variable**. It is a
   *variable*, not a secret: addresses are not secret.
2. **Render environment variable** `ALERT_TO` (used by the site's own alerts:
   errors, emails that cannot be sent, failing background jobs, launch
   warnings): Render dashboard > `umas-books` > **Environment** > **Add
   Environment Variable** (or edit it) > Key `ALERT_TO`, value `admin@umasbooks.org,sharonbje@gmail.com` > **Save
   changes** (the site restarts, about a minute).
3. **Test it:** GitHub > **Actions** > **Send a test alert** > **Run workflow**.
   Both addresses must receive "[umas-books] TEST alert" within a minute. That
   proves the GitHub side. The site's own alerts use the Render value; they
   arrive at both addresses the next time a real alert fires (the first
   "[umas-books] Background job recovered" or error email is your proof): check
   the **second** inbox's spam folder once and mark the sender "not spam".

`CONTACT_TO` (the contact form and forum reports) is a separate setting with
the same format; if `ALERT_TO` is not set in Render, the site falls back to
`CONTACT_TO`, then to `admin@umasbooks.org`.

**The weekly test alert.** GitHub > Actions > **Send a test alert** runs by
itself every **Monday at about 07:17 UTC (09:17 in summer, 08:17 in winter in Paris)** (it used to be monthly: a
revoked Gmail password or a locked Google account was only noticed after up to
a month). **No test email on a Monday = the alert channel is broken**: go to
section m). You can also run it by hand any time (Run workflow).

**What each alert is, and what to do:** see section r) "When you receive an
alert".

- **Site down** (and "recovered"): `.github/workflows/uptime-check.yml`.
- **Nightly backup failed / monthly restore test failed**:
  `.github/workflows/nightly-db-backup.yml` and `backup-restore-test.yml`.
- **No fresh backup in Backblaze** (daily 09:00 UTC; catches the nightly
  backup not running at all): `.github/workflows/backup-freshness.yml`. Fails
  if the newest dump is missing, empty or older than 36 hours, or (after the 3rd
  of the month) the long-term monthly copy is older than 35 days. Before the
  first monthly copy exists it only shows a notice ("No monthly copy yet").
- **Errors in the running site, emails stuck, failing background jobs, launch
  warnings** (`src/lib/errorAlert.js`): the Render env var `ALERT_TO`.
- **Contact form** (`src/routes/contact.js`): `CONTACT_TO`.
- **Refund found in HelloAsso** and the **day-12 list of uncollected reservations**:
  `ALERT_TO`; see section k.
- **Reservations about to lapse** ("N reservations expiring within 2 days", once per
  reservation): also sent to `ALERT_TO`; see section k.

**DMARC report emails.** If your domain publishes a DMARC record with
`rua=mailto:admin@umasbooks.org`, Google and others send a daily XML report
to that mailbox. They are useful once in a while and noise the rest of the time,
and they can bury a real alert. Make Gmail file them automatically (it does not
delete them): Gmail > the gear > **See all settings > Filters and Blocked
Addresses > Create a new filter**. In **Has the words** type
`subject:"Report domain" OR from:noreply-dmarc-support@google.com OR
subject:"DMARC"` > **Create filter** > tick **Skip the Inbox (Archive it)** and
**Apply the label** > New label `DMARC reports` > also tick **Also apply
filter to matching conversations** > **Create filter**. Expected result: the
reports disappear from the inbox and collect under the `DMARC reports` label.
Open that label once a quarter: reports showing `fail` for mail you did send
mean SPF or DKIM is wrong (ask whoever manages the DNS at Squarespace Domains).
**Never put a filter on the `[umas-books]` alerts.**

### External monitor: UptimeRobot

A second, independent check watches the site from outside GitHub and Gmail, so
an outage is still noticed if GitHub Actions or the Gmail account is itself the
thing that broke.

- **What it is:** UptimeRobot (free plan), account **sharonbje@gmail.com**, one
  HTTP(s) monitor on `https://umasbooks.org/healthz`, every **5 minutes**.
  Alerts go to that account's email and to the UptimeRobot app on the phone.
- **Second layer:** the 30-minute GitHub check (`.github/workflows/uptime-check.yml`)
  stays on. UptimeRobot is faster; GitHub also emails ALERT_TO.
- **Pause it for planned maintenance** (a database move, a long deploy): log in
  at uptimerobot.com > the monitor > **Pause**, and **Resume** when finished.
  Do not delete it. A paused monitor that is never resumed is the usual way
  to lose monitoring, so write "resume UptimeRobot" in the maintenance notes.
- **What an alert means:** `/healthz` did not answer 200 within the time limit:
  the site is down, the database is unreachable, or `/healthz` is answering 503
  (it caches its last result for 3 seconds).
- **First three actions:** (1) open `https://umasbooks.org/healthz` yourself;
  (2) Render dashboard > `umas-books` > **Events** and **Logs** (is a deploy
  failing, is the database up?); (3) if the last deploy is the cause, roll back
  (section a); if the database is down, check Render's status page, and see
  "Emails are not arriving" (l) only afterwards. Note: since the live site
  answers only `umasbooks.org`, a check of the `onrender.com` address answers
  `/healthz` and nothing else, by design.

### What to do when you receive alert X

The full table (every alert, who sends it, and the first three actions, including
the UptimeRobot "DOWN" alert) is in section r) "When you receive an alert".

## e) Quarterly and yearly calendar

### Every quarter (put it in the shared calendar: 1 January, 1 April, 1 July, 1 October)

- **Mailbox cleanup (12-month promise).** The privacy policy promises that the
  emails sent by the website's contact form, volunteer sign-up and English
  Immersion pre-registration (subjects start with `Website contact:`,
  `Website volunteer sign-up` and `Website pre-registration:`) are deleted from
  the admin@umasbooks.org mailbox after 12 months. Gmail cannot be cleaned by the
  website, so the website **emails a reminder to `ALERT_TO` once a month**
  (subject "Monthly reminder: delete contact-form emails older than 12 months";
  job `Contact mailbox reminder`, remembered in `alert_flags`, listed under
  "Alerts sent" on `/admin/diagnostics/jobs`). When it arrives:
  1. In Gmail, search `older_than:1y` (to see only the website's emails, use
     `subject:(Website) older_than:1y`).
  2. Review the list. Keep any conversation that is still ongoing.
  3. Delete the rest (select all, Delete).
  4. Empty the Trash (Gmail > Trash > "Empty Trash now"), or the emails stay
     another 30 days.
  The pre-registration emails hold a child's name and year of birth, so do not
  skip them. If no reminder arrives for two months, check the job row.
- **Backup restore drill (section ad):** decrypt the newest backup on your Mac,
  restore it into a scratch database, look at the counts, delete it. The
  monthly GitHub restore test does *not* decrypt anything unless you gave it the
  private key, so this is the only proof that the key in your password manager
  really opens the backups.
- **GitHub Actions minutes:** also check the monthly usage (section t): GitHub > profile picture > Settings > Billing and plans > Usage this month.
- **UptimeRobot:** check the monitors are still active and the plan is still free (section d).

### Every year

- **Rotate the backup credentials (section ad):** the `backup_ro` database
  password and the Backblaze application key (the age key pair only if a person
  who had it has left). Put the date in the calendar for **1 October**, next to
  the quarterly drill.

- **Domain renewal:** umasbooks.org is registered at **Squarespace Domains** and
  expires **2027-08-22** (the DNS is also managed there). Check auto-renew and
  the payment card a month before, and that the registrant/recovery email
  is one the association controls (section v).
- **Node 22 end of life: April 2027.** Move to the next LTS before then. The
  version is set in three places and all must change together:
  `umas-books/.node-version`, `engines` in `umas-books/package.json`, and
  `NODE_VERSION` in `.github/workflows/ci.yml` (also check the other
  workflows for a Node version). Do it in one pull request and let CI test it.
- **GitHub Actions minutes:** the repo is private, so minutes are metered and
  when they run out the backups stop. Check usage **every month** and keep a
  spending limit set: section t).
- **Emergency access test (section w):** someone other than the usual person
  logs into Render, GitHub, Backblaze, Squarespace and Google using only the
  password-manager vault; refresh the accounts inventory (section v).
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

**Why the rule cannot simply list GitHub's addresses.** GitHub's runners use
thousands of address ranges that change every week (published at
`https://api.github.com/meta`, key `actions`), far more than a Render rule list
is meant for, and a stale list silently breaks the backup. The practical
choices are: (a) keep `0.0.0.0/0` and make the credential in GitHub weak
as a *prize* (a **read-only** user, section ad), long, rotated every year, and
the repository private; (b) take the dump from somewhere with a fixed address
(a small always-on machine of your own, or a self-hosted GitHub runner), then
close the rule to that one address. (b) costs money and upkeep; this runbook
recommends (a) for now.

**The residual risk, stated plainly (with option a).** Anyone who gets the
`DATABASE_URL` secret out of GitHub (a compromised GitHub account, a malicious
change to a workflow, a leaked log) can read **all** production data from
anywhere on the internet, until the password is rotated. The read-only user
stops them *changing or deleting* data, the encryption (section ad) protects
the copies in Backblaze, but neither stops them *reading* the live database
with that secret. What reduces it: the read-only user, a 40-character random
password, rotating it yearly (calendar, section e) and immediately after any
suspicion, keeping the repository private with two-step verification on every
GitHub account that can change workflows, and watching the Render database's
**Connections / Logs** if anything looks odd.

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
   press "Reserve (free, no commitment)" in the cart, `/membership.html` shows the
   HelloAsso form, and
   `https://<your site>/robots.txt` no longer says `Disallow: /`. The red
   "PREVIEW MODE is ON" strip is gone from the admin screens.

**What preview mode does not touch: the blog.** Admins can write, edit,
publish and delete blog posts (with their featured image) while the site is in
preview mode, exactly as after launch, and a published post shows on the
public blog at once (behind the coming-soon banner). Drafts and scheduled
posts stay hidden from visitors; in **Admin > Blog** their **Preview on site**
link opens the real blog page with that post, visible only to a logged-in
admin. Only reservations (cart/reserve), the membership payment form and
search-engine indexing are switched off by `PREVIEW_MODE`. If a new post does
not appear for a visitor, check its **Status** is Published and its **Publish
Date** is not in the future; the public list is cached by browsers for up to 5
minutes (not for a logged-in admin).

### Clearing the test data

`npm run clear-test-data` removes the test data before launch. It is the one
command in this project that can destroy real reservations and members, so it is
built to be hard to run by mistake: it does nothing unless you ask three
separate times, and it only runs while `PREVIEW_MODE` is on.

**What it removes**

- **Shop data**: all books and copies, reservations and reservation lines, in-shop sales,
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
   Logs, Content and Always kept. Read it. Anything under *WARNING* (paid reservations,
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
a developer at your side, because after launch it would delete real reservations (which
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
  workflow, and the email arrives (it also runs by itself every Monday). Boot logs
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
  **Reservations** open the reservation and press **Mark collected and paid** (section
  k). The book shows as sold and the sale shows in the sales report.
- [ ] **Test system rehearsal.** The change that goes live was first on the test
  system (section aa), the staging smoke script passed there, and the production
  deploy was pressed by hand afterwards (if production is on manual deploys).
- [ ] **Search engines.** Right after launch, submit `sitemap.xml` to Google Search Console and Bing
  Webmaster Tools and check `/fr/` in a private window ("Search engines: submit the sitemap" above).
- [ ] **Manual test scripts** run and passed, one script per kind of user (guest,
  account holder, member, volunteer, admin, edge cases): every **(must)** step,
  and the manual-only steps the automated tests list, see
  `docs/testing/manual-test-scripts.md`.

### Search engines: submit the sitemap (after launch)

Owner steps, done once, after `PREVIEW_MODE` is off and `https://umasbooks.org` is live. Until then
the site tells every crawler to stay away (`noindex`, an empty sitemap), so there is nothing to submit.

**What the site gives search engines.** Every public page exists at two addresses: the English one
(`/books.html`) and the French one (`/fr/books.html`; the French home page is `/fr/`). Each page names
both in its `<head>` (`rel="canonical"` for itself, `rel="alternate" hreflang="en|fr|x-default"` for the
pair, English as the default), and `https://umasbooks.org/sitemap.xml` lists both addresses of every page
(home, the marketing pages, Contact, Events, Sessions, Request a book and every in-stock book), each with
its `xhtml:link` alternates. `robots.txt` is unchanged and allows `/fr/`. Admin, cart, login, account and
members pages have no French address and stay out of the index. The sitemap is cached for an hour.

**Google Search Console** (free; needs a Google account that stays with the shop, ideally the shop's own):

1. Go to `https://search.google.com/search-console` and sign in.
2. Click the property picker (top left) > **Add property**.
3. Choose **Domain** (left box), type `umasbooks.org`, click **Continue**. Google shows a `TXT` record.
4. Add that record where the DNS of `umasbooks.org` is managed (the registrar's DNS page > **Add record** >
   type **TXT**, host `@`, value = the text Google gave), save, wait a few minutes, then click **Verify**
   in Search Console. (If you prefer, choose **URL prefix** `https://umasbooks.org/` and verify with the
   HTML tag or file method instead; the sitemap steps below are the same.)
5. In the left menu click **Sitemaps**. Under **Add a new sitemap** type `sitemap.xml` and click **Submit**.
   **Status** should become **Success** within a day, with a number of discovered pages (about twice the
   number of pages plus twice the number of in-stock books).
6. Later: left menu **Pages** (or **Indexing > Pages**). Check that `/fr/` addresses appear under indexed
   pages. **International targeting** no longer exists in Search Console; the `hreflang` tags are what
   count. If a page is listed under "Alternate page with proper canonical tag", that is right for the
   cookie-French copy of an English address.
7. Optional but quick: left menu **URL inspection**, paste `https://umasbooks.org/fr/` and click
   **Request indexing**; do the same for `https://umasbooks.org/`.

**Bing Webmaster Tools** (also feeds DuckDuckGo, Ecosia and others):

1. Go to `https://www.bing.com/webmasters` and sign in with a Microsoft account (or **Import** the site from
   Google Search Console in one click: choose **Import from GSC** and allow access; the sitemap comes along).
2. Without import: click **Add a site**, type `https://umasbooks.org`, click **Add**, and verify with the
   DNS `CNAME` record Bing shows (same DNS page as above) or the HTML tag option.
3. Left menu **Sitemaps** > **Submit sitemap**, type `https://umasbooks.org/sitemap.xml`, click **Submit**.
   Status **Success** can take a day.

**Checks you can do yourself (no tools needed).** Open `https://umasbooks.org/fr/` in a private window with
the browser set to English: the page is French and **FR** is highlighted. View source and look for
`rel="canonical" href="https://umasbooks.org/fr/"` and three `hreflang` lines. Open
`https://umasbooks.org/sitemap.xml` and search the page for `/fr/`. In Search Console the **URL inspection**
tool shows "User-declared canonical" for any address you paste.

**If a French page is missing from Google** after a few weeks: URL inspection > look at "Page indexing".
"Crawled, currently not indexed" is Google's choice (low traffic site, thin page): it improves with inbound
links and time. "Alternate page with proper canonical" is normal for the English copy of a page Google
prefers in French or the reverse. A "Page with redirect" entry for `/fr` (no slash) is also normal: it is a
301 to `/fr/`.

### Check the real client IP

Do this once after the deploy that introduced `TRUST_PROXY_HOPS`, and again if
you ever change how traffic reaches Render (a new DNS set-up, a CDN or proxy in
front of Render). Rate limits, the per-IP reservation cap and the admin activity log
all depend on the app seeing the visitor's real address and not a proxy's.

**What is in front of the site.** `umasbooks.org` DNS is at **Squarespace
Domains** and points straight at Render (an `A` record to `216.24.57.1`). The
`cloudflare` header you can see in a response is **Render's own edge** (Render
uses Cloudflare technology): the association has **no Cloudflare account** and
nothing to configure there, unless someone adds one later. The app sets its own
`Cache-Control` headers; the edge reports `cf-cache-status: DYNAMIC` for
everything, i.e. it caches nothing. **If a real CDN or caching rule is ever put
in front of Render, the chain of proxies changes: re-do this check and adjust
`TRUST_PROXY_HOPS` before relying on rate limits again.**

1. Log in as an admin, on your **phone on mobile data** (wifi off), and open
   `https://umasbooks.org/admin/diagnostics/client-ip`.
2. Search "what is my IP" in another tab. The **req.ip** line must be exactly
   that address (your carrier's public IP).
3. Do the same from **home wifi** (a laptop or phone on the wifi). Again
   **req.ip** must be your own public IP, **not** an address of the hosting
   edge (Render/Cloudflare ranges).
4. If it is wrong: Render > `umas-books` > Environment > add or change
   **`TRUST_PROXY_HOPS`** (a Render environment variable), save, wait for the
   redeploy, repeat from step 1. Normal value 2. If req.ip is still an edge
   address, try 3; if it shows an address that is not yours but
   neither is it an edge address, try 1. Never set it higher than needed: too many
   hops let a visitor choose their own IP.

5. **Check BOTH addresses, before launch.** Since the live site answers any
   request that is not for `umasbooks.org` with a redirect (page views) or
   `421 Misdirected Request` (form posts, anything but a page view), the
   direct Render address can only be checked **while the site is still in
   preview mode** (`PREVIEW_MODE` set). Repeat steps 1 to 3 on
   `https://umas-books-cmvv.onrender.com/admin/diagnostics/client-ip` first,
   then on `https://umasbooks.org/...`. On the Render address **req.ip** must
   also be your own public IP (the chain there is shorter, so with a wrong hop
   count a visitor could choose their own IP). After launch the Render address
   only answers `/healthz` and the HelloAsso webhook; this is intended.

### Rolling deploys and `?v=` file addresses

Pages link their scripts and styles as `/file.js?v=<hash>`, and such a URL is cached for a year. During a deploy, old and new instances overlap, so a visitor can get old HTML (pointing at `?v=old`) from one instance and the file from another. Rule: a release must **add** the new files (they get a new `?v=`) and must not delete or rename a file that the previous release's HTML still links, until the next release. The marketing pages' scripts are `public/page-*.js` and `public/page-i18n.js`.

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
| `PRICING_AI_DAILY_MAX` | Most online lookups per day (Paris time), default `150`. It is counted in the database (one atomic counter, section ae), so restarting the service does not reset it and parallel requests cannot exceed it. `0` stops all lookups. Every lookup also counts against the shared `AI_DAILY_MAX_CALLS` (section ae). |
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
- **Reprice after the pricing change (migration 085):** the migration only
  updates the pricing *settings* (and only values still at the old defaults);
  it never changes a book's price. After deploying, an admin opens **Pricing
  rules > Reprice** and confirms groups A (Trade to EUR 5), B (Mass Market to
  EUR 5) and C (EUR 8 to EUR 10) one by one. Each confirmed group is one
  transaction, one **Admin activity** row (`pricing.reprice`) and a CSV of
  before/after prices per copy (kept in `price_reprice_items`, so it can be
  downloaded again from the run page).
  **Confirming is exact:** the Confirm button posts the number of copies and a
  fingerprint of the copies it previewed; if anything differs when you press it
  (a copy sold, reserved or newly eligible) nothing is applied and you get a
  fresh preview. The preview counts copies that go **up**, **down** or stay the
  same and lists the first 25 of each (group A also raises hand-priced copies
  below EUR 5 up to EUR 5: check that list). **Undo this run** (button on the
  result page, newest run only): a preview first, then confirm; it puts the
  previous price (and suggestion history) back **only** on copies still at the
  price the run set and still in stock, so a copy sold, reserved or re-priced
  by hand since is left alone; it is written to Admin activity as
  `pricing.reprice.undo`. The CSV (`old_price` column) remains for anything
  the undo left alone.
- **To start fresh for one book** (its cached online price looks wrong): in the
  database, `DELETE FROM price_lookups WHERE isbn = '<the 13-digit ISBN>';`.

## i) Awards and best-seller lists on books

When a book is added, the website looks up awards and best-seller lists in
the background (a few seconds, up to a couple of minutes) and shows them on the
book page as "Awards & lists". Old books are filled in gradually.

**What customers see.** Every stored entry: found on Wikidata, found on the
New York Times best-seller list, or typed by an admin. There is no review step
and no AI source.

**Volunteer how-to**

1. **One book:** admin > Books & Reservations > the book > **Awards & lists**. You see
   every entry and where it came from. **Re-check now** looks again on Wikidata
   and the New York Times. **Add awards (comma separated)** adds your own, for
   example `Booker Prize (2019), Prix Goncourt (1999)`; they show at once, and you
   can remove the ones you typed. Entries found automatically cannot be removed
   by hand.
2. Everything you add, remove or re-check is written to *Admin activity*.

**Settings** (all optional; Render dashboard > the `umas-books` service >
**Environment** > these are *environment variables*, not secrets in GitHub):

| Variable | What it does |
|---|---|
| `NYT_API_KEY` | New York Times best-seller history. Get a free key at developer.nytimes.com (create an app and enable the *Books API*). Without it that source is simply skipped. |
| `AWARDS_LOOKUPS` | Set to `off` to stop all lookups at once. |

The old `AWARDS_AI`, `AWARDS_AI_DAILY_MAX` and `AWARDS_AI_MODEL` variables do
nothing any more; delete them in Render if they are set.

**Known limits.** Wikidata coverage is patchy: no entry means "Wikidata does
not know", not "this book won nothing"; type the award in yourself if you know
it. A lookup that fails (internet problem, a limit reached) is tried again after
a day. Only the book's ISBN is sent out; no member or customer data.

## k) Reservations, collecting and paying in the shop, refunds

**How it works.** A customer with an account reserves books (and drop-in seats)
on the website. **Nothing is paid online.** The customer comes to the shop
(Rue Peyrolière, Wednesday to Saturday, 14:00 to 19:00), and you take the payment
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
  shop address and how to cancel; it is a reservation, not a proof of purchase), a reminder on
  day 10, a short "your reservation has ended" email if it lapses (no penalty),
  and a reminder 24 hours before a reserved drop-in seat.
- You get one email "N reservations expiring within 2 days" (once per
  reservation); the dashboard's **Needs attention** box also lists reservations
  expiring within 3 days.

Everything is on **admin > Books & Reservations > Reservations** (`/admin/orders`). It opens
on **Reserved: awaiting pickup**. The **Show** menu has **Expiring in 3 days**,
**Expired**, **Paid**, **Refunded**, **Cancelled** and the other lists; **Search**
finds a reservation by number, email or name.

### A customer comes to collect a reservation

1. Ask for the name or the reservation number (it is in their email). Open
   admin > **Reservations** and search, or open the **Pickup list** (link under the
   filters, or `/admin/orders/pickup-list`): every open reservation grouped by
   customer, with the **shelf** of each book and the **amount to collect**.
   **Print version** (`/admin/orders/pickup-list?print=1`) is made for paper:
   print it in the morning and tick the books as you fetch them.
2. Fetch the books from the shelves (the reservation page also shows each copy's
   shelf).
3. Take the payment in the shop, then open the reservation (`/admin/orders/<number>`)
   and fill **Mark collected and paid**: choose **How did they pay?** (Cash,
   Card at the shop, Cheque or Other). **Amount received** is filled in with the
   total. You may only **lower** it (a discount given at the till), and then the
   note is required. Press **Mark collected and paid**.
4. What happens: the reservation becomes **Paid** and **Collected**, the books
   become **sold**, the sale counts in the dashboard and reports **from that
   day** (the day you press the button, not the day of the reservation), and the
   payment method and amount are kept on the reservation.
5. If the reservation is already past its deadline (red message on the reservation
   page) but the customer is standing in front of you with the books still on the
   shelf, you can still collect it.

**The customer takes only some of the books** (partial pickup). On the reservation
page use **Collect selected items**: tick the books being taken, choose how they
paid, press the button. The ticked books are sold and paid. The books left
behind move to a **new reservation** with the same deadline (the reservation page
then shows "Related reservations" linking the two). This button only appears
when the reservation holds more than one item.

**A drop-in seat**: the customer pays at the session. After the session, open the
reservation and press **Mark collected and paid** if you took the money (or
leave it: the seat is released by itself once the session is over, and a
reservation that is never collected simply ends as expired).

**At the till.** If you use the till (`/admin/till`), you can collect the
reservation there instead: type or scan **ORDER-** followed by the reservation
number (or scan the **UB- label** of one of its books). All its lines appear at
the reserved prices. Remove a line if the customer leaves that book or seat (a
partial pickup: the rest stays reserved on a new reservation with the same
deadline), then press **Cash** or **Card** as usual. The reservation is marked paid
with that payment method, exactly as if you had pressed **Mark collected and
paid** on its page. You can add walk-in books to the same sale. A till sale
that collected a reservation cannot be voided at the till: to undo it, open the
reservation and use **Mark refunded** after giving the money back.

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
and say which reservation holds it ("Not sold: ... is reserved by reservation #N. Open that
reservation to collect it ... or cancel the reservation first").

- **The reserving customer buys it:** collect the reservation as above.
- **Someone else wants that copy in the shop:** if the shelf has no other
  copy, ask the reserving customer, or cancel their reservation (**Cancel
  reservation**; tell them) and then sell the book normally with **Sell in
  shop**. Do not hand the book over before cancelling: the reservation would
  still show it as held.
- A book that is **not** reserved (In stock) is sold with **Sell in shop**
  exactly as before.

### Refund after collecting

A reservation is a free hold and the sale is made and paid in the shop, so the
site shows no withdrawal notice or form for books and seats (a legal review
asked for this; the lawyer is asked to confirm: `docs/legal-todos.md`, section
7). The terms say: "Used books are not taken back for a change of mind once
bought in the shop; the legal guarantees still apply." The legal guarantees
(a book that does not match its description) always apply, so **never refuse a
customer who writes about a book that does not match its description**: look at
the book and ask the association's adviser if you are unsure.

**The website cannot move money.** The refund is done **in the shop** (cash,
cheque or card), then you record it:

1. Read the customer's email to admin@umasbooks.org (a clear email is enough:
   no form is needed). Open the reservation: admin >
   **Reservations** > search. Check it is **Paid**.
2. Get the book back (it can be kept until the book is back, but never later
   than 14 days after the email) and give the money back: cash, cheque or card.
3. **Only after you gave the money back**, open the reservation and press **Mark
   refunded**. A confirmation page asks you to tick "I have already given the
   money back to the customer" and to write a note (for example "Withdrawal
   email 3 Oct, book returned 5 Oct, refunded in cash 5 Oct"). Confirm.
4. What the website does at once: the reservation becomes **Refunded**; the books go
   back **In stock** (a book already sold again is left alone); drop-in seats are
   released; the sale leaves the dashboard, the reports (a **Refunds** table in
   the sales report shows it) and the buyer's totals; the action is written to
   **Admin activity**. Pressing twice changes nothing.
5. Email the customer to confirm (the website does not), and put the book back
   on the shelf.

A **partial** refund (one book of several): do **not** press Mark refunded (it
would put **all** the books back on sale). Write a note in your own records and
ask the developer if you need the reservation split.

A reservation from before reservations existed that was **paid online on HelloAsso**
(old reservations only; none are created any more) must be refunded in the HelloAsso
dashboard (https://admin.helloasso.com) **before** you press Mark refunded.

### Other reservation buttons and lists

- **Show > Paid online and not collected (old reservations)** and **Cancel unpaid
  reservation** exist only for reservations from the old online checkout (before
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

You are told in four ways: an email "N emails could not be sent" (when a mail
gave up after 8 tries, at most one per hour), an email "N emails are stuck in
the outbox" (when any mail has been waiting **more than an hour**, at most one
every 6 hours, listing counts only), a **Needs attention** box on the admin
dashboard, and the list at Admin > **Email outbox**. If `GMAIL_USER` /
`GMAIL_APP_PASSWORD` are missing on the live site, sending **fails** with
"Email is not configured" (it is never marked "sent"): the rows stay queued and
go out after you set both in Render (section b).

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
   **Books & Reservations** > **Reservations**, find the reservation: it says "Confirmation:
   sent ..." or "NOT SENT". Click **Resend confirmation** (only for a
   reservation that is still open). The customer can also open the reservation
   page from their account page, which shows the same details.
4. A person never got an account link: ask them to use "Forgot password" again
   (or "Resend confirmation" on the login page) once mail works. Those mails
   lose their text as soon as they are sent, so they cannot be resent from the
   outbox; a new request creates a new link.

The text of sent emails is erased after 30 days (failed ones after 90): old rows
only show who/what/when.

Throttled mail is normal, not a fault: signup, forgot-password, membership
join and book-request mails go to a given address at most once per 10 minutes
per kind, five a day, with a shop-wide hourly cap (`THROTTLE` in
`umas-books/src/lib/outbox.js`). The person sees the usual neutral answer; the
server log line "Mail throttled (kind:reason)" counts them. If a genuine person
says no mail came, ask them to wait 10 minutes and look in spam before trying
again. A reset or confirmation mail that failed or whose link has expired shows
no text in the outbox (blanked on purpose) and cannot be retried: the person
asks again.

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
sale, in the reservation confirmation email, next to the cart total ("Prix TTC, TVA
non applicable") and under the price on every book page.

Once the accountant answers:

1. In the repository, open `umas-books/src/lib/legal.js` and set
   `VAT_NOTICE_ARTICLE` to the article only, without "art." and without "du
   CGI", for example `"293 B"`.
2. Bump `TERMS_OF_SALE_VERSION` in the same file to the day of the change
   (YYYY-MM-DD): the terms changed.
3. Make a pull request as usual. The line then reads, in all four places,
   "TVA non applicable, art. 293 B du CGI". Nothing else needs editing.

**The footer social links.** The Instagram icon shows the association's page
(`SOCIAL_LINKS.instagram` in `umas-books/src/lib/legal.js`); the Facebook icon next to it
shows `SOCIAL_LINKS.facebook` (the share link, without the `?mibextid=...` tracking
part; an empty value hides the icon). Use the clean address, without the `?...` tracking part.

**The shop opening hours.** Wednesday to Saturday, 14:00 to 19:00, set in ONE
place: the `SHOP_*` constants in `umas-books/src/lib/legal.js`. Every page,
email, reminder, the terms of sale and the structured data for search engines
read them. The shop may also open at other times when volunteers are available,
but only the regular hours are promised: the visit page says so and links to
Instagram (`SHOP_EXTRA_HOURS_NOTE_URL`), emails and terms say only the regular
hours are guaranteed. If the days or hours change, edit the constants and bump
`TERMS_OF_SALE_VERSION`.

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

### Test the scanner

1. Open **Till** in the admin menu: the cursor is in the big scan box.
2. Scan any label (or a book's barcode). **The code must appear in the box and
   the line must be added at once** (the scanner presses Enter by itself).
3. If the code appears but nothing happens, the scanner has no Enter suffix:
   see its manual ("add CR suffix"). If the characters are wrong (for example
   digits turn into symbols), the scanner is set to the wrong keyboard layout
   (set it to US layout, or the layout of the tablet).
   **The scanner suffix must be Enter, not Tab.** With a Tab suffix the cursor
   leaves the scan box after each code and two scans run together into one
   wrong code (for example `UB-12UB-13`). The Till page says the same at the
   bottom of the payment column.
4. The page keeps the cursor in the scan box by itself. After a mistake the
   screen shows a red message and beeps (untick "Beep on errors" to silence).

### Books with no ISBN

Old books, local editions and some second-hand books have no barcode. They work
like all others: **Add Book > "No ISBN? Enter the details by hand"**. Only the
title is required; type the author, genres, binding, condition and price
yourself (the price help says "Manual review": set the price by hand, or leave
it empty and enter it at the till). The till finds it by its copy code
(`UB-<number>`, the copy's number) or by searching its title.

### Open the day

At the start, on the Till page type the cash in the drawer (the **opening
float**) and press **Save opening float**. You can also do it on **End of day**,
and there you can enter the float of a **past day that was never closed** (open
that day with the date box, type the float, **Save opening float**).

### Selling

1. Scan each book (its label `UB-...`, or its own ISBN barcode). If a title has
   several copies in stock a big list asks which one (price, grade, place):
   tap it. Prefer the label: it is exactly that copy.
2. A copy with no price asks for one. For a **used** book you can change a
   price by tapping it (type the agreed price). Raising it by up to 20% needs no
   reason; **a lower price, or one more than 20% above, needs a reason** (kept in
   the admin activity log) and **only an admin can do it**. A book is never sold
   for 0 (only a manual **Donation** line can be 0). A **new** book must stay
   between 95% and 100% of the publisher's price (French fixed book price law):
   the till refuses anything else, and a discount on it also needs a reason.
   One sale is at most **EUR 10,000**: above that the till says "Sale total too
   large".
3. **Cash**: type what the customer gave (or tap Exact, 5, 10, 20, 50). The
   big green **Change to give** appears. Open the drawer, then **tap Confirm
   sale**. The Enter key never confirms a payment, and a barcode scanned while
   the Cash or Card screen is open is ignored (a note says "Finish or cancel
   this payment first"). When the Cash or Card screen opens, the till first
   checks the sale and shows any problem (a book sold meanwhile, a closed day...)
   **before** the customer pays.
4. **Card**: the screen says "Charge EUR x on the SumUp reader, then press Card
   paid". Charge it on the reader; when the reader says approved, press **Card
   paid** (you may type the last 4 digits or the terminal receipt number first).
   If the reader says refused, press Back and try again or take cash. If the
   till then cannot record the sale, see "The card was charged but the sale was
   not recorded" below.
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
"low" at 3 or fewer. The category (Merchandise, Refreshments, Donation, "Other
(not new books: scan new books so the price rules apply)", Other) decides which line of the accounting export it lands in. These
lines also say "TVA non applicable" on the receipt; there is no VAT calculation.

### Barcodes on items

An item can have a barcode so the scanner adds it: on its row of **Other stock
(not books)** click in the **Barcode** box and scan the item (the manufacturer's
code, 8 to 14 digits, is typed for you), then **Save**. Scanning it at the till
adds one; scan again for another one (or use + and - on the line). Items with
no barcode: press **Generate a shop code** (it becomes `ITEM-<number>`) and write the code on the item. Rules: each active
item needs its own code; a code cannot start with `UB-` (that is for books) or
look like `ORDER-<number>`; **a code that is also a book's ISBN is refused**
when you save the item (it would hide that book at the till: scanning would add
the item instead of the book). Use a shop code (`ITEM-<number>` or your own,
like `TOTE-GREEN`) for such an item.

### Voiding a sale

Only **today's** sales, only until the day is closed. On the Till page under
**Today's sales** open **Void sale**, type the reason (required) and confirm.
The books go back in stock and the sale no longer counts in reports. Older
sales cannot be voided: tell the treasurer.

**A card sale is not refunded by the till.** The void form says "This was a card
payment: refund it on the SumUp reader or app yourself". Refund the card in
SumUp, then tick **I refunded the card** (on the void form, or afterwards on the
Till page or **End of day**). Until it is ticked the voided sale shows in
**Needs attention** on the Dashboard and on End of day, so a refund cannot be
forgotten.

### If the internet is down

Write each sale on paper (what, price, cash or card, time). When the internet
is back, enter them (today or yesterday at the latest): on the Till, put the
books on the sale, open **Sale made earlier**, choose Today or Yesterday, type
the time it was really sold and **the reason** (required, for example "internet
was down"), then pay. Only an admin can do this. The sale keeps that time, the
admin activity log records the reason, and the sale is marked as entered later
(it is recognised by the moment it was typed in, not the time of the sale). If
that day was already closed, see "Reopening a closed day" below. Take only cash if the card reader needs the internet (or use the SumUp
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
   day's voids and refuses new sales for that day. If you never entered the
   opening float, the till asks you to tick "close with no opening float (counts
   as EUR 0)" (or save the float first). **Print summary** prints a plain end-of-day sheet; **Download
   CSV** gives the list of sales.
4. Keep the float for tomorrow in the drawer and take the rest to the bank.
   A day with sales that is not closed appears under **Needs attention** on the
   Dashboard.

### The card was charged but the sale was not recorded

This is the one situation where money and the till can disagree, so read it once.

- **Before the customer pays**, the Card screen checks the sale. If it shows a red
  problem (a book sold meanwhile, the day is closed, a price changed), **do not charge
  the card**: fix it first (Back, remove the line, rescan).
- **"The price changed: new total EUR x. For a card sale do not charge again: cancel
  the card charge on the reader and restart."** A price was edited between scanning
  and confirming, so the amount on the reader would not match the sale. **Nothing was
  recorded.** If the customer was already charged, cancel/refund the charge on the
  SumUp reader or app, press **Restart the sale**, rescan, and charge again.
- **"The card was already charged. Do NOT charge again."** (red box) means you pressed
  **Card paid** and the server refused or failed afterwards. The sale on the screen is
  kept (even if you reload the page). Read the message under the box, fix what it says
  (for example tick "Reopen this day" if an admin has to), then press **Record card
  sale** again: it checks the sale first and shows the reason. **Record anyway** sends
  the same sale again with the same total and no check in front: use it when the check
  itself keeps failing but you know the sale is fine, or ask an admin.
- "Connection problem" means the answer never arrived: pressing the button again is
  safe, the same sale cannot be recorded twice. If the server answered with an error
  (it says so, with a code), that is not a connection problem: follow the message.
- "This sale was already recorded with different items" means the screen was reused
  for another basket: reload the till page and start the sale again.

### Reopening a closed day

A sale (also one "made earlier") on a closed day is refused. If it must be recorded:
as an admin, open the Cash or Card screen, tick **Reopen this day to record this
sale** and type a reason; or press **Reopen the day** (with a reason) on **End of day**.
The day is open again, the counted cash is cleared and **you must close the day again**
after recounting. Both are written to the admin activity log (`till.day_reopen`) with
the old counted and expected cash. Late entries are shown on End of day ("sale(s) were
entered after the day was closed").

### Who can use the till (Till access)

An admin can give any account **Till access**: **Admin > Accounts**, open the account,
press **Till access: off (give)**. That account (for example a volunteer) then logs in
as usual and lands on the Till: it can scan, sell, void today's sales, tick card
refunds and look at End of day, **and nothing else**. Only admins can change a price
beyond the rule, enter a sale with an earlier time, reopen/close the day, enter the
float, manage quick items or open any other admin page. A Till-only account does not
need two-step verification (admins still do) but its till session ends after **8
hours without any till action**: log in again (and, like admins, after 7 days; see
"Admin sessions: how long they last"). Remove the access the same way; it
stops at once. The list shows a **Till** pill; **Reports > Accounts** shows "+ Till".

### Till void rules

A Till-only account has no two-step verification, so voiding is limited for it:

- **Card sales can only be voided by an admin**, and only an admin can tick
  **I refunded the card** (the Till-only account sees "Only an admin can void a
  card sale"). Ask an admin; they void it and refund the card on the SumUp
  reader or app.
- A Till-only account can void **today's cash sales**, with a reason of at least
  5 characters, **at most 3 per day each** (Paris day). The 4th is refused with
  "Ask an admin to void this one". Admins are not limited. To change the number,
  set the Render environment variable (service > **Environment**)
  `TILL_MAX_VOIDS_PER_DAY` (default `3`) and save; Render restarts the service.
- **Every void is visible:** the Dashboard's **Needs attention** lists each void
  made today (who, time, amount, cash or card, reason; "(till account)" marks
  a Till-only account), **End of day** has a **Voided sales** table (also in the
  printed page) and its CSV has the columns **Voided by** and **Voided at (Paris)**;
  the audit row `till.void` says "by till account" when it was one. There is no
  daily email of the till today, so look at the Dashboard when you open.

### "Sell in shop" is retired

The old page (Books & Reservations > Sell in shop) is gone: its address now sends you to the
Till with "Sales are made at the Till now". Old sales recorded there are kept and still
count in the reports and the accounting export.

### A book in an abandoned online cart

If you scan a copy that is "in someone's online cart" and the cart's hour has run out
(nobody paid), the till offers **Release this copy from the expired cart and add it**.
If the cart is still live it refuses and says how many minutes remain.

### The accounting export for the treasurer

**Reports > Accounting export**: choose the dates, then **Download CSV**
(comma separators and decimal points) or **Download for French Excel**
(semicolon separators, decimal commas, UTF-8 with BOM, Windows line ends: French
Excel opens it in columns with real numbers; the plain CSV opens as one column
of text in French Excel). The same two downloads exist on the End of day page
and on the other reports.

**Giving the export to the treasurer.**

1. At the start of each month download the previous month (first to last day)
   with **Download for French Excel** and send the file. Row layout: Date,
   Category, Payment method, Count, Total (EUR), Libellé, Compte débit,
   Compte crédit, Journal. One row per Paris day, category and payment method
   (Cash, Card at the till, Cheque, HelloAsso, Other / not recorded). Books and
   seats are reserved on the website and paid IN PERSON: a reservation collected
   at the till is counted once (from the till) and one collected with "Mark
   collected and paid" is counted under the method chosen there (cash, card,
   cheque, other). **HelloAsso rows are memberships only**, plus any old order
   paid online before reservations existed. It never contains names or emails.
2. **Refunds.** A refunded reservation keeps its row on the day it was paid and
   gets a **negative** row (negative count and total, label "Remboursement ...")
   on the day it was refunded (same category and method as the sale). A month already sent is therefore not changed:
   the correction is in the export of the month of the refund.
3. **Cash over/short.** When a day is closed with a difference, one row
   "Cash over/short" appears (positive: over, negative: short) with the accounts
   658 / 758. The opening float is never revenue and appears nowhere.
4. **Accounts.** The debit account, credit account and journal of each row come
   from **Reports > Accounting export > Accounts mapping**
   (`/admin/reports/accounting/mapping`), an editable table; each change is
   recorded in Admin activity. Starting values: cash 530; cards and HelloAsso
   511 (clearing account, to confirm: the treasurer may want 512); payment with
   no recorded method 471; Books used, Books new, Merchandise, Refreshments
   707; Class seats 706; Membership 756; Donation 754; Other 708; over 758,
   short 658. **These are only a starting point: ask the treasurer to confirm
   the account numbers and the import layout.** Nothing here was checked
   against Paheko or any other software.
5. Voided till sales and cancelled online reservations are not in the export.
6. The manual category "Other (not new books: scan new books so the price rules apply)" appears as Other (it is not mapped to Books used: see `docs/till-todos.md`).

### Later: the SumUp Cloud API

Today the card is charged by hand (`ManualCard`). The code is ready for a SumUp
implementation (`src/lib/cardPayments.js`) but nothing is connected and no
environment variable is read. When it is built it will need a SumUp API key and
a paired Solo reader as Render environment variables (names to be decided then).

## q) A data request (access or erasure)

Someone writes to admin@umasbooks.org asking what we hold about them, or to be
erased, with or without an account. The tool is admin > **Privacy requests**
(`/admin/privacy`). The privacy policy promises an answer within one month.

**1. Log it.** Add a line to `docs/privacy/requests-log.md` (date received, kind,
deadline). No names or addresses in that file, only a number.

**2. Check who is asking.** The request must come from the address concerned: reply
to the message and ask them to answer from that address, or to send proof they own
it (a message from it is enough). If they write from another address, ask for proof
(never accept a request for someone else's data without it, and never send data to
an address that was not the one on the request).

**3. Deadline.** One month from receiving the request (and the proof). It can be
extended by two further months if the request is complex or there are many, but you
must tell the person within the first month, with the reason.

**4. Search everywhere** (the tool covers the database only):
- Admin > **Privacy requests**: type the address > **Look up**. It lists accounts,
  reservations, book holds, event and class sign-ups, book requests, membership payments
  (and unmatched ones), stored emails (subject and date) and form mail.
- **The Gmail inbox admin@umasbooks.org**: search the address and the person's name.
  Contact, volunteer sign-up and pre-registration messages (a pre-registration holds a
  child's name and date of birth) live there, not in the database after 30 days.
- **Backblaze backups** are not searched: they age out by themselves (nightly dumps
  30 days, monthly 2 years). Tell the person that when you answer an erasure.
- Render logs hold no personal data by design (14 days).

**5a. Access.** Press **Download everything (JSON)** and send the file as an
attachment to the address (or a link that expires), plus any Gmail messages found.

**5b. Erasure.** Press **Erase everything for this address**, type the address again
and confirm. Accounts, sign-ups, reservations, book requests and stored emails are
deleted; sales and payment records stay for 10 years with the name replaced by
"Erased" (accounting law). Then delete the Gmail messages found (and empty the
Trash). An administrator's address is refused: remove the role in Accounts first.

**6. Answer and record.** Send the answer, and fill in the log line (date answered,
what was done). The audit entries (`privacy.lookup`, `privacy.export`,
`privacy.erase`) hold a code, never the address.

Answer templates (adapt the details):

*English, access:* "Hello, thank you for your request of [date]. We confirmed it came
from your address. Attached is a file with the personal data we hold about you
(accounts, reservations, sign-ups, requests). [We also found N emails in our mailbox, listed
below.] You can ask us to correct or erase anything. Uma's Books and Adventures, admin@umasbooks.org."

*English, erasure:* "Hello, thank you for your request of [date]. We have erased the
data held under your address, with one exception: sales and payments are kept without
your name, email or phone for 10 years because French accounting law requires it.
Backups containing older copies are deleted automatically within 30 days (nightly) and
2 years (monthly archive); they are never used. Uma's Books and Adventures."

*Français, accès :* « Bonjour, merci pour votre demande du [date]. Nous avons vérifié
qu'elle provient bien de votre adresse. Vous trouverez en pièce jointe un fichier avec
les données personnelles que nous détenons sur vous (comptes, réservations, inscriptions,
demandes). [Nous avons aussi trouvé N messages dans notre boîte mail, listés
ci-dessous.] Vous pouvez nous demander de corriger ou d'effacer toute donnée. Uma's Books
and Adventures, admin@umasbooks.org. »

*Français, effacement :* « Bonjour, merci pour votre demande du [date]. Nous avons
effacé les données liées à votre adresse, à une exception : les ventes et paiements
sont conservés 10 ans sans votre nom, e-mail ni téléphone, car la loi comptable
française l'exige. Les sauvegardes contenant d'anciennes copies sont supprimées
automatiquement sous 30 jours (quotidiennes) et 2 ans (archive mensuelle) ; elles ne
sont jamais utilisées. Uma's Books and Adventures. »

## r) When you receive an alert: what to do

Every alert email, who sends it, and the first three things to do. "Gmail
sender" means the Google account in `GMAIL_USER`; GitHub workflow emails say
"Uma's Books ... Monitor" in the sender name. All subjects start with
`[umas-books]`. If you get **none** of them for a long time that is also a
signal: the Monday test alert (section d) proves the channel works.

| Subject (starts with) | Sent by | Means | First three actions |
|---|---|---|---|
| `TEST alert - the alert emails work` | GitHub, every Monday | The alert channel works. **Missing on a Monday = broken** | 1. Check spam. 2. Section m) (Gmail password revoked). 3. Run **Actions > Send a test alert > Run workflow** and read the run for an error |
| `Site health check failing (status N)` | GitHub, every 30 min, on the 2nd failed check | The site is down, or up but cannot reach the database | 1. Open `https://umasbooks.org/healthz` (expect OK). 2. Render dashboard > `umas-books` > **Events** and **Logs**: a failed deploy? out of memory? 3. Render > the database `umas-books-db` is **Available**? If a bad deploy: section a) rollback |
| UptimeRobot "Monitor is DOWN" (`umasbooks.org/healthz`) | UptimeRobot, within 5-10 min | The site or its database does not answer | Same three actions as "Site health check failing" above. Planned work: **Pause** the monitor first (UptimeRobot > Monitors > pause icon), **Resume** after. A "Monitor is UP" email = recovered |
| `Site health check recovered` | GitHub | The outage is over | Nothing. Look in Render **Events** for the cause and note it |
| `Nightly database backup failed` | GitHub, 03:00 UTC | No new backup tonight (older ones are safe) | 1. Open the run link in the email, read the red step. 2. "settings are missing" = a `BACKUP_S3_*` or `DATABASE_URL` secret changed (section b). 3. After the fix: **Actions > Nightly database backup > Run workflow**, confirm green and a new file in Backblaze |
| `Database backups are NOT encrypted` | GitHub, every Monday while it lasts | The repository variable `BACKUP_AGE_RECIPIENT` is not set, so the dumps in Backblaze are readable by anyone who gets into the bucket | Section ad): do "Set up the encryption" once. The nightly failure email carries the same warning |
| `No fresh database backup in Backblaze` | GitHub, 09:00 UTC daily | The newest dump is missing, empty, over 36 h old, or (after the 3rd of the month) the monthly copy is over 35 days old. The monthly copy appears on the 1st (and the nightly job also writes one when none exists at all); before the first one, the freshness check shows a notice ("No monthly copy yet"), not a failure | 1. **Actions > Nightly database backup**: is it enabled and green? (GitHub disables schedules after 60 days of repository inactivity or when minutes run out: section t). 2. Run it by hand. 3. Re-run **Backup freshness check** |
| `Monthly accounting export failed` | GitHub, 1st of the month, 07:00 Paris | The accounting files of last month were not produced or not stored | 1. Open the run link, read the red step. 2. Settings missing = `DATABASE_URL` or a `BACKUP_S3_*` value changed (section b). 3. After the fix: **Actions > Monthly accounting export > Run workflow** (leave the month empty, or type `YYYY-MM`): the files are simply written again |
| `Backup restore test FAILED` | GitHub, 1st of the month | The newest dump could not be restored or lacks tables or migrations | 1. Open the run, read the red message (it says which table, or "dump is OLDER than the repository"). 2. Run **Nightly database backup** by hand, then **Monthly backup restore test** by hand. 3. Still red: do not trust the backups; ask a developer, and keep a manual dump (section u, step 2) meanwhile |
| `Error on GET /...` (or POST) | Gmail sender, the site | A page crashed (a 500). At most one per kind of error per 15 minutes | 1. Note the page and the time. 2. Render > **Logs**, search for the same time. 3. If it repeats or is on checkout/login, section a) rollback; otherwise send the text to the developer |
| `Unhandled rejection` / `Uncaught exception (process restarting)` | Gmail sender | The site hit an unexpected error and may have restarted | 1. Check `/healthz` and Render > **Events** (restart count). 2. Render **Logs** around the time. 3. Repeating = rollback (section a) and call the developer |
| `N emails could not be sent` | Gmail sender | Mails gave up after 8 tries over about 13 hours | Section l): 1. Admin > **Email outbox**, read **Last error**. 2. Fix the cause (usually section m). 3. **Retry now**, then **Mark failed as handled** |
| `N emails are stuck in the outbox` | Gmail sender | Mails have waited more than an hour (it repeats at most every 6 h) | 1. Admin > **Email outbox** > **Last error**. 2. "Invalid login": section m). "not configured": set `GMAIL_USER` and `GMAIL_APP_PASSWORD` in Render. 3. Wait a minute after the fix: queued mail goes out by itself |
| `Anthropic API credit has run out` (a test says `[TEST]` first) | Gmail sender, at most once per 24 h while it lasts | The Anthropic credit is used up: AI descriptions, French translation, genre suggestions, cover photo reading and price checks are off; scanning, saving, the till and reservations work | 1. console.anthropic.com > Settings > Billing: add credit. 2. Turn on auto-reload and a monthly limit. 3. Nothing to change in Render. See "AI usage", "Email alert: the Anthropic credit has run out" |
| `Background job failing: <name>` | Gmail sender | A background job failed 3 times in a row (one email per outage) | Section s): 1. Admin > `/admin/diagnostics/jobs`, read **Last error**. 2. Render **Logs**, search the job name. 3. If it is `Email outbox` see l); `Retention purge: ...` or `Membership ...`: call the developer, nothing customer-facing is lost yet |
| `Background job recovered: <name>` | Gmail sender | It works again | Nothing |
| `APP_BASE_URL missing` / `... (not https)` | Gmail sender, at most once per 24 h per problem | The live site has no correct public address: emailed links and payment returns are wrong | 1. Render > Environment: set `APP_BASE_URL` to `https://umasbooks.org`. 2. Save (it restarts). 3. The red banner on admin pages disappears |
| `HelloAsso is still in SANDBOX mode: real membership payments will not work` | Gmail sender, once per 24 h | `HELLOASSO_API_BASE` points at the test HelloAsso | 1. Render > Environment: delete `HELLOASSO_API_BASE`. 2. Check `HELLOASSO_CLIENT_ID/SECRET/ORG_SLUG` are the **production** ones. 3. Check a membership payment is recognised |
| `HelloAsso credentials missing: membership payments are disabled` | Gmail sender, once per 24 h | Membership payments are not recognised on a live site | 1. Render > Environment: add the three `HELLOASSO_*` variables (section b). 2. Save. 3. Check a recent membership is recognised |
| `N reservations expiring within 2 days` | Gmail sender, once per reservation | Reserved books are about to lapse | Section k): 1. Open the list it links to. 2. Contact the customers or extend/cancel. 3. Nothing else to do |
| `N online reservations not collected after 12 days` | Gmail sender | Old paid online reservations waiting for pickup | Section k) |
| `Membership payment from ... matches no confirmed account` | Gmail sender | Someone paid HelloAsso with an email no confirmed account uses | Section n) |
| `Startup seed failed (site still started)` | Gmail sender | The first-admin seed failed on boot; the site still runs | 1. Render **Logs** `[seed] FAILED`. 2. If an admin can log in, ignore until the developer looks. 3. If no admin exists, section c) |
| *(no subject you know)* Google "Security alert" / "Critical security alert" | Google | Someone signed in, or a password/app password changed | Check it was you; if not, change the Google password, revoke app passwords, then section b) for `GMAIL_APP_PASSWORD` |

**Admin pages show a red bar at the top** ("The live site is not set up
correctly", or "HelloAsso sandbox", or "PREVIEW MODE is ON"): it is the same
information as the alert, shown on every admin page for as long as the problem
exists. The launch alerts are emailed at most **once per 24 hours** (not once
per deploy); the bar stays until you fix the setting.

## s) Background jobs (retention purge, membership expiry, email retries...)

The site runs a handful of tasks by itself. Admin > open
`https://umasbooks.org/admin/diagnostics/jobs` (English; type the address, or
follow the link in the dashboard's **Needs attention** box). It lists each job
with: how often it runs, **Last run**, **Last success**, **Failed in a row**,
**Status** and the **Last error** (email addresses and long numbers are removed
from it).

**Expected:** every row says **OK** and the last success is within a few
intervals. A job is flagged **Needs attention** when it has failed **3 times in
a row** (you also get one email, then one more "recovered" email), or its last
success is older than **3 times its interval**.

**If a row needs attention:**

1. Read **Last error**. "timeout", "ECONNREFUSED", "HelloAsso ..." means an
   outside service was down: wait one interval and reload; it usually recovers.
2. Render > `umas-books` > **Logs**: search for the job name (for example
   `Retention purge: tokens failed`) for the full error.
3. Not an outside problem (a database error, the same error every time):
   copy the row and the log lines to the developer. Nothing the customers see is
   lost in the meantime, except that the job's work is not being done: for
   `Retention purge: ...` it means personal data is not being deleted on time,
   so do not leave it for weeks.

The jobs: Reservation expiry, Pickup reminders, Membership expiry, Membership
reconciliation (every 6 h); Order follow-up (6 h); Cart maintenance (10 min);
Email outbox (1 min); Order phone cleanup (6 h); Contact mailbox reminder (daily check, one email a month); Retention purge and one row per purge step, Image cleanup
(daily); Awards check (2 min); Cover backfill (5 min). A row for a job that no
longer exists stops flagging after 30 days.

### Retention rules (what is kept how long, and which job removes it)

Single table; the code constants are in `src/lib/privacy.js` (`RETENTION`) and
`src/lib/privacyMaintenance.js`. The public policy and
`docs/privacy/record-of-processing.md` must say the same; change them together.

| Data | Kept | Removed by |
|---|---|---|
| Buyer **phone** on an order | Until the reservation is collected and paid, cancelled or expired; at the latest 30 days after the order was made | Job `Order phone cleanup` (every 6 h, 500 rows per run) |
| Phone on a held book copy | While the hold lasts; at the latest 30 days | `Order phone cleanup` (and the hold ending clears it at once) |
| Name + email on a **paid** order, payment records | 10 years (accounting law); the phone is NOT part of this | `Retention purge: accounting` (daily) |
| Name + email + phone on a **cancelled / expired** (never paid) order | 30 days after the order was made, then anonymised (`Erased`) | `Retention purge: closedOrders` |
| Contact details on a closed or uncollected book hold | 30 days | `Retention purge: reservationContacts` |
| Buyer IP on an order | 2 days at most | `Retention purge: clientIps` |
| Event / class sign-ups | 12 months after the event | `Retention purge: signups` |
| Book requests | unconfirmed 7 days; open 12 months; closed 30 days | `Retention purge: bookRequests` |
| Copies of sent emails (outbox) | 30 days (90 if never sent) | `Retention purge: emailOutbox` |
| Admin action log | 12 months; free-text detail 6 months; administrator's email label cleared on erase | `Retention purge: auditLog`, `auditDetail`, `eraseMember` |
| Price-reprice run: administrator | Account id + role "admin" only (no email since migration 090); older labels cleared at 12 months | migration 090, `Retention purge: repriceActors` |
| Unconfirmed accounts / inactive accounts | 7 days / 3 years without login (warned 30 days before) | `unconfirmedAccounts`, `inactivityWarnings`, `inactiveAccounts` |
| Sessions | Guest 2 h (24 h with a cart); logged in 30 days; admin / till 8 h idle, 7 days at most | session expiry, `Guest session prune`, `lib/adminSession.js` |
| One-time page state (typed values after a refused form) | 10 minutes; dropped on the next request after that | `lib/flash.js` (`flashHousekeeping`) |
| Contact / volunteer / pre-registration emails in Gmail | 12 months | **Manual**, prompted by the monthly `Contact mailbox reminder` email |
| Render platform logs | 14 days on the Pro plan (Render docs: Hobby 7, Pro 14, Scale 30; the workspace is on Pro) | Render |
| Backups | nightly 30 days, monthly 2 years | backup job |

A test (`test/integration/privacyTidyUp.test.js`, "coverage") lists every column
that can hold a person's data and fails when a new table or column appears
without a decision (erased and exported, or allowed with a reason).

## t) GitHub Actions minutes (private repository)

The repository is private, so Actions minutes are metered: the **Free plan
includes 2,000 minutes a month**. Usage reached about **2,300 minutes in 6
days** and GitHub blocked the jobs twice for billing. When minutes run out,
**the backups, the uptime check and CI stop**. Every job is billed in whole
minutes (a 20-second job costs 1).

**Measured cost per run** (billed minutes, from the run history of 4-6
October 2026; a re-measure takes 2 minutes with `gh run list` / the Actions tab):

| Workflow | Runs | Billed minutes per run | Per month |
|---|---|---|---|
| CI (6 jobs: smoke-crawl 10, test 6, lint 1, migration-test 1, dependency-audit 1, secret-scan 1) | on every push to a pull request and every merge to main; about 50 a day in the busiest days | about **20** (docs-only change: about **6**; no smoke-crawl: about **10**) | the big one: 20 x number of pushes |
| Site uptime check | every 30 min = 48 a day | 1 | about **1,440** |
| Nightly database backup | daily | about 1-2 | about 45 |
| Backup freshness check | daily | 1 | about 30-60 |
| Monthly backup restore test | monthly | about 3-5 (estimate: one short run recorded) | about 5 |
| Send a test alert | weekly | 1 | about 4 |

**What was done to cut usage** (without changing the six required check
names): a pull request that only changes documentation skips the install and
the tests inside each job (they still report success, so merging is never
blocked); the **smoke-crawl** (the longest job) runs only when the app, views,
public files, migrations, scripts, package files, marketing pages or `.github/`
change, and always on every merge to `main`; a new push to a pull request
cancels the run still going; npm and the Chrome that the crawl downloads are
cached. Why not a `paths:` filter on the whole workflow: a skipped required
check stays "Pending" forever and blocks the merge.

**The uptime check stays at every 30 minutes** (1,440 minutes a month on its
own, most of the free allowance). To halve it, change the cron line in
`.github/workflows/uptime-check.yml` to `0 * * * *` (hourly: 720 a month, an
outage is still reported within about two hours), **now that** the free
external monitor (UptimeRobot, every 5 minutes, see section d) watches
`https://umasbooks.org/healthz`: it gives the fast detection and GitHub is the
independent second opinion. Do not
raise the frequency.

**Every month (1st, 2 minutes):**

1. GitHub > click your **profile picture** (top right) > **Settings** >
   **Billing and plans** > **Usage this month**.
2. Read **Actions** minutes used against the included amount (2,000 on Free).
3. Over 70% before the 20th, or any warning banner: look at **Actions** for a
   runaway workflow (many CI runs on one pull request), cancel it, and tell the
   developer; do not just buy minutes.
4. Make sure a **spending limit** exists: same page > **Spending limits** >
   **Actions** > set a monthly limit of at least **10 USD** (about 1,250 extra
   minutes at the Linux rate of 0.008 USD a minute), with an email alert at 75%. **With a limit of
   0 USD GitHub stops the workflows, including the backups, when the free
   minutes are used; a small limit costs little and keeps the backups running.**
   The best fix for the long term is to make the repository **public** (public
   repositories have unlimited minutes) *only if* it contains nothing private:
   it does not hold member data (the dumps are in Backblaze, the secrets in
   settings), but ask the developer to confirm before changing visibility.

## u) Rebuild everything if the Render account is lost

For: the Render account is suspended, locked, deleted, or its owner is not
reachable, and the site is gone. **The data is safe in Backblaze** (nightly
dumps, 30 days; monthly copies, 2 years); the code is on GitHub. **Time
needed: 2 to 4 hours** (most of it waiting for DNS and the restore). Do it
with a second person if you can. Have these ready: the password manager (section
v), the Backblaze login, the GitHub login, the Squarespace login, the HelloAsso
login.

**What you need and where each comes from** (also section v):

| Setting | Where the value comes from |
|---|---|
| `DATABASE_URL` | Render creates the new database; Blueprint wires it |
| `SESSION_SECRET` | Generated by the Blueprint (everyone just logs in again) |
| `TOTP_ENCRYPTION_KEY` | **The saved copy in the password manager** (section b). A new random key makes every admin's two-step secret unreadable: you would have to clear two-step for each admin (section c) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | You choose; only used if the database has no admin. With a restored database you do not need them |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Google Workspace admin (admin@umasbooks.org) > Security > App passwords (section m) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | console.anthropic.com > API keys (or the saved copy) |
| `ISBNDB_API_KEY` (optional) | isbndb.com > your account > API (section aa, "ISBNdb"). Added by hand in Render, not in `render.yaml` |
| `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG` | HelloAsso back office > your organisation > API / Integration |
| `HELLOASSO_MEMBERSHIP_FORM_SLUG` (optional) | The last part of the membership form's HelloAsso address |
| `APP_BASE_URL`, `CONTACT_TO`, `ALERT_TO`, `TRUST_PROXY_HOPS`, `COVER_BACKFILL` | Already set to sensible values by `render.yaml` |
| `PREVIEW_MODE` | **Not** in `render.yaml` on purpose. Leave it unset for the live site |
| GitHub repository secrets/variables (`DATABASE_URL`, `GMAIL_*`, `BACKUP_S3_*`, `ALERT_TO`, `SITE_URL`) | Section b table; the new `DATABASE_URL` is the **External** URL of the new database |

**Steps:**

1. **Make sure you have a dump.** Backblaze > Buckets > the bucket > folder
   `store-backups/full/` > the newest `umas_books_full_<date>.dump` (or from
   `monthly/`). Download it to a computer you control (README "Restoring from a
   backup" has the command-line version). Expected: a file of some megabytes.
2. **New Render account** (or recovered): render.com > Sign up/log in. Add a
   **payment method** (the plan in `render.yaml` is paid). Add a **second
   owner** straight away (section w).
3. **Blueprint:** Render dashboard > **New +** > **Blueprint** > connect GitHub
   (authorize the `umasbooksadmin/umasbookswebsite` repository) > pick the
   repo > Render reads `render.yaml` and proposes `umas-books-db` and
   `umas-books`. Fill the "sync: false" values from the table above >
   **Apply**. Expected: the database becomes **Available**; the first deploy of
   the service may fail or start empty: that is fine.
4. **Restore the data** into the new database: Render > `umas-books-db` >
   **Connect** > copy the **External Database URL**, then on your computer (with
   PostgreSQL 18 client tools, see the README):
   `pg_restore --no-owner --no-privileges --exit-on-error -d "<external url>" restore.dump`.
   If the database already has tables from the first deploy, drop and recreate
   it empty first (ask for help if unsure: never restore over data you need).
   Expected: no error output; it takes a few minutes.
5. **Deploy:** Render > `umas-books` > **Manual Deploy > Deploy latest commit**.
   The pre-deploy command `npm run migrate` applies any migration newer than
   the dump (the log shows "Running migration: ..." and "Migrations complete").
   Expected: **Live**, and `https://<service>.onrender.com/healthz` shows OK.
6. **Check the data:** log in at the `.onrender.com` address as an admin; the
   dashboard shows the books, accounts and reservations you expect.
7. **DNS at Squarespace:** Squarespace > **Domains** > `umasbooks.org` > **DNS
   settings** > edit the `A` record (host `@`) to the new service's address: in
   Render > `umas-books` > **Settings > Custom Domains** > add `umasbooks.org`
   and `www.umasbooks.org`; Render shows the exact IP / CNAME to use (the old
   one was `216.24.57.1`; a new service may have another). Remove the old
   record. Expected: Render's custom domain turns **Verified** and the
   certificate **Issued** within minutes to a few hours; `https://umasbooks.org`
   loads the site.
8. **HelloAsso webhook:** HelloAsso back office > your organisation >
   **Integration / API > Notifications (webhook)**: set the notification URL to
   `https://umasbooks.org/webhooks/helloasso` (the same as before; if the
   address did not change, nothing to do). Expected: a small test payment makes
   the reservation **Paid** and the confirmation email arrives.
9. **Real client IP check:** section "Check the real client IP" (in g): from your
   phone on mobile data, `/admin/diagnostics/client-ip` must show **your** IP;
   adjust `TRUST_PROXY_HOPS` if not.
10. **GitHub:** update the repository secrets/variables (section b table): the
    **External** `DATABASE_URL` of the new database. Run **Actions > Nightly
    database backup > Run workflow**: green, and a new file in Backblaze.
11. **Final checks:** `/healthz`, a login, a password-reset email, a small
    payment, the Monday test alert, `/admin/diagnostics/jobs` all **OK** after
    10 minutes.
12. **Write down what changed** (new service address, new owner) in section v.

## v) Accounts and secrets inventory

Fill this in once and keep it current (and a printed copy in the association's
safe). It lists **accounts and where access lives**, never the secrets
themselves (those live in the password manager). `TODO(the association)` =
unknown from the repository: someone with the login must fill the cell.

| Service | Owner account | Recovery email / phone | 2FA | Where the secret lives | Who else has access |
|---|---|---|---|---|---|
| **Render** (hosting, database) | TODO(the association): the login email of the Render account | TODO(the association) | TODO(the association) | Render dashboard > Environment; `TOTP_ENCRYPTION_KEY` copy in the password manager | TODO(the association): Render > Account/Workspace > Members (add a second owner, section w) |
| **GitHub** (code, backups schedule, alerts) | Personal user `umasbooksadmin` (owner of the repository `umasbooksadmin/umasbookswebsite`) | TODO(the association) | TODO(the association) | Repository secrets: `DATABASE_URL`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY`; variables: `BACKUP_S3_*`, `ALERT_TO`, `SITE_URL` | Collaborators (Settings > Collaborators): `sharonbje`, `MelinaHartley` (not admins). A personal account cannot have a second owner: consider moving the repository to a **GitHub organisation** with two owners |
| **Backblaze B2** (offsite backups) | TODO(the association) | TODO(the association) | TODO(the association) | Application key (keyID + applicationKey) in GitHub secrets; the master login in the password manager | TODO(the association) |
| **Squarespace Domains** (registrar **and** DNS for umasbooks.org; expires **2027-08-22**) | TODO(the association): the Squarespace account email | TODO(the association) | TODO(the association) | Password manager | TODO(the association) |
| **Google Workspace** (admin@umasbooks.org: mail, the sender of every alert) | The Workspace admin account (admin@umasbooks.org) | TODO(the association) | TODO(the association) | App password `GMAIL_APP_PASSWORD` in Render **and** GitHub; login in the password manager | TODO(the association): Admin console > Users > add a second **super admin** |
| **HelloAsso** (payments, memberships) | TODO(the association): the organisation's HelloAsso login | TODO(the association) | TODO(the association) | API client id/secret in Render | TODO(the association) |
| **Anthropic** (book photo scanning, descriptions) | TODO(the association): the console.anthropic.com account | TODO(the association) | TODO(the association) | `ANTHROPIC_API_KEY` in Render | TODO(the association) |
| **UptimeRobot** (external monitor: `https://umasbooks.org/healthz` every 5 min, free plan, alerts by email and app) | `sharonbje@gmail.com` | TODO(the association) | TODO(the association) | Password manager | TODO(the association): add a second alert contact (My Settings > Alert Contacts) |
| **Password manager** | TODO(the association) | TODO(the association) | TODO(the association) | Emergency kit in the safe | At least 2 people |
| **Site admin accounts** (the website's own admin area) | See Admin > Accounts (filter Admins) | n/a | Required in production; recovery codes in the password manager (section w) | n/a | n/a |

## w) Emergency access and "bus factor"

The risk: one person holds every login, gets ill or unreachable, and nobody
else can restart the site, read an alert or restore a backup. Do this once; it
takes an afternoon.

1. **A second owner on every service** (a second trusted person, with their own
   login, never a shared password):
   - **Render:** dashboard > the workspace > **Settings > Members > Invite** >
     role **Admin/Owner**. Expected: they receive an invitation and can see the
     `umas-books` service.
   - **GitHub:** the repository is owned by the personal account
     `umasbooksadmin`, so a second owner is not possible there; ask the
     developer to **transfer the repository to a GitHub organisation** (Settings
     > General > Danger zone > Transfer) with two owners, or at least keep a
     second person as an **admin collaborator** (Settings > Collaborators) and
     store the account's recovery codes (below).
   - **Backblaze:** Account > **Admin > Users / Sub-accounts**: add a second
     login (or share the 2FA recovery codes with the sealed envelope).
   - **Squarespace Domains:** the domain's account > **Settings > Permissions**
     (or the account's contributors): add a second person as **Admin**.
   - **Google Workspace:** admin.google.com > **Directory > Users** > make a
     second person **Super Admin** (Admin roles > Assign admin).
2. **Recovery codes in the password manager.** For every service above, turn on
   2FA, download the **recovery codes**, and store them in the shared password
   manager vault. For the **website's own admin accounts**, each admin saves
   the recovery codes shown when they set up two-step verification (the site
   shows them once). Check that two people can open the vault.
3. **The `TOTP_ENCRYPTION_KEY` copy** in the password manager (section b).
4. **A sealed envelope** (or the vault's "emergency kit") with: the password
   manager's master recovery, the domain registrar login, this runbook printed,
   and the name of the developer to call.
5. **Test once a year** (put it in the yearly calendar): someone other than the
   usual person logs into Render, GitHub, Backblaze, Squarespace and Google
   using only the vault.
6. At least **two admins** on the website itself (Admin > Accounts), and never
   demote the last one (section c).

## x) A lost or broken scanner

The till (section p) works **without a scanner**: every step also accepts the
barcode typed by hand.

1. **The scanner does nothing:** check it is plugged in / paired and charged;
   open Notes or the till's scan box and scan a book: the number should appear.
   If nothing appears, unplug and replug (or re-pair), then try another USB
   port. Section p) "Test the scanner" has the settings (it must act as a
   keyboard and press Enter after the code).
2. **It types but the book is not found:** the code is not in the system. Look
   the book up by title (Admin > Books & Reservations) or add it (a book with no ISBN
   gets a shop code, section p).
3. **Lost or broken for the day:** carry on typing the number printed under the
   barcode (digits only), or search by title in the till. A phone camera app
   that reads barcodes can show the number to type.
4. **Replace it:** any USB or Bluetooth **1D barcode scanner in keyboard mode**
   that reads EAN-13 and Code 128 works (no driver, no software); buy a spare so
   the shop never depends on one device. Keep the receipt for the accounts.
5. **Nothing to deactivate:** the scanner holds no data and has no login, so a
   lost one is only a hardware cost.

## y) A takedown or abuse report (forum posts, images)

Someone writes to say a **forum post, a picture, a book cover or a comment**
should not be on the site (insulting, private information, a copyright claim, a
child's photo, something illegal), or the forum's **Report** button sends you
an email.

1. **Act quickly, but first keep a record:** forward the email into a folder
   "Takedowns" and write down the date/time, who reported, and the page address.
   Take a screenshot of the content.
2. **Hide it first, decide after:** log in as an admin, open the thread in the
   **Forum**: an admin sees a **Hide** button on every post (and **Restore** on a
   hidden one). A hidden post is no longer visible to members, and the action is
   recorded in the admin activity log. For a **picture**: edit the item that shows it
   (announcement, blog post, charity, book) in the admin and **remove or
   replace the image**; the unused image is deleted by the daily cleanup after
   7 days (Admin dashboard > unused images). Expected: reload the public page
   in a private window: the content is gone.
3. **Serious cases** (a minor, threats, personal data such as an address or a
   phone number, apparent illegal content): hide it **at once**, do not
   forward or reply publicly, and tell the association's president the same day.
   If personal data was shown to others, also note it in
   `docs/privacy/breach-log.md` (it explains when the data protection authority
   must be told, within 72 hours). A person who asks for their own data to be
   erased: see the privacy page and `docs/privacy`.
4. **Answer the reporter** within a few days: that it was removed (or why it
   was not), without naming the author. Keep it short and polite.
5. **The author:** if the post broke the forum rules, you can disable or
   delete the account from Admin > Accounts (it is in the admin audit log).
6. **A copyright or legal letter** (formal notice, a lawyer, the police): do not
   answer alone; remove the content, keep the letter and call the president
   and, if needed, the association's insurer or lawyer. The legal contact
   details are on the "Mentions légales" page.
7. **Record it:** one line in the association's "incidents" list (date, what,
   action). The audit log (Admin > Admin activity) already shows who hid what.

## z) Making database changes safely (notes for developers)

Migrations are files `umas-books/migrations/NNN_name.sql`, applied **once, in
filename order**, in Render's pre-deploy command (`npm run migrate`), before the
new code takes traffic. A unit test fails the build if two files share a
number, a number goes backwards, or a number is skipped that is not on the
known list (049, 051, 052, 061, 064). Take the next free number **after
fetching `main` and checking open pull requests** (`gh pr list`), and rename
yours if another one merges first.

**Expand, then contract.** The old code keeps serving until the deploy
finishes, and a rollback runs the **old code against the new database**.
So a migration must be **additive (expand)** in the release that needs the old
code to keep working: add tables, columns (nullable or with a default),
indexes (`IF NOT EXISTS`). **Destructive steps ship in a later release**
(contract): drop a column, rename, add a NOT NULL, or delete data only after
the release that stopped using it has been live and stable. Never rename a
column in one step: add the new one, write both, backfill, switch reads, and
only later drop the old one.

**Lesson from migration 059** (covers on our own server): it moved every
external cover address in one step and the background job then marked covers
as "failed" during an outage of the cover host, so they were not retried. The
fix was in two parts: keep the old value as a retry source (expand), and count
only real failures (404, a placeholder, an invalid image) as failed attempts,
never a 5xx, a timeout or a network error. Apply the same thinking to any
backfill: *an outage must never be recorded as a permanent result*.

## aa) Fast scanning of books (adding stock)

For adding many books in a row: **Books & Reservations > Scan a book** (the **Add Book** page,
`/admin/inventory/new`). Details of what the page does: `umas-books/README.md`, "Fast scanning".

### The on-screen keyboard does not come up on an iPhone or iPad

The page never hides the keyboard: tapping any box (Title, Author, Location, Price, Description) opens it, and the
cursor goes back to the ISBN box by itself only when no other box is in use (a fix made when this was reported).
The usual cause is the scanner: **a Bluetooth scanner in keyboard (HID) mode counts as a hardware keyboard, and
iOS then does not show the on-screen keyboard.** The Add Book page has a small "On-screen keyboard not showing?"
help line under the ISBN box on touch screens (it cannot detect the scanner; no page can do that reliably).

Ways to get the keyboard back (the first three are from Apple's documentation, the last are general):

- **AssistiveTouch**: Settings > Accessibility > Touch > AssistiveTouch, switch it on. Then tap the floating button >
  Device > More > **Keyboard** to show the on-screen keyboard while the hardware keyboard is connected.
- **Keyboard button (iPad)**: with a hardware keyboard attached, tap a text box and use the keyboard icon on the
  shortcut bar / bottom right, if it is shown.
- **Turn the scanner off, or turn Bluetooth off** (Settings > Bluetooth), type, then switch back on and scan.
- **Scanner modes (general; check your scanner's manual for "keyboard toggle")**: many scanners can be set, with a
  setup barcode in the manual or a trigger-key press sequence, to toggle the virtual keyboard, or to switch between
  HID (types like a keyboard) and SPP/serial. In SPP mode the scanner sends nothing to Safari: it needs a vendor app,
  so scanning into this page needs HID mode. Brands such as Eyoyo, Netum, Inateck, Socket Mobile and Tera differ;
  steps are not given here because they depend on the model.
- If the phone uses its **camera** (no scanner connected) and the keyboard is missing, reload the page, tap the box
  once more; if it still fails, note the iOS version and tell the developer.

### Scan speed (how fast Add a book is, and the knobs)

What happens, in order, and what was slow. **Looking up** (the ISBN typed or scanned): the catalogs are asked
**at the same time**: Open Library first, the French national library (BnF) for French ISBNs, Google Books, and
Open Library's second service when the first has nothing; the answer is given as soon as one is complete (title, author,
publisher, year), or 0.3 s after the first title, or after 4 s ("Catalog is slow right now: fill in by hand, or scan
again"). An ISBN-10 and its ISBN-13 are both tried. Answers are kept in memory for 10 minutes ("not in any catalog" for 2),
so scanning the same book again, or saving a book just looked up, asks nobody. The cover preview and the price are
fetched in parallel and each is given a short wait (1.2 s and 3 s): a slower one is left out of that answer
(the preview has no cover; the price then comes from the shop's rules alone) and finishes in the background.
**Saving**: the copy is written and the page answers at once; the cover download, the search for a cover, the
description (AI) and its French translation, and the awards check all happen **after** the answer
(`src/lib/bookFill.js`). Nothing already stored is overwritten; a cover that could not be fetched keeps its source
address for the 5-minute cover job. Before this change the save waited for all of it (3 to 20 seconds per book).

Measure it: every answer of `GET /admin/inventory/lookup` and `POST /admin/inventory` carries a `Server-Timing`
header (browser developer tools > Network > the request > Timing; for example `catalog;dur=640, cover;dur=410,
price;dur=3, total;dur=1100`), and a request slower than 1.5 s is written to the Render log as `[slow scan.lookup]`
or `[slow scan.save]` with its steps. To time the real services from a computer: `node scripts/profile-lookup.js`
(hit rate and p50/p95 for 36 real ISBNs, no database needed) and `node scripts/profile-scan.js` (lookup then save, needs a
scratch database: never a real one).

Settings (all optional environment variables; the defaults are right):

| Variable | Default | What it does |
|---|---|---|
| `SCAN_LOOKUP_TIMEOUT_MS` | `4000` | give up on the catalogs after this long |
| `SCAN_LOOKUP_HEDGE_MS` | `1500` | send Open Library's request a second time if the first has not answered by then (`0` = off) |
| `SCAN_LOOKUP_GRACE_MS` | `300` | after the first title, wait this long for the others to fill in missing fields |
| `SCAN_LOOKUP_SOURCES` | `openlibrary,bnf,google,openlibrary-data,isbndb` | which catalogs to use; remove one to switch it off (ISBNdb also needs its key) |
| `SCAN_CACHE_TTL_MS` | `600000` | memory of answers (and downloaded covers); `0` = no memory |
| `SCAN_NEGATIVE_TTL_MS` | `120000` | memory of "not in any catalog" |
| `SCAN_COVER_WAIT_MS`, `SCAN_PRICE_WAIT_MS` | `1200`, `3000` | how long the lookup waits for the cover preview / the price check (`PRICING_AI`) |
| `SCAN_SLOW_LOG_MS` | `1500` | requests slower than this are logged (`off` = never) |
| `GOOGLE_BOOKS_API_KEY` | none | optional: Google's free keyless use is capped and often answers "quota"; a key from Google Cloud (Books API) removes that |

If it still feels slow, note **which step** (after typing the ISBN: the lookup; after pressing Save), the device, and
the seconds, then look at the `Server-Timing` header of that request: the biggest number is the culprit.

Where the book facts come from, and what each source's rules allow: Open Library, the BnF and Google Books are free
services used as their documentation describes, with a User-Agent that names the shop and an address to write to; nothing is stored beyond
the fields the app already keeps for a book.

#### Which catalogs are used: the report "Book lookup sources used"

**Reports** > **Book lookup sources used** (`/admin/reports/lookup-sources`; also linked from **Diagnostics** > Book lookup
sources) counts, for each catalog, how often the Add a book lookup used it. **What it is for:** deciding whether Google
Books or ISBNdb (paid) is worth keeping, and spotting a catalog that is slow or refusing (quota, wrong key).

How to read it. Pick a **Period** (Today, Last 7 days, Last 30 days = default, This month, All time). Per source:
- **Asked**: times the catalog was called (a call that was never made, for example ISBNdb while paused, is not counted).
- **Supplied the title**: its answer was the one whose title was used (the first catalog, in priority order, that had a title).
- **Only filled missing fields**: another catalog gave the title; this one added something missing (author, publisher, year, description...).
- **Answered, nothing new**: it had the book, but nothing of it was needed.
- **Found nothing**: it does not know the ISBN. **Errors / timeouts**: it failed or was too slow. **Refused (429/401/403)**: quota reached, key refused.
- **Cut short**: the answer was already given and the site stopped waiting for it (not an error).
- **Average response (ms)**: how long it took when it did answer.
- Rows "Answered from memory (cache)" and "Not found: filled by hand" count lookups answered without any catalog, and lookups where no catalog gave a title.
- **Totals**: lookups, found-with-title rate, cache hit rate, not found, and the **ISBNdb paid calls this calendar month** (whatever the period).
  Compare that number with your ISBNdb plan: **check your ISBNdb plan quota** on isbndb.com; the site does not know it.
A rule of thumb: a catalog whose "Supplied the title" and "Only filled missing fields" stay near zero over a month or two costs time (or money)
without helping; one with many "Errors" or "Refused" needs attention (see ISBNdb below, and the diagnostics page for the live status).
The page has a table per month and per day, and **Download CSV** (the "Per source" table by default; the Per month and Per day tables
have their own link). Counts only.

How it works and its limits. The scan path adds to counters in memory (`src/lib/lookupStats.js`); they are saved to the table
`lookup_source_stats` about every 30 seconds and when the site stops, so a lookup never waits for the database and a
failure to save is only logged once ("Lookup statistics: could not be saved ...") and retried. A restart can lose
at most the last ~30 seconds. The report saves the counters of the instance it runs on first; if the site ever runs on
several instances, each saves its own, and the report adds them up. Nothing personal is stored: no ISBN, title or user
(see `docs/privacy/record-of-processing.md`, section 11b). Daily rows older than 36 months are deleted by the daily job
"Lookup statistics retention" (`/admin/diagnostics/jobs`).

#### ISBNdb (optional, paid): finding books the free catalogs miss

ISBNdb has the largest ISBN database but is a paid service. It is **off** unless `ISBNDB_API_KEY` is set. It has two jobs:
(1) a **last resort** for the title, author, publisher and year: asked only when the free catalogs found no title or left something out;
(2) the **suggested publisher's price** for a **New** book (see "Suggested publisher's price" below). A complete free answer costs
nothing, so the paid calls stay few. Nothing else changes: remove the variable and it is off again.

1. Sign up at isbndb.com > Pricing, choose a plan (check ISBNdb pricing and the plan's daily quota there), and create the API key (account page > API).
   You must do this yourself; nobody else should hold the key.
2. Render dashboard > umas-books > Environment > Add Environment Variable: `ISBNDB_API_KEY` = the key (a secret: it is never shown on a page, never logged, never sent to a browser).
   Do the same on the test system (`umas-books-staging`) if you want it there. Save: Render restarts the site.
   Keep a copy of the key in the password manager (section b).
3. Premium plans use another address: also add `ISBNDB_API_BASE` = the host shown in your ISBNdb account (for example `https://api.premium.isbndb.com`).
   Only an `https://...isbndb.com` address is accepted; leave it unset for the usual `https://api2.isbndb.com`.
4. Check: **Admin > `/admin/diagnostics/lookup`** shows ISBNdb as "Key set", then "Working" after the first lookup that needed it,
   or **"Key refused"** (wrong key or subscription lapsed) or **"Quota reached"**. The person scanning never sees these; the lookup simply goes on without ISBNdb
   (paused 30 minutes after a refusal, 1 minute to 30 minutes after a quota answer).
5. Speed limit: at most one request a second (`ISBNDB_MIN_INTERVAL_MS`, default `1000`; raise the speed only if your plan says so). A request that would wait more than 2.5 s is skipped.

**Where the key goes:** Render dashboard > the **umas-books** web service > **Environment** > `ISBNDB_API_KEY` (an environment variable, not a
GitHub secret or variable; never put the key in a file or in chat). **How to read the quota:** the site does not know your plan. Check isbndb.com > your account for the daily/monthly quota;
**Reports > Book lookup sources used** shows "ISBNdb paid calls this calendar month" (title lookups and price suggestions both count), and
**`/admin/diagnostics/lookup`** shows the live status ("Working", "Key refused", "Quota reached", "Paused until...").

##### Suggested publisher's price (prix editeur) for New books

New books are sold at the publisher's printed price, so on **Add Book**, when **Condition** is **New** and **Publisher's price** is empty, the page asks ISBNdb
for the book's list price **after** the title lookup has filled the form (a separate request: scanning and saving are never slowed or blocked) and shows,
under the field, for example: *"Suggested from ISBNdb: 8.99 USD = about EUR 8.25. Check the price printed on the book."* with a **Use this price** button.
- **Nothing is ever filled or saved by itself.** The field changes only when you press **Use this price**; you still press Save. Always check the
  price printed on the book (French fixed book price law). For imported English-language books, check with your accountant how the fixed-price rule applies to them.
- No price (or a price of 0, or an unknown currency): "ISBNdb has no price for this book: type the price printed on the cover." Type it as before.
- Conversion: the euro figure uses the **exchange rates on Admin > Pricing** ("1 US dollar in euros", default 0.92; "1 British pound in euros", default 1.15). They
  are approximate and editable: update them from time to time. A price already in euros is used as is. Other currencies are treated as "no price".
  The result is rounded to the nearest 0.05 euro.
- Cost control: one paid request per ISBN, remembered **3 days** (a "no price" answer too; kept in memory, so a site restart forgets it), and only for New books:
  a used book never causes a request. The title fallback's answer already contains the price, so it costs no second request. It obeys the same pauses
  as above (401/403: 30 minutes; 429: as ISBNdb says), and when ISBNdb is paused the page simply says it could not be reached for a price.
- What ISBNdb sends (checked 19 Oct 2026 in its published OpenAPI description and client libraries; the live docs page needs a browser): `msrp` (a number
  with no currency, documented as the USD list price and marked deprecated) and a newer `list_price`/`listPrice` object with `amount` and an ISO `currency`.
  The site uses the object when present and otherwise `msrp` as USD. The merchant `prices` list (extra paid plan, slower) is not used.

What ISBNdb's terms (isbndb.com/terms-and-conditions, read in October 2026) permit: a subscriber may use the data to run its own site and shop,
show it to its own users, and download, store and cache it "to the extent necessary" to operate that site **while the subscription lasts**.
It may not be redistributed, resold, handed over in bulk, or used to build a database or product of its own for others. What the app does:
results live in memory for minutes only; only the fields the app stores for a saved book (title, author, publisher, year, description, genre,
binding) are used; **ISBNdb's cover images are never used or stored** (their terms say rights in covers stay with their owners); no scraping,
only the documented API with the key in the `Authorization` header. If the subscription ends, remove the key; books already saved keep the facts a person confirmed and saved.

### AI usage (what uses the Anthropic credit)

**Reports > Book lookup sources used** (`/admin/reports/lookup-sources`) has, under the catalog tables, an **AI usage** part: how often the
site called the Anthropic API (the paid AI service), per feature, over the same **Period** menu (Last 30 days by default), with a table per month
and per day and its own **Download CSV** links (tables `ai`, `ai_monthly`, `ai_daily`). Counts only: no prompt, title, ISBN, text, photo or person is stored.

**Red banner.** If Anthropic refused a call in the last 24 hours because the credit is used up, the top of the page shows
"Anthropic API credit ran out at <time>: top up at console.anthropic.com > Billing". Top up there (Settings > Billing > buy credit, or turn on
auto-reload so it cannot run dry again), then wait: the banner disappears 24 hours after the last refused call, and the **Credit balance too low / billing**
column keeps the count. Nothing needs restarting.

**What each feature costs in calls**

| Feature | One call each time... | Notes |
|---|---|---|
| Description | a book is added or saved with no description, or **Generate** is pressed on the book's page | the biggest everyday user: every book saved without a description |
| French translation | a description is translated to French (right after a description is generated, when a book is saved with an English description only, and by the French back-fill script) | one call per description |
| Genre suggestion | genres are suggested for a book that has none, and by the French back-fill script | small calls |
| Cover photo reading | an admin uploads a photo of a cover or barcode (the camera "photo" path of Scan a book) | the most tokens per call: the photo counts as input |
| Price check (web search) | a price suggestion needs an online check (only when `PRICING_AI` is on); capped by `PRICING_AI_DAILY_MAX` (150 a day), cached 30 days per ISBN | the most expensive per call: long input, web searches billed on top |

**Columns.** Calls made = Succeeded + Failed (error: timeouts, no connection, other HTTP errors) + Refused (rate limit, HTTP 429) + Credit balance too low / billing
(HTTP 400/402 whose message mentions the credit balance, or error type `billing_error`). Input and output tokens come from the `usage` field of each answer;
**Web searches** from `server_tool_use.web_search_requests`. **Average response (ms)** is how long Anthropic took.

**The cost estimate.** It is computed from the token counts only, with the prices kept in one object, `AI_PRICES`, at the top of `src/lib/aiUsageStats.js`
(currently `claude-haiku-4-5`: 1 USD per million input tokens, 5 USD per million output tokens; last checked 2026-10-09; euros at the rate in the price settings).
It is **a floor, not the bill**: web searches are billed on top and are not priced here, cache tokens (the site does not use them) are not priced, and if
`PRICING_AI_MODEL` is set to another model the Price check estimate is wrong. **Check Anthropic's price list** when the model changes, and compare with the
invoice at console.anthropic.com > Billing (Usage shows the same by day). To change a price, edit `AI_PRICES` (and its date) and deploy.

**When the credit is out, what keeps working:** scanning by ISBN (the catalogs are free), saving a book (with no description), the till, reservations,
the shop pages and everything else. Only the AI extras stop: descriptions, French translations, genre suggestions, reading a cover photo (type the ISBN
instead) and online price checks (the price rules still suggest a price). Books saved meanwhile simply have no description; press **Generate** later.

**If a feature uses far more than expected**, look at the daily table for the day it started, then at that feature's row: many calls with few
successes means retries on errors; very large input tokens on Cover photo reading means large photos. To stop the price check at once set `PRICING_AI_DAILY_MAX=0`
(or `PRICING_AI` off); to stop everything remove `ANTHROPIC_API_KEY`. The counts are saved about every 30 seconds (a restart can lose the last ~30 s),
rows older than 36 months are deleted by the daily job "AI usage statistics retention" (`/admin/diagnostics/jobs`). This page itself sends nothing; the credit alert below does.

#### Email alert: the Anthropic credit has run out

**What it is.** The moment Anthropic refuses a call because the credit is used up ("credit balance is too low", or a billing error), the site emails
the alert address (`ALERT_TO`, else `CONTACT_TO`, else admin@umasbooks.org: the same as every other alert) with the subject
`[umas-books] Anthropic API credit has run out`. It says what stopped (descriptions, French translation, genre suggestions, cover photo reading, the AI
price check), what still works (scanning by ISBN, saving books, the till, reservations) and how to fix it.

**How to fix it.** console.anthropic.com > Settings > Billing: add credit, turn on **auto-reload** and set a **monthly limit**. Nothing to change in Render and
nothing to restart; the AI features come back by themselves.

**The 24-hour rule.** At most ONE email per 24 hours while the problem lasts (the "anthropic-credit" row of the `alert_flags` table, the same mechanism as the
launch-guard alerts; it holds across restarts). A call that works again deletes that row, so the next outage alerts at once, even the same day. No "working again" email
is sent. If the mail itself cannot be sent (Gmail down), the next refused call tries again instead of waiting 24 hours.

**Where else it shows.** A red line "Anthropic API credit ran out at <time>" in the Dashboard's **Needs attention** box, and a row in **Diagnostics > Background jobs > Alerts sent**
(with the time it was last sent). Both disappear after the next successful AI call (the next book saved without a description, for instance). The red banner on the
report (above) is separate: it stays 24 hours after the last refused call.

**Test it.** **Reports > Book lookup sources used > Anthropic credit alert > Send a test credit alert**: the same email once, with `[TEST]` in the subject. Once a minute at most;
recorded in **Admin activity** as `ai.credit_alert_test`. It does not create the red dashboard line. If the test mail does not arrive, see "Emails are not arriving".

**What it never contains:** the API key, or anything Anthropic answered beyond the fact that the credit is out. Sending never slows down or blocks an AI call or a save.

### The barcode scanner must send Enter

A scanner like the one at the till is a keyboard: it types the digits and then a key
called the **suffix**. For this page the suffix must be **Enter** (carriage return).
Test it: click in the ISBN box, scan a book: the book should be looked up by itself.
If the digits appear but nothing happens, the scanner sends no suffix: either set
it to Enter (scan the "Add Enter suffix" barcode in the scanner's manual; the same
setting as for the till, section p), or just wait: the page also looks up on its
own 150 ms after a complete ISBN. A scanner that adds Tab instead of Enter moves the cursor
to the next field: set it to Enter.

### On a phone

- **iPhone (Safari):** the keyboard only opens when you **tap** a box. When the page
  opens or after a redirect the cursor blinks in the ISBN box but iOS keeps the
  keyboard closed: tap the box once. After **Save and add another** the cursor goes back
  to the ISBN box from the same tap, so the keyboard stays up. A Bluetooth scanner
  needs no on-screen keyboard at all.
- **Add it to the home screen** (Safari > Share > **Add to Home Screen**) to get a full
  screen page without the browser bars, then sign in once.
- **Landscape** gives two columns on a wide phone or a tablet; portrait is one column.
- The page never zooms on tap (all fields are 16 px or bigger). If it does, send a screenshot.
- Location, Source, Binding and Condition are the **last ones you used** (the browser on
  that device remembers them; the first time ever: Store, Donation, Other, Very Good). If a
  wrong one appears, it is the one remembered from the last book: pick the right one once.

### If something is wrong

- "No connection" under the ISBN box: the form still works by hand; scan again when
  the Wi-Fi is back. If a Save says "No connection", check the book list before saving again
  (it may have been saved).
- "Not found: fill in by hand": Open Library does not know the ISBN. Type title and author.
- "Too many lookups": the limit is 120 a minute per person; wait a minute.

## aa) Test system (staging)

### What it is

A second copy of the website on Render, **completely separate from the real
site**: its own web service (`umas-books-staging`), its own **empty** database
(`umas-books-staging-db`), the same code. Use it to try a change (or rehearse
the launch) before the real site gets it. It has no custom domain: its address
is the `https://umas-books-staging-xxxx.onrender.com` address Render shows on
the service page. It is deliberately safe to break.

What the code does on the test site (all switched on by one setting,
`APP_ENV=staging`; the real site does not have it and behaves exactly as
before):

- **No real email, ever.** Every message the site sends (confirmations, reset
  links, reminders, contact form, admin alerts and digests) is sent to **one**
  address, `STAGING_MAIL_TO`. The subject starts with `[STAGING]` and ends with
  `(to: the original recipient)`; the first line of the body says the same. If
  `STAGING_MAIL_TO` is empty, nothing is sent at all (the Render log says
  `[staging] STAGING_MAIL_TO is not set - email NOT sent`).
- **A red banner on every page**: "TEST SITE: not the real Uma's Books" (French:
  "SITE DE TEST : ce n'est pas le vrai site d'Uma's Books"), and a note at the top
  of every admin page. Search engines are told to stay away (`noindex`,
  `robots.txt` says `Disallow: /`, empty sitemap).
- **HelloAsso sandbox only.** The service **refuses to start** (clear message in
  the Render logs, deploy shown as failed) if HelloAsso credentials are set and
  `HELLOASSO_API_BASE` is not the sandbox address.
- **Cannot touch the real database.** `PRODUCTION_DATABASE_HOST` is
  **required**: the service (and its migrate and seed steps) refuse to start
  when it is missing or empty ("PRODUCTION_DATABASE_HOST is not set" in the
  Render logs), and when the staging `DATABASE_URL` is that host. Setting it
  is the lock itself, so a forgotten value cannot leave staging unprotected.

### One-time set-up (about 20 minutes)

The staging resources are in **`render.staging.yaml`**, a separate file that the
existing Render Blueprint does not read: merging it creates nothing and costs
nothing. They exist only after you do this once. **Cost:** a web service plus a
paid Postgres database, billed by Render every month (check Render pricing
before step 4; the free Postgres tier is deleted after 30 days, so the file asks
for the cheapest paid one).

1. **Prepare the values you will type** (they are secrets or private):
   - `STAGING_MAIL_TO`: your own email address, the only one the test site may
     write to.
   - `GMAIL_USER` and `GMAIL_APP_PASSWORD`: a **separate** Gmail account used
     only for the test site and its app password (Google account > Security >
     2-Step Verification > App passwords). Do **not** reuse the real shop's
     sender or password. Without them the test site cannot send even the
     redirected mail.
   - `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`: the test site's first admin.
     Use your own email and a **new** password that is not the real site's.
   - `PRODUCTION_DATABASE_HOST`: Render dashboard > `umas-books-db` > **Info** >
     the **Hostname** (starts with `dpg-`). It is not a password; it is the
     lock described above, and it is **required**: the service refuses to start
     without it.
2. Render dashboard > **New +** > **Blueprint**.
3. Pick the repository `umasbooksadmin/umasbookswebsite`. Give the Blueprint a
   name such as `umas-books-staging`, **Branch** `main`, and set **Blueprint
   file path** to `render.staging.yaml` (not the default `render.yaml`).
4. Render lists what it will create: the service `umas-books-staging` and the
   database `umas-books-staging-db`. Check that it does **not** mention
   `umas-books` or `umas-books-db`. Fill the six boxes Render shows
   (`STAGING_MAIL_TO`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SEED_ADMIN_EMAIL`,
   `SEED_ADMIN_PASSWORD`, `PRODUCTION_DATABASE_HOST`: all **secrets**, typed in
   Render, never stored in the repository), then **Apply** (Deploy Blueprint).
5. Wait for the first deploy (a few minutes). Open the service
   `umas-books-staging` > its address at the top. You should see the red banner.
6. **Delete the seed password**: `umas-books-staging` > **Environment** > the bin
   icon next to `SEED_ADMIN_PASSWORD` > **Save**.

Where each setting lives (see the comments in `render.staging.yaml`):

| Setting | What it is | Value |
|---|---|---|
| `APP_ENV` | Render environment variable (in the file) | `staging` |
| `PREVIEW_MODE` | not set (on purpose) | Reservations and the membership form work on the test site. The banner, noindex and robots rules come from `APP_ENV=staging` anyway. Add `PREVIEW_MODE=true` (staging service > Environment) only to rehearse the "coming soon" mode |
| `NODE_ENV`, `TRUST_PROXY_HOPS` | Render environment variables (in the file) | `production`, `2` (same as the real site) |
| `HELLOASSO_API_BASE` | Render environment variable (in the file) | the HelloAsso **sandbox** address |
| `DATABASE_URL` | Render environment variable, wired to the staging database | automatic |
| `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY` | Render environment variables, generated by Render | different from the real site |
| `STAGING_MAIL_TO`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `PRODUCTION_DATABASE_HOST` | **Secrets** (`sync: false`: you type them in Render) | yours |
| GitHub settings | none | the nightly and monthly Backblaze backup workflows and the uptime check are GitHub Actions for the **real** site only; they never touch the test site |

Not copied on purpose: the real `ANTHROPIC_*`, live `HELLOASSO_*`, `ALERT_TO`,
`CONTACT_TO` and `APP_BASE_URL` (the test site uses its own address; alerts and
contact mail would be redirected to `STAGING_MAIL_TO` anyway). HelloAsso
**sandbox** credentials (`HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`,
`HELLOASSO_ORG_SLUG`) can be added later in `umas-books-staging` > Environment,
only if you want to test membership payment.

### Create the first admin

Nothing is created with a default password. On the first start of an **empty**
database the seed (`npm run seed`, part of the start command, same as the real
site) creates one admin from the `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` you
typed (section c explains the mechanism: it only runs when no admin exists and it
never resets a password). It also adds a sample announcement and a sample charity
vote (no personal data). Then:

1. Open the test site > **Log in** with that email and password.
2. Enrol two-step verification when asked (admins must, as on the real site).
3. Delete `SEED_ADMIN_PASSWORD` (step 6 above) if you have not yet.

If no admin exists later (the password was too weak, the seed warned in the log):
`umas-books-staging` > **Shell** > `psql "$DATABASE_URL"`, then
`UPDATE users SET is_admin = TRUE WHERE email = 'you@example.org';` (section c).
Check the page title says `umas-books-staging` before typing anything in a Shell.

### Load fake data

There is no copy of the real data and there must never be one. The database
starts empty. Fill it by hand with fake data: add the test books of
`docs/testing/manual-test-scripts.md` ("Test data": real ISBNs, no people) in
Admin > **Add book**, and create throwaway accounts with made-up names such as
`Test Buyer` and addresses like `YOU+account1@gmail.com`. Their emails all land
in your `STAGING_MAIL_TO` mailbox anyway. To start again from scratch:
`umas-books-staging` > **Shell** > `psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"`, then
**Manual Deploy** > **Deploy latest commit** (migrations and the seed rebuild an
empty site). Do this only in the staging Shell.

### Demo people and reservations

A script fills the test site with **fake people and fake reservations** so you
can click through every kind of user straight away. It does **not** create real
books: scan those yourself with the ISBN lookup (Admin > **Add book**).

**It only works on the test system.** It refuses to run unless the service has
`APP_ENV=staging` (or, for the developer, `DEMO_ALLOW_LOCAL=1` with a localhost
database). It also refuses when `DATABASE_URL` is the production database, and
when the site holds more than 50 accounts and any of them is not a demo account
(that looks like real data). It sends **no email** and contacts no outside
service.

**Run it**

1. Render dashboard > `umas-books-staging` > **Shell**. Check the page title
   says `umas-books-staging` before typing anything.
2. Type `npm run demo:load -- --yes` and press Enter. (Without `--yes` it only
   prints what it would do and changes nothing.)
3. At the end it prints a **LOGINS** list: one random password per account.
   **It is shown once**: copy it into your password manager now. Only the
   scrambled form is stored. To set new passwords later:
   `npm run demo:load -- --yes --reset-passwords`. To choose one password for
   all five instead: set `DEMO_PASSWORD` (12 or more characters) in the Shell
   command and add `--password-from-env`.
4. Running it again is safe: nothing is created twice, existing accounts keep
   their password.

**What it creates** (everything is marked "demo")

| Account (all `@example.com`, confirmed, can log in) | Is |
|---|---|
| `demo.account@example.com` | account holder, not a member |
| `demo.member@example.com` | member, membership valid for a year |
| `demo.expired@example.com` | member whose membership **expired** a month ago |
| `demo.volunteer@example.com` | volunteer |
| `demo.account2@example.com` | second account holder |

No admin is created (the seed makes yours from `SEED_ADMIN_EMAIL` /
`SEED_ADMIN_PASSWORD`). Three reservations, made with the site's own
reservation and till code: an **open** one (`demo.account`), one that
**expires in 2 days**, inside the reminder window (`demo.member`), and one
**collected and paid in cash at the till**, with a receipt number
(`demo.account2`). They need books: when the shop has **4 or more real in-stock
copies** the open and expiring ones reserve real copies; otherwise the script
makes up to 3 clearly fake books called `DEMO Book One (fake)` ... with at most
6 copies. The paid one always uses a fake copy.

**Log in** at the test site's `/login` with an address above and its password.
Reservations show under **My account**; as admin look in **Reservations** and
the till receipts.

**Remove it**: Render > `umas-books-staging` > **Shell** >
`npm run demo:remove -- --yes`. It deletes the five accounts, their
reservations (open ones are released first, so real books go back on the shelf),
the till receipt of the paid one and the fake books. Real books, other accounts
and the admin are not touched. (The receipt counter does not go back, so the
next receipt number has a gap: harmless on a test site.)

**Good to know.** The expiring reservation is real for the site's reminder job:
within a day or so it may send the pickup reminder, which on the test site goes
to your `STAGING_MAIL_TO` mailbox (subject `[STAGING] ... (to:
demo.member@example.com)`). That is the reminder working, not the script
sending mail.

### Test an email

1. On the test site (not logged in) open **Contact** and send a message, or
   create an account with a made-up address (for example `nobody@example.test`).
2. Within a couple of minutes a message arrives in the `STAGING_MAIL_TO` mailbox,
   subject `[STAGING] ... (to: nobody@example.test)`. Links in it open the test
   site.
3. Nothing arrives: staging service > **Logs**. `STAGING_MAIL_TO is not set`
   means the variable is empty; a Gmail error means `GMAIL_USER` /
   `GMAIL_APP_PASSWORD` are wrong. Section l (outbox) works the same here.
4. If a mail addressed to a real person ever reaches that person, switch the test service off (Suspend) and tell the developer.

### Deploys and promoting a change to the real site

- The test site **redeploys by itself on every merge to `main`** (`autoDeploy`
  in `render.staging.yaml`).
- **Today the real site also redeploys on every merge to `main`.** Both start
  at the same moment, so the test site cannot protect production yet. To make
  production wait for you (optional; this was not changed by the staging pull
  request): Render > `umas-books` > **Settings** > **Build & Deploy** >
  **Auto-Deploy** > **Off** (the wording may differ slightly, for example
  "Auto-Deploy: No" or "Off"), **Save**. From then on a merge changes nothing on
  the real site until you press **Manual Deploy** > **Deploy latest commit**.
  Turn it back to on the same way. (Section a also covers rolling back.)
- Routine once production is on manual deploys: merge to `main` > wait for the
  test site to finish deploying > run the **staging smoke script**
  (`docs/testing/manual-test-scripts.md`, "Staging smoke script") > only then
  press **Manual Deploy** on `umas-books`.
- Database migrations run on the test site first (it has its own database), so a
  broken migration shows up there before it can touch real data.

### Costs

Two paid Render resources (one web service, one Postgres database), billed
monthly: **check Render pricing** for the current figures. To stop paying:
suspend or delete `umas-books-staging` and `umas-books-staging-db` in Render. The
test site is not backed up (it holds nothing worth keeping).

### What NEVER to do

- **Never copy real member data** to the test site: no restore of a production
  backup, no export of members, orders or emails, no real names or addresses
  typed in "just to see".
- Never paste a production secret (`TOTP_ENCRYPTION_KEY`, `GMAIL_APP_PASSWORD`,
  the live HelloAsso keys, `ANTHROPIC_API_KEY`) into the test service. The test
  site must not share the real site's database, Gmail sender or HelloAsso keys.
- Never point the test service's `DATABASE_URL` at `umas-books-db`, and never
  delete `PRODUCTION_DATABASE_HOST`.
- Never attach `umasbooks.org` (or any custom domain) to the test service.
- Never enter a real card on the test site.
- Never remove `APP_ENV=staging` from the test service.

## ab) Admin sessions: how long they last

Customers, members and volunteers stay logged in for up to 30 days. Visitors who
are NOT logged in get a much shorter session (`src/lib/sessionLifetime.js`): **2 hours**,
or **24 hours** while they have something in the cart. This is what keeps a flood of
anonymous page loads from filling the `session` table: expired rows are deleted every
15 minutes, a job ("Guest session prune", `/admin/diagnostics/jobs`) also deletes guest
rows that would outlive 24 hours, and one IP address can create at most 60 stored guest
sessions per 10 minutes (further cookie-less page loads from it get a 429 "Too many
requests" until the window passes; people who already have a session cookie are not
affected). Logging in switches the session to the 30 days above. **Admins and
Till accounts** are signed out sooner, so a forgotten laptop or a borrowed till
tablet cannot be used for long:

* **Idle limit: 8 hours** with no request at all (a whole shop shift fits). The
  last-activity time is saved at most every 5 minutes, so the real cut-off is
  between 7 h 55 and 8 h of silence.
* **Absolute limit: 7 days** after the login, even if the admin keeps working.

This applies on every page, not only `/admin`: an admin reading the public shop is
still an admin session. When the limit is reached the session is deleted and the
person is sent to `/login` with "You were signed out after a period of inactivity.
Please log in again." (also in French), and after logging in they return to the page
they had asked for. The Till and the book-scan page get a short JSON answer instead
(`401 {"error":"session_expired"}`) and show a red "Signed out" bar with a login
link; the sale on the Till screen is kept in the browser, so log in in the new tab,
press **I have logged in: continue**, and carry on. Nothing is lost silently.

**Changing the limits** (Render environment variables; Render > `umas-books` >
Environment, save, wait for the redeploy; both are optional):

| Render environment variable | Default | Allowed |
|---|---|---|
| `ADMIN_SESSION_IDLE_HOURS` | `8` | 0.25 to 72 |
| `ADMIN_SESSION_MAX_DAYS` | `7` | 1 to 30 |

A value outside the range, or not a number, is ignored (the default is used) and the
service log shows `[session] WARNING: ...` at startup. Deploying with new values does
not log anyone out by itself; the new limits apply at their next request.

**Testing it** (needs database access: Render > `umas-books-db` > Connect, or on the
test system). Log in as the admin to test, then make that session look old (it ends
at the admin's very next request):

```sql
-- idle: pretend the last request was 9 hours ago (use the admin's own session)
UPDATE session SET sess = (sess::jsonb || jsonb_build_object('adminLastActivity', (extract(epoch FROM now() - interval '9 hours') * 1000)::bigint))::json
 WHERE sess::jsonb -> 'user' ->> 'email' = 'ADMIN@EXAMPLE.ORG';
-- absolute: pretend the login was 8 days ago (replace adminLastActivity with adminLoginAt and '9 hours' with '8 days')
```

The automated test (`test/integration/adminSessionTimeouts.test.js`) does the same.
A person promoted to admin while logged in starts their 8 hours / 7 days at that
moment. Removing admin rights stops access at once anyway (see
`attachUser`); there is no "remember me" option for admins.

**Sensitive actions and passwords.** No admin action asks for the password again.
They are protected by a confirm box or a typed confirmation, and by the limits above:
erasing a privacy request (type the address), "Mark refunded" (tick a box), make or
remove admin, deactivate or erase an account, reset two-step, delete a book or copy
(each a confirm box). Closing the day only asks for the counted cash.

## ad) Encrypting the backups, restore drill, read-only backup user, yearly rotation

**What and why.** Each night GitHub dumps the whole database (members' names,
emails, addresses, orders, password hashes) and uploads it to Backblaze B2. Until
this section is done, those files are **readable by anyone who gets into the
Backblaze bucket**. With it, each dump is encrypted on GitHub's machine
*before* upload, with the tool `age` (https://age-encryption.org), using a
**public** key. The nightly job never holds the private key: only you do, and
only to restore. A file in Backblaze is then named
`umas_books_full_<timestamp>.dump.age` and is useless without the private key.

> **The private key is the backups.** If it is lost, every encrypted backup is
> unreadable, forever. Keep it in your password manager **and** one more place
> (below), and prove it works with the quarterly drill.

Where each setting lives (this is the part to get right):

| Setting | Type | Where | Needed by |
|---|---|---|---|
| `BACKUP_AGE_RECIPIENT` (public key, starts `age1`) | GitHub **repository variable** | GitHub > repository > Settings > Secrets and variables > Actions > **Variables** tab > New repository variable | nightly backup |
| `DATABASE_URL` (read-only user's address) | GitHub **repository secret** | same page, **Secrets** tab > edit `DATABASE_URL` | nightly backup |
| `BACKUP_AGE_IDENTITY` (private key) | GitHub **repository secret**, **optional, not recommended** | same page, Secrets tab | monthly restore test only |
| Backblaze lifecycle rules, default encryption, application key | **Backblaze bucket / App Keys settings** | Backblaze web console | Backblaze |
| Inbound IP rules (section f) | **Render database setting** | Render dashboard > `umas-books-db` | Render |

None of these is a Render **environment variable**.

### Set up the encryption (once, about 15 minutes, on your Mac)

1. Install the tool: open Terminal and run `brew install age`.
2. Make the key pair. Run:

   ```bash
   cd ~/Documents   # anywhere private; this file will be deleted at the end
   age-keygen -o umas-books-backup-key.txt
   ```

   It prints a line `Public key: age1....` (about 62 characters) and writes the
   private key into `umas-books-backup-key.txt` (a line starting
   `AGE-SECRET-KEY-`).
3. **Save the private key**, before anything else:
   - In your password manager, create a *secure note* "Uma's Books backup key
     (age)" and paste the **whole contents** of `umas-books-backup-key.txt` into
     it (`cat umas-books-backup-key.txt | pbcopy`, then paste; clear the
     clipboard afterwards).
   - Make **one more copy** somewhere different, so that losing the password
     manager or your laptop cannot lose the backups: for example a printed
     sheet in a safe place, or the shared emergency vault described in
     section w) (a second trusted person must be able to find it).
4. Set the **public** key in GitHub: repository > **Settings** > **Secrets and
   variables** > **Actions** > the **Variables** tab > **New repository
   variable**. Name `BACKUP_AGE_RECIPIENT`, value the `age1...` line (only that
   word, no `Public key:` text). This is a **repository variable**, not a secret.
   It is public by nature, so it is safe if it leaks. (Several keys can be given
   separated by commas or spaces, e.g. a second person's.)
5. Run **Actions > Nightly database backup > Run workflow**. In the run page,
   the summary says **"Backups are encrypted with age (1 recipient(s))"**, and
   the new file in Backblaze ends in `.dump.age`. If you pasted the wrong
   thing (for instance the private key) the run **fails** with a message,
   instead of uploading anything unencrypted.
6. Delete `umas-books-backup-key.txt` from the Mac (it is in the password
   manager now): `rm -P umas-books-backup-key.txt`.
7. Do the **restore drill** below once now, to prove the key opens a backup.
8. **Encrypt or remove the old unencrypted copies.** Files already in Backblaze
   stay readable. The `full/` ones disappear by themselves after 30 days
   (plus a day), but the `monthly/` ones stay up to 2 years. Either delete the
   old `.dump` files in the Backblaze console (**Buckets > Browse Files**; tick
   the files; delete; use "show all versions" so hidden old versions go
   too), or encrypt them first if you want to keep the history:
   download one, `age -r age1YOURPUBLICKEY -o X.dump.age X.dump`, upload the
   `.age` back to the same folder, then delete the plain one. The freshness
   check and the restore test accept both kinds meanwhile.

While `BACKUP_AGE_RECIPIENT` is **not** set the backup still runs (a missing
backup is worse than an unencrypted one) but says so loudly: a warning on every
run page, the line "backups are not encrypted" in any failure email, and a
reminder email every Monday.

### The monthly restore test and the private key (a decision)

Encrypted backups cannot be restored by GitHub unless GitHub has the private
key. There are two ways, and the choice is yours:

- **Default, recommended: no key in GitHub.** On the 1st of each month the test
  checks, *without decrypting*, that the newest file exists, that it starts with
  the age header, that it is not tiny, and that its size is within +/-50% of the
  previous month's copy. The run summary says plainly "No restore was
  performed". A truncated, empty or swapped file is caught; a file encrypted
  to the *wrong* key is **not** (only the drill proves that). You do the real
  decrypt-and-restore yourself **every quarter** (below).
- **Optional: full automatic restore.** Create a repository **secret**
  `BACKUP_AGE_IDENTITY` (Settings > Secrets and variables > Actions > **Secrets**
  > New repository secret) with the whole contents of the private key file.
  The monthly test then decrypts, restores into a scratch Postgres and runs the
  data checks, as it did before encryption. **The trade-off:** the private key
  now sits in GitHub, so whoever can read the repository's secrets (a hijacked
  GitHub account, a malicious workflow change) can decrypt *every* backup in
  Backblaze, which is exactly what the encryption was meant to prevent if only
  one of the two places leaks. It only restores the *newest* dump. If you want
  this anyway, keep the quarterly drill too.

Nothing needs to be set for the default.

### The restore drill (every quarter: 1 January, April, July, October; about 20 minutes)

On your Mac (needs `brew install age awscli postgresql@18`; use the
Postgres 18 tools, see "Restoring from a backup" in
[`umas-books/README.md`](../umas-books/README.md#restoring-from-a-backup)):

1. Download the newest file as in step 1 of that README section, e.g.
   `aws s3 cp s3://$BUCKET/store-backups/full/umas_books_full_<timestamp>.dump.age . --endpoint-url $EP`.
2. Get the private key out of the password manager into a temporary file only
   you can read, decrypt, and delete the key file straight away:

   ```bash
   umask 077
   pbpaste > key.txt          # after copying the secure note's contents
   age -d -i key.txt -o restore.dump umas_books_full_<timestamp>.dump.age
   rm -P key.txt
   ```

   A message such as "no identity matched any of the file's recipients" means
   the key in the password manager is **not** the one the backups were made
   for. That is the thing this drill exists to find: fix it today (check the
   `BACKUP_AGE_RECIPIENT` value against the `Public key:` of the key you hold;
   `age-keygen -y key.txt` prints the public key of a private key).
3. Restore into a scratch database and look at it, exactly as steps 2 and 3 of
   the README section (`createdb`, `pg_restore --no-owner --no-privileges
   --exit-on-error`, the counts query).
4. Clean up: `dropdb umas_books_restored; rm -P restore.dump *.dump.age`.
5. Note the date in the calendar entry.

### A read-only database user for the backup (once)

The nightly job should not log in as the database owner. Create a user that can
only **read**. In the Render dashboard open `umas-books-db`, copy the **External
Database URL**, and from your Mac run `psql "<that URL>"`, then (choose a long
password made of letters and digits only, so it needs no escaping, e.g. the
output of `openssl rand -hex 24`):

Run it connected as the **owner / application role** (the one in Render's own
`DATABASE_URL`, which also runs the migrations), not as a superuser:

```sql
CREATE ROLE backup_ro LOGIN PASSWORD 'PASTE_THE_RANDOM_PASSWORD' CONNECTION LIMIT 2;
ALTER ROLE backup_ro SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE umas_books TO backup_ro;
GRANT USAGE ON SCHEMA public TO backup_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_ro;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO backup_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO backup_ro;
```

Do **not** use `GRANT pg_read_all_data TO backup_ro`: on Render's managed
PostgreSQL the owner role is not a superuser, the grant does not take effect,
and `pg_dump` then fails with `permission denied for table users`.

Each `GRANT` must answer `GRANT` (and each `ALTER DEFAULT PRIVILEGES` must answer
`ALTER DEFAULT PRIVILEGES`); any `ERROR` or `WARNING` line means that grant did
not happen, so read it before going on. The first four lines cover everything
that exists today. The last two matter because tables created later by
migrations (run by the owner role) become readable by `backup_ro`
automatically; without them the backup would break at the next migration that
adds a table. `ALTER DEFAULT PRIVILEGES` only applies to objects created by the
role that runs it, so it must be run as the owner/application role that runs
the migrations (the role in Render's `DATABASE_URL`).

Check it before going further (all in the same `psql` session):

```sql
SELECT has_table_privilege('backup_ro', 'public.users', 'SELECT');   -- must be t
\ddp                                                                  -- lists the default privileges for backup_ro
```

(The Render database is PostgreSQL 18 and `umas_books` is its database name;
`render.yaml`. If Render refuses `CREATE ROLE` with "permission denied", stop:
keep the owner's address in the secret, and ask a developer. Do not work around
it.)

The connection string is the **External Database URL** with the user and
password replaced, keeping the host and database name:

```
postgresql://backup_ro:THE_RANDOM_PASSWORD@dpg-XXXXXXXX-a.frankfurt-postgres.render.com/umas_books
```

**Test the backup user before putting it in GitHub** (from your Mac, with the
real password; this only reads):

```bash
psql "postgresql://backup_ro:THE_RANDOM_PASSWORD@dpg-XXXXXXXX-a.frankfurt-postgres.render.com/umas_books" -c "select count(*) from users"
/usr/lib/postgresql/18/bin/pg_dump --schema-only -f /dev/null "postgresql://backup_ro:THE_RANDOM_PASSWORD@dpg-XXXXXXXX-a.frankfurt-postgres.render.com/umas_books"
```

(Use whichever `pg_dump` is version 18 on your Mac, e.g. `pg_dump --version`.)
Both must finish without an error. The backup runs `pg_dump` with
`--exclude-table-data=session`, which skips the *rows* of the `session` table
but still needs to read its definition, so the user must be able to read the
`session` table (and every other table) too; the `GRANT ... ALL TABLES` line
covers it.

> **Troubleshooting: `permission denied for table ...` in the backup log**
> (for example `pg_dump: error: query failed: ERROR: permission denied for table users`
> followed by `LOCK TABLE public.users, ... IN ACCESS SHARE MODE`). It means
> `backup_ro` lacks `SELECT` on that table: the grants are missing or were never
> applied. The workflow's red annotation and the alert email point here. Fix:
> connect as the owner role, re-run the `GRANT` and `ALTER DEFAULT PRIVILEGES`
> lines above, check that every one answered `GRANT` / `ALTER DEFAULT PRIVILEGES`
> with no error, confirm `has_table_privilege(...)` returns `t`, run the two test
> commands above, then run **Nightly database backup** by hand.

Put it in the GitHub **repository secret** `DATABASE_URL` (Settings > Secrets and
variables > Actions > Secrets > pencil icon on `DATABASE_URL`; paste; Update).
The workflow just uses the secret, nothing in it changes. Then run **Nightly
database backup** by hand and check it is green and the new file has about the
usual size. `pg_dump` only reads, so this user cannot modify or delete data.
**Do not touch** `DATABASE_URL` in **Render**: that one is the owner's and
belongs to the website itself.

### Backblaze settings (once; these are Backblaze bucket settings)

1. **Lifecycle rules** (Buckets > the backup bucket > **Lifecycle Settings** >
   Use custom lifecycle rules). Two rules:
   - File Path `store-backups/full/`: *Days Till Hide* `30`, *Days Till Delete*
     `1`.
   - File Path `store-backups/monthly/`: *Days Till Hide* `730`, *Days Till
     Delete* `1`.
   The workflows rely on exactly these two folder names. (If you changed
   `BACKUP_S3_PREFIX`, use that instead of `store-backups`.)
2. **Server-side encryption** (same bucket page > **Default Encryption** >
   Enable, *SSE-B2*). It is an extra layer for Backblaze's disks; it does **not**
   replace the age encryption (the files are readable to anyone with a valid
   bucket key without it).
3. **The application key** (App Keys): limited to this one bucket. The console's
   "Read and Write" type also lets the key delete files; a key without the
   delete right (list, read and write only) can be made with Backblaze's `b2`
   command-line tool (`b2 key create --bucket <bucket> <name> listFiles,readFiles,writeFiles`)
   and means a leaked key cannot erase the backups. Optional hardening.
4. Bucket type **Private**, and no "Object Lock" is needed.

### Rotation and reminders

| When | What | Where |
|---|---|---|
| Every year (1 October), and straight away if anything leaks | New password for `backup_ro`: `ALTER ROLE backup_ro PASSWORD 'new';` in `psql`, then update the GitHub secret `DATABASE_URL`, run the backup by hand | Render database, GitHub **secret** |
| After Render restores or recreates the database (and after any change of the owner role) | Re-run the `GRANT` and `ALTER DEFAULT PRIVILEGES` lines for `backup_ro` (box "permission denied for table ..." above; recreate the role first if it is gone), check `has_table_privilege` returns `t`, run the backup by hand | Render database, as the owner role |
| Every year | New Backblaze application key, update `BACKUP_S3_KEY_ID` and `BACKUP_S3_APPLICATION_KEY` (section b), delete the old key | Backblaze, GitHub **secrets** |
| Only if someone who held the private key leaves, or it may have leaked | New age key pair (set-up steps 2 to 5 again). **Keep the old private key** as long as old backups exist (up to 2 years for `monthly/`, **10 years for `yearly/`**: see section ae), or re-encrypt those; add the new one to the password manager as a second note | GitHub **variable** |
| Every quarter | Restore drill | your Mac |

### Residual risk, plainly

Encryption protects the **copies in Backblaze**. It does not protect the live
database: the GitHub secret `DATABASE_URL` still gives read access to
everything in production from anywhere on the internet (Render's rule has to
allow GitHub, section f). The mitigations are the read-only user, a long random
password, yearly rotation, a private repository, and two-step verification on
the GitHub accounts: see the end of section f). A leak of the Backblaze keys
alone no longer exposes the data; a leak of the age **private** key *and* the
Backblaze keys does.

## ae) Keeping records for 10 years

French accounting records must be kept 10 years. The database backups alone
cannot do that (they are deleted after 30 days, and monthly ones after 2
years), so two more things are kept for 10 years. Everything below is automatic;
the owner steps at the end are done once.

### What is kept where, and for how long

| What | Where in Backblaze | How often | Kept | Encrypted? |
|---|---|---|---|---|
| Nightly database dump | `store-backups/full/` | every night, 03:00 UTC | 30 days | yes (age) |
| Monthly database dump | `store-backups/monthly/` | 1st of the month | 2 years | yes (age) |
| **Yearly database dump** | `store-backups/yearly/umas_books_full_YYYY-MM-DD.dump.age` | 2 January (Paris date), once a year | **10 years** | yes (age), the same file as that night's dump |
| **Monthly accounting export** | `accounting-exports/YYYY/accounting_YYYY-MM.csv`, `till_days_YYYY-MM.csv`, `summary_YYYY-MM.txt` | 1st of the month, 07:00 Paris: the previous month | **10 years** | **no**, on purpose: no personal data, readable without any key |
| **Yearly accounting export** | `accounting-exports/YYYY/accounting_YYYY-full-year.csv` (plus `till_days_` and `summary_` of the same name) | 2 January: the whole previous year | **10 years** | no |

The accounting export is the same file as **Admin > Reports > Accounting
export** (French Excel format: semicolons, decimal commas). `till_days_...` is
the end-of-day summary of the till, one row per day (opening float, cash
counted, difference, totals by method, first and last receipt number, closed
yes/no). `summary_...` is a short text: totals by account and method, number of
sales, refunds and voids, receipt number range, days not closed. None of them
contains a name, an email address or a phone number (the scripts refuse to write
a file that does). The two CSV files are also **emailed** on the 1st (to
`ACCOUNTING_TO`, else to `ALERT_TO`): save them in the accounting folder or in
Paheko. If last month is before October 2026, the email says the figures were
overstated (the accounting fix of October 2026, PR #265, stopped double counting
refunded reservations).

If a month's email or storage failed you get a `Monthly accounting export
failed` email (section r). To redo a month: **Actions > Monthly accounting
export > Run workflow**, month `YYYY-MM` (empty = last month). Running it again
overwrites the same files. The same page also exports for a month by hand when
you need it earlier than the 1st; the current month is refused unless
"allow_current_month" is ticked (a test only: it is not finished).

**Bootstrap test, once:** **Actions > Nightly database backup > Run workflow >
tick `force_yearly`**. It makes tonight's dump as usual, then also writes
`store-backups/yearly/umas_books_full_<today>.dump.age` and the accounting
export of the previous year (probably empty: the system started in 2026; you get
an email with only the header rows). This proves the path works before the real
one on 2 January 2027. A forced copy is labelled with the date it was made and
is kept 10 years like the others.

The Backup freshness check does **not** require a yearly copy. From January
2027, if there is none dated in the current year after 15 January, it adds a
yellow warning to its run (never a failure, no email).

### Owner steps (once, in this order)

1. **Backblaze lifecycle rules** (a Backblaze **bucket setting**: Buckets > the
   backup bucket > **Lifecycle Settings** > Use custom lifecycle rules). Add two
   rules next to the existing two:
   - File Path `store-backups/yearly/`: *Days Till Hide* `3650`, *Days Till
     Delete* `1`.
   - File Path `accounting-exports/`: *Days Till Hide* `3650`, *Days Till
     Delete* `1`.
   (If you changed `BACKUP_S3_PREFIX`, use that instead of `store-backups` for
   the first rule; `accounting-exports/` is always at the top of the bucket.)
   Without these rules nothing is ever deleted, which is safe but not tidy.
   Check that the existing `full/` (30) and `monthly/` (730) rules are still there.
2. **Optional, GitHub repository variable `ACCOUNTING_TO`** (GitHub > the
   repository > Settings > Secrets and variables > Actions > **Variables** tab >
   New repository variable): the treasurer's address, or several separated by
   commas. Not a secret. Unset = the files come to `ALERT_TO` (you).
3. **Make the age private key survive 10 years.** The yearly dumps can only be
   read with the private key from section ad). Keep **three** copies: (a) on
   paper, printed, in a safe or other safe place (the key is a few lines of
   text; print the file `umas-books-backup-key.txt`, and test that you can type
   or scan it back); (b) in the password manager; (c) on a USB stick kept apart
   from the computer. If you ever create a new key pair, **keep the old private
   key**: yearly dumps stay encrypted to the key that was current on that day.
   Calendar reminders: **every January** (after the 2nd) check in Backblaze that
   `store-backups/yearly/` has a file dated that January and that
   `accounting-exports/<last year>/` has twelve months plus `...-full-year`;
   **every October** (the yearly rotation day, section ad) do the restore drill
   with the newest `yearly/` file as well as a recent nightly one.
4. **Tell the accountant** where the files are: either give them access to the
   `accounting-exports/` folder in Backblaze (or send them a copy of a year's
   folder each January), or ask them to save the monthly emails in Paheko, or
   do it yourself on the 1st. The files are plain and readable for 10 years.
5. **If the association's financial year is not the calendar year**, tell me
   which month it starts in and set the repository **variable**
   `FISCAL_YEAR_START_MONTH` (a number 1-12, for example `7` for a year from
   July to June). The yearly export on 2 January then exports the most recent
   financial year that has fully ended (for `7` and January 2027: July 2025 to
   June 2026, stored as `accounting_2025-full-year.csv`, named after the year in
   which it starts). Months are not affected: the monthly files are always
   calendar months. Unset = 1 (the calendar year).
6. Run the **bootstrap test** above once and read the two emails/files that
   result.

## aa) Alphabetical order ignores a leading "The"

Wherever books are listed A to Z (the shop search, "More by this author", the admin
**Books & Reservations** list), a leading **The** is ignored: `The Hobbit` is listed
between `Hamlet` and `Hunger Games`. The title shown is never changed.

* Only the whole word "The" is ignored (any capitals), after any leading space, quote or
  bracket: `Theory of Everything` and `Theodore Rex` stay under T, and `"The Road"` goes
  under R. A title that is only "The" keeps its own place.
* **A**/**An** and the French **Le / La / Les / L'** are NOT ignored. To add them, the
  rule is one expression, in `migrations/086_books_title_sort.sql` (the `books.title_sort`
  column) and its twin `sortTitleKey()` in `src/lib/titleSort.js`; ask a developer.
* `books.title_sort` is a generated column: it updates itself when a title is edited,
  and there is nothing to run by hand. If a title looks mis-sorted, check
  `SELECT title, title_sort FROM books WHERE id = ...`.

## ac) Reviewing the French (and what to do when a French text is wrong)

The whole customer side (pages, messages after a form, emails) is French when a visitor picks
French; the admin screens and the emails sent to the admins stay English. A test fails if a new
English text slips into the French version.

* **To review**: `docs/testing/french-review.md` is a 30-item checklist (which screen, which URL,
  how to get each email on the test system). About an hour.
* **A text is wrong or awkward**: it is written in the place where it appears, as
  `tr('English', 'Français')` in `views/*.ejs` and `src/routes/*.js`, in the page's French dictionary
  (`views/marketing/*.ejs`, `pageI18nFr`) or in `assets/site.js` (shared). Search for a few of its
  words. Fix the French only; leave the English as it is. A developer runs `npm test` and
  `npm run lint` before it goes live. Emails use `tr(...)` too (`src/lib/orderEmail.js`,
  `emailVerification.js`, `passwordReset.js`, `bookRequests.js`, `privacy.js`).
* **Words we use**: vous everywhere; réservation, adhésion / adhérent(e), bénévole, librairie,
  livre d'occasion, état (Neuf, Comme neuf, Très bon état, Bon état, État correct), panier, retrait en
  boutique, régler sur place, mot de passe, e-mail (with the hyphen, as on the legal pages),
  Se connecter, Créer un compte, Espace membres. Prices `12,50 €`; 0 and 1 are singular (`0 vote`).
* **What is deliberately not translated**: the shop's name "Uma's Books and Adventures", legal
  entity names, book titles, authors and publishers, award names, and anything people or admins
  write themselves (forum posts, announcements, blog posts, event and session descriptions).
  Those are stored in one language. The list with reasons is in `docs/i18n-audit.md`.
* **Counts**: `cd umas-books && node scripts/i18n-audit.js` prints every page that still has English in
  its French version (should say `TOTAL flagged: 0`); `--write` updates the table in
  `docs/i18n-audit.md`.

## ae) AI limits (daily cap, per-minute limits, lookup and webhook protections)

The paid AI (Anthropic) is used for book descriptions, French translations, genre suggestions, reading a cover photo and the online price
check. Several limits keep a mistake, a loop or an abuser from running up the bill. Nothing here needs doing day to day.

**The knobs** (Render environment variables: Render dashboard > the `umas-books` service > **Environment**; saving restarts the service)

| Variable | Default | What it does |
|---|---|---|
| `AI_DAILY_MAX_CALLS` | `600` | The most Anthropic calls **per Paris calendar day for ALL features together** (descriptions, translations, genres, cover photos, price checks). `0` switches every AI feature off. |
| `PRICING_AI_DAILY_MAX` | `150` | The most **price checks** per day (a part of the 600 above, so the price check can never use more than its own share). |

**What happens when the daily cap is reached.** The AI calls are skipped, nothing else stops:

- a book still saves (its description stays empty; press **Generate** after midnight, Paris time);
- the Generate button, the photo scan and the Add a book page say **"Daily AI limit reached (N). Resets at midnight Paris time."**;
- the report *Book lookup sources used* (Reports) shows the same sentence in a red banner;
- ONE email goes to the alert address (`ALERT_TO`) the first time it happens each day, with the same instructions as here (alert key `ai-daily-cap`; a
  mail that could not be sent is tried again by the next refused call);
- the counter starts again at midnight Paris time.

**To allow more calls** (a busy day, a big batch of books): Render > the `umas-books` service > **Environment** > add or edit `AI_DAILY_MAX_CALLS`
(for example `1500`) > **Save changes**. Render restarts the service by itself; the new number is used at once, and calls already made today still count.
To find out whether the number is too small or something is looping, open Reports > *Book lookup sources used*, section **AI usage per day**.

**How it is kept exact.** Each call takes its slot with a single database statement (table `ai_daily_cap`, one row per day and scope), so any number of
requests at the same moment can never go past the cap. If the database cannot be reached the site counts in memory instead (still capped). No text, title,
ISBN or person is ever stored in it; rows older than 40 days are deleted by the daily job.

**Other protections that belong with these**

- **10 AI requests a minute per admin** on "Generate description" and on the photo scan (typing an ISBN is not counted). Past that the page says
  "Too many AI requests: wait a minute and try again." (HTTP 429); wait a minute.
- **Text length caps** on what is sent to the AI: title 200 characters, author 200, description 2000.
- **ISBN check digit.** A number whose last digit is wrong (a typo, or a made-up 13-digit number) is refused with "That ISBN is not valid: check the digits"
  before any catalog or paid ISBNdb request is made. Hyphens and spaces are fine; 979 numbers and ISBN-10 with an X are accepted. The till's barcode
  scanning is unchanged (it never used this check).
- **One request for identical concurrent lookups.** Two scans of the same ISBN at the same moment (or the scan page plus a save), or two identical AI
  requests, share one outside call.
- **Size limit on catalog answers.** Open Library, Google Books, ISBNdb, Wikidata and the NYT lists are read up to 1 MB (the BnF XML up to 2 MB); a
  bigger answer is treated as "that source failed" (counted as an error in the lookup statistics) and the other sources carry on.
- **HelloAsso webhook.** `/webhooks/helloasso` is not signed (HelloAsso offers no signature), so anyone could post fake payments to make the
  site call HelloAsso's API. Besides the 300-per-5-minutes-per-IP limit: a second webhook for the **same payer email within 60 seconds** does not
  call HelloAsso again; one check is made at the end of the minute instead, so a real payment (which sends several events in a row) is still
  verified; and at most **120 checks per 10 minutes** are made for all emails together (the surplus is acknowledged, logged once, and a real payment
  among it is picked up by the membership reconciliation job, which runs every 6 hours: `/admin/diagnostics/jobs`, "Membership reconciliation"). The
  counters are in memory (one server process), so a restart only forgets them. Real payments are not affected; the sync itself is idempotent.

## af) Nightly inventory export

**What.** Every evening at **21:00 Paris time** a GitHub workflow (*Nightly inventory export*) exports **all inventory** as a CSV and sends it two ways: **emailed** to the alert addresses (the `ALERT_TO` variable: it should list admin@umasbooks.org and sharonbje@gmail.com, separated by commas) and **stored** in the private Backblaze bucket (the backup bucket), folder `inventory-exports/`:

| File | What |
|---|---|
| `inventory_YYYY-MM-DD.csv` | One row per **copy** (the day's file) |
| `inventory_latest.csv` | The same file, overwritten every night |
| `inventory_books_YYYY-MM-DD.csv` | One row per **book**, with copy totals (in store, reserved, sold) |

Both dated files are attached to the email (subject `[umas-books] Inventory export YYYY-MM-DD (N copies)`; the body gives the counts). Above 15 MB only the per-book file is attached and the email says where the full one is. The CSV is **not** kept in GitHub (no Actions artifact; the job log shows counts only).

**Columns (per copy):** ISBN-13, ISBN-10, Title, Author(s), Publisher, Year, Binding (Mass Market / Trade / Hardback / Other), Condition (New / Like New / Very Good / Good / Acceptable), Price (EUR), Location, Source, Status (In Store / Reserved / Sold / Donated / Damaged / withdrawn), Date added, Copy ID, Till code (`UB-<copy id>`), Book ID, Genres, Clearance (Yes/No), Publisher price (EUR), Notes, Date sold (when known). The app stores one ISBN per book: the other form is computed from it (an ISBN-10 exists only for 978- numbers). There is no subtitle or language column because the database does not hold them. **No customer data**: no buyer or reservation-holder name, email or phone, only the status. (The *Notes* column is the free-text note an admin typed on the copy: do not type personal data there.)

**Format (one dialect, for French Excel; the same as the accounting export):** UTF-8 with a byte-order mark, **semicolon** separator, **decimal comma** (`4,50`), text in quotes, CRLF line ends, dates as `YYYY-MM-DD` (Paris days). A cell starting with `=`, `+`, `-` or `@` gets a leading apostrophe so Excel cannot run it as a formula.

**Open in Excel (French settings).** Double-click the file, or Excel > File > Open. Accents and prices should look right. If everything is in one column: Data > From Text/CSV, delimiter *Semicolon*, encoding *UTF-8*. Excel may show a long ISBN as `9,78E+12` in a narrow column (widen it), and it drops the leading zero of an ISBN-10 such as `0306406152`; to keep it, import with Data > From Text/CSV and set the column type to *Text*.

**Any time, from the website.** *Inventory* page > **Download all inventory (CSV)** (admins only; the link beside it gives the per-book file). Same columns and format, as of now. Each download is written to *Admin activity* (`inventory.csv`).

**Run it by hand.** GitHub > Actions > *Nightly inventory export* > Run workflow (the box *Run now, even if it is not 21:00 in Paris* is ticked by default). It emails and uploads as usual.

**How the 21:00 works.** GitHub schedules are in UTC, so the workflow is scheduled at 19:00 **and** 20:00 UTC and the first step lets only the run that falls in the 21:00 hour of Paris continue (the other one ends at once, green, with a notice). GitHub can start a scheduled run late (usually minutes); the file then arrives a little after 21:00. A delay of more than an hour skips that night.

**Owner steps (once).** Nothing new to configure: it uses the existing secrets (`DATABASE_URL`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_APPLICATION_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, all repository secrets) and variables (`BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `ALERT_TO`, all repository variables). Two checks:
1. **Repository variable** `ALERT_TO` (Settings > Secrets and variables > Actions > Variables): make sure it lists both addresses, comma-separated. The inventory email goes to the same list as the other alerts.
2. **Backblaze bucket setting** (Buckets > the backup bucket > Lifecycle Settings > custom rule): File Path `inventory-exports/`, *Days Till Hide* `90`, *Days Till Delete* `1`. Without it the daily files pile up for ever (a few MB a day). `inventory_latest.csv` is rewritten every night, so it always stays recent.

**If it fails.** An email "[umas-books] Nightly inventory export failed" arrives; open the run link. The database user is the same read-only user as the backup: "permission denied" means its SELECT grants need re-running (section ad, *A read-only database user for the backup*; it must be able to read `books` and `book_copies`). Missing Backblaze or Gmail settings are named in the log. Meanwhile the website button gives the current file.
## ag) Database connections

How many connections to Postgres the site opens, what limits them, and what to do when the log says the pool is saturated.

**The limits.**
- The Render Postgres plan in `render.yaml` is `1c-2g` (2 GB RAM). Render sets the connection limit from the plan's RAM: **100 simultaneous connections** for a database under 8 GB (200 from 8 GB, 400 from 16 GB, 500 from 32 GB; the old "legacy" plans had 97/197/397). Render does **not** put a connection pooler in front, and when the limit is reached new connections are **refused** (they do not queue). I took these numbers from Render's documentation page "Connecting to Render Postgres" (checked 2026-10); I could not read the live value from the database. To check it yourself: Render dashboard > the database > **Connect** > use the `psql` command, then run `SHOW max_connections;`. Keep about 10 below the number for Postgres's own use.
- Each app instance has its own pool. During a deploy **two instances overlap** for a minute or two, plus the pre-deploy migration (1 connection), the nightly backup (1) and any `psql` session you have open. With the default of 20 per instance that is about 20 + 20 + 3 = 43 of 100.

**The knobs** (Render environment variables; see section b for where):

| Variable | Default | What it does |
|---|---|---|
| `DB_POOL_MAX` | `20` | Most connections ONE instance keeps open. Whole number 2 to 50. Anything else is ignored with a warning in the log (`DB_POOL_MAX="..." is not a whole number from 2 to 50; using 20`), so a typo cannot stop the site. Keep `instances x DB_POOL_MAX` (times 2 during a deploy) well under 100. |
| `DASHBOARD_COUNTS_CACHE_SECONDS` | `30` on the live site, `0` elsewhere | How long the admin dashboard reuses the book, account, member and unused-image counts (never sales, orders or "needs attention"). `0` = always fresh. |

Fixed in `src/db.js`: wait at most **10 s** for a free connection (then the request fails with "timeout exceeded when trying to connect"), close connections idle for 30 s, end any single query after **30 s** (`statement_timeout`), end a transaction left idle for 30 s. Migrations lift the 30 s limit for their own connection.

**The log line.** If callers have been waiting for a connection for more than 2 seconds, the site writes (at most once a minute) a line like

`DB pool saturated: waiting=4 total=20 idle=0 max=20 (callers have waited 3s for a connection; see docs/runbook.md, "Database connections")`

- `waiting` = requests/jobs queued for a connection right now; `total` = connections open; `idle` = open but free; `max` = `DB_POOL_MAX`.
- One line during a traffic burst (a mailing, a busy launch hour) is harmless: the queue cleared on its own.
- Lines every minute for a long time, or users seeing "Something went wrong" with `timeout exceeded when trying to connect` in the logs: something is holding connections or the load is higher than the pool. First look at Render > the service > **Logs** for slow-query or job errors at the same time; then raise `DB_POOL_MAX` one step (for example 20 to 30) if `instances x max x 2` stays under about 90, and redeploy. Raising it is not a cure for a query that never finishes: the 30 s limit ends those.

**What the code does to stay inside the pool** (for developers): the admin dashboard runs its queries at most 3 at a time (`lib/runLimited.js`); the email outbox worker holds **no** connection while it talks to Gmail (it claims rows with one `UPDATE`, sends, and records each result with a short statement; a row whose worker died is picked up again when its 5-minute lease ends); every `pool.connect()` is released in a `finally`. `node scripts/load-dashboard.js` (local database only, not part of CI) fires 30 dashboard requests plus an outbox batch with a slow fake mail server and prints the pool's waiting counts.

## ah) Curated collections (the round-picture buttons on Browse Books)

Themed shelves such as *Paris Is Always a Good Idea* or *Bedtime Stories for Little Daydreamers*. Customers
see a row of round-picture buttons under the genre buttons on **Browse Books** (only on the plain page: not
while a genre, a search or *See All New In* is showing), and each button opens a page of its own
(`/collections/<name>`, `/fr/collections/<name>`) with the books.

**Nothing is ever shown until you say so.** The 19 collections start **unpublished**. The AI only *suggests*
books; you approve each one; then you publish. A customer sees a collection only when it is published, and in it
only the books you approved **that are in stock right now** (a book that sells or is reserved drops off by itself;
if a copy comes back it returns). A published collection with nothing left to show has no button and its page says
so kindly.

**How to fill one** (admin > Site content > **Collections**; English only, like the rest of admin)

1. Open the collection. Check the title and description in English and French, and the *Guidance for the AI*.
   **Translate to French** fills only the empty French boxes; read them, then press **Save** (it saves nothing
   by itself).
2. Press **Generate suggestions**. It looks at up to 300 books in stock that are not yet in this collection
   (the ones that match the collection's words best) and adds what fits, each with a one-line reason. The
   collection then shows **Last built** (set only when a build worked).
3. Tick **Approve** on the books you want (or **Reject** to never see one again), then **Save choices**.
4. Press **Publish**. It is refused until at least one book is approved **and** the French title and
   description are filled in. **Unpublish** takes it off the site at once.

**Managing collections** (not only the seeded 19)

- **New collection** (top of the list): English and French title and description, an optional address (made from the
  English title if left empty; it must be unique and can be changed until the collection is published), the optional
  AI guidance, a sort order. It starts unpublished. **Leave the guidance empty for a collection you fill in by hand
  only**: the Generate buttons are then hidden and Update all skips it.
- **Order:** the up and down arrows in the list (or the Sort order number on the collection) set the order of the
  buttons on Browse Books.
- **Add a book by hand:** on the collection, search the books in stock (title, author or ISBN) and press **Add**; it
  counts as approved at once. **Remove** on any book in the list takes it out (the book itself is never touched). A
  collection left with no approved book is unpublished.
- **Pictures:** *Round button picture* (cut to a circle for you; replace or remove, preview shown) and an optional
  wide **Banner** at the top of the collection page (shown 3:1 on a computer, taller on a phone; give it an English and
  a French description for screen readers, or leave them empty if it is only decoration). JPG, PNG or WebP up to 5 MB;
  they are stored in the database like the blog pictures, so they survive deploys.
- **Delete:** *Delete this collection* opens an "Are you sure?" page that shows how many approved books it has and offers
  **Unpublish instead**. Deleting removes the collection and its book list, never a book; its address then says
  "not found".

**Keeping collections up to date as new books arrive** (no schedule: you press the button).

- **Add new books** (on each collection, once it has been built) asks the AI only about books whose copy entered
  inventory **after the collection's Last built time**, and adds suggestions. **Update all collections** (top of the
  list) does that for every collection that was built before (never-built ones are left for their own
  **Generate suggestions** button, because building all 19 at once is more than 50 paid calls). It stops starting new
  collections after about 80 seconds (the result lists what was not reached: press it again), and one collection
  failing never stops the others. A collection with no new book shows **Nothing new** and keeps its Last built time.
- The list shows, per collection, the **Last built** time, "N books were added since the last build", and a
  **N to review** badge for suggestions waiting for you.
- New suggestions are always *waiting for review*, also on a collection that is already published: customers
  see only approved books. Nothing already approved or rejected is ever changed or removed by a rebuild.
- **Full rebuild (re-evaluate all books)** (link on the collection, with an "Are you sure?" page) asks about every
  book in stock that is not already in the collection, not only the new ones. It also keeps your choices.

**What it costs and what can go wrong.** Generate, Add new books, Full rebuild, Update all and Translate use the same
paid AI as book descriptions: they count toward the daily limit `AI_DAILY_MAX_CALLS` (section ae) and appear in
*AI usage* (under *description* and *translation*); one build is up to 3 calls. If there is no API key, the credit has
run out or the daily limit is reached, the page shows a plain message and nothing changes; the rest of the site is
not affected. Every publish, unpublish, save, review, build, rebuild and update is written to *Admin activity*.

**The pictures.** `assets/img/collections/<name>.png` and `.webp`, cut from the artwork sheet
`assets-src/collections-sheet.webp` by `node scripts/crop-collection-art.js` (only needed if the sheet changes).
A collection without a picture gets a plain text button. Titles are real text, so they are French when French is
chosen.
