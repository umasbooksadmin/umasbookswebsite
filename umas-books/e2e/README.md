# Automated end-to-end tests

These tests do what a person does with `docs/testing/manual-test-scripts.md`:
they open a real browser (invisible), click through the site and check what
they see. They run against a **running site by its web address**. They are
not part of `npm test` and not part of CI, so they can never run against the
live site by accident.

There are exactly **five kinds of user** (personas), the same as the five
scripts of the manual plan, plus the edge cases: **guest** (anyone not logged
in; browses and can fill a cart, but cannot buy), **account holder** (logged in
with a confirmed email, not a member; this is who buys), **member** (an account
holder who also paid the membership fee), **volunteer**, **admin**.

Each test is named with the step it comes from (`G12`, `AC22`, `AC7`, `VO3`,
`A9`, `E5`...). Steps that a computer cannot do (reading an email, paying on
HelloAsso, judging whether something "looks right") are in the list too, as
"manual-only" placeholders, so the report shows complete coverage numbers.

## Safety, in short

1. **It refuses to run on the wrong site.** It only starts when the address is
   `localhost` / `127.0.0.1`, **or** the site is in preview mode (it answers
   with the "noindex" header **and** shows the "Preview" banner), **or** you set
   `E2E_ALLOW_LIVE=1` on purpose. It prints which rule allowed the run.
2. **It never pays.** The browser is blocked from loading any HelloAsso address,
   so a payment page is never even opened. In preview mode the tests check that
   checkout is switched off. With payments on, one test (AC24, only with
   `E2E_ALLOW_WRITES=1`) presses **Pay & Buy**, checks that the site sends the
   browser towards the HelloAsso address, and stops there. That leaves one
   unpaid order that holds a book for 60 minutes; the site frees it by itself.
3. **Passwords stay with you.** They are read only from variables you set in
   your Terminal window for one run. They are never in a file, never printed,
   and never sent anywhere except to the site's own login page.
4. **Everything it creates is tagged** `E2E-<date>-<time>` in its name or title,
   with e-mail addresses like `e2e+...@example.invalid` (a domain that cannot
   receive mail). The report lists every record it left behind.
5. **Writes are off unless you ask.** The default run only reads, plus harmless
   cart add/remove. Anything that creates an account, order, book, request,
   forum post or e-mail needs `E2E_ALLOW_WRITES=1`.

## Running it (step by step, no coding)

1. Open **Terminal**. Go to the app folder and install once:
   ```
   cd path/to/umasbookswebsite/umas-books
   npm ci
   ```
2. Run against the site (the guest and edge tests need no password):
   ```
   E2E_BASE_URL=https://umasbooks.org npm run e2e
   ```
   Putting `NAME=value` in front of the command sets it **for that one run only**.
   Nothing is saved in any file.
3. To add the logged-in tests, set the test accounts' details in the same
   Terminal window. Type passwords with `read -s` so they do not show on screen
   or in your history; the quotes and the `?` are part of the command:
   ```
   export E2E_ACCOUNT_EMAIL="account-test@example.com"
   read -s "E2E_ACCOUNT_PASSWORD?Account password: "; export E2E_ACCOUNT_PASSWORD
   export E2E_MEMBER_EMAIL="member-test@example.com"
   read -s "E2E_MEMBER_PASSWORD?Member password: "; export E2E_MEMBER_PASSWORD
   export E2E_ADMIN_EMAIL="admin-test@example.com"
   read -s "E2E_ADMIN_PASSWORD?Admin password: "; export E2E_ADMIN_PASSWORD
   read -s "E2E_ADMIN_TOTP_SECRET?Admin two-step key: "; export E2E_ADMIN_TOTP_SECRET
   E2E_BASE_URL=https://umasbooks.org npm run e2e
   ```
   These variables live only in this Terminal window. **Closing the window
   forgets them**, or run `unset E2E_ACCOUNT_PASSWORD E2E_MEMBER_PASSWORD E2E_VOLUNTEER_PASSWORD E2E_ADMIN_PASSWORD E2E_ADMIN_TOTP_SECRET`.
4. Read the table at the end (see "Reading the report").

More examples:

```
E2E_BASE_URL=https://umasbooks.org npm run e2e -- --persona guest          # only the guest tests
E2E_BASE_URL=https://umasbooks.org npm run e2e -- --persona guest,account
E2E_BASE_URL=https://umasbooks.org E2E_ONLY=admin npm run e2e              # same thing with a variable
E2E_BASE_URL=https://umasbooks.org E2E_ALLOW_WRITES=1 npm run e2e          # also create tagged test data
E2E_BASE_URL=http://localhost:3000 npm run e2e                             # your own computer
```

Personas: `guest`, `account`, `member`, `volunteer`, `admin`, `edge` (the five kinds of user, plus the edge cases).

## The variables

| Variable | Needed for | Notes |
|---|---|---|
| `E2E_BASE_URL` | everything | The site's address, for example `https://umasbooks.org`. |
| `E2E_ONLY` | optional | Which personas to run, comma separated. Same as `-- --persona`. |
| `E2E_ALLOW_WRITES` | optional | `1` to allow tests that create tagged data or send e-mail to the shop mailbox. |
| `E2E_ALLOW_LIVE` | optional | `1` to run on a site that is **not** in preview mode. Only set it on purpose. |
| `E2E_ACCOUNT_EMAIL`, `E2E_ACCOUNT_PASSWORD` | account holder tests (also the buying tests, G51 and E2 and E8) | A **confirmed account that is NOT a member, volunteer or admin**. The tests check this by opening Member's Access: if it opens, they skip every account test and say so. |
| `E2E_MEMBER_EMAIL`, `E2E_MEMBER_PASSWORD` | member tests | A **confirmed account marked as member** (admin: Mark as Member). It does not need any order. |
| `E2E_VOLUNTEER_EMAIL`, `E2E_VOLUNTEER_PASSWORD` | volunteer tests | A confirmed account an admin marked as volunteer. |
| `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_ADMIN_TOTP_SECRET` | admin tests | A **dedicated test admin** with two-step on. The secret is the text key (base32, letters and digits) shown under the QR code when two-step was set up. |
| `E2E_ADMIN_TOTP_RECOVERY` | optional | A recovery code, used only if no secret is given. It works once, so give a secret instead if you can. |
| `E2E_NO_SANDBOX` | only on some servers | `1` if Chrome refuses to start as root (for example in a container). |

## What each persona needs

| Persona | Needs | Writes (only with `E2E_ALLOW_WRITES=1`) |
|---|---|---|
| guest | nothing (G51 also uses the account login) | contact form, book request, event sign-up (all tagged); G55 and G56 make one unconfirmed account through the membership form |
| account | account-holder login (not a member) | one tagged unconfirmed sign-up that can never log in; AC24 starts a checkout when payments are on (one unpaid order, never paid); AC43 stores a pending two-step secret (nothing is switched on). AC53 presses Check my membership, which only reads HelloAsso (limited to 5 per 10 minutes) |
| member | member login | a forum thread, reply and report; one charity vote and idea |
| volunteer | volunteer login (the member and admin logins too, for VO1 and VO7) | signs up for one shift and cancels it again |
| admin | test admin with two-step | one tagged test book (made-up ISBN, EUR 5.00, in the public shop), one tagged test member (disabled again). **Sells nothing.** |
| edge | nothing (account login for E2 and E8) | double-click checkout test (payments on), a 6000-character contact message |

A persona whose variables are missing is **skipped, not failed**, and the
report says which variables to set.

## Reading the report

While it runs you see one line per test: a tick (passed), a cross (failed) or
a dash (skipped, with the reason). At the end:

- A table per persona: **Pass**, **Fail**, **Not run** (skipped for missing
  logins or because writes are off), **Known** (a known problem, shown but not
  counted as a failure), **Manual** (cannot be automated) and **Total**.
- `Coverage: automated N / manual M / total T tests`, and a line saying how
  many steps of the manual script have an automated test. (Full local run: 176
  automated, 70 manual-only, 246 tests in all.)
- **FAILED**: each failure with the step id and what was wrong. A screenshot
  and the page's HTML are saved in `e2e/artifacts/` (not committed to git).
- **Known issues**: tests marked as known problems. If one starts passing, the
  report says so, and the mark should be removed.
- **Records this run created**: what to clean up.

The exit code is 0 when nothing failed, 1 when something failed, 2 when the
safety guard refused to start.

## Manual-only steps

These need a person (an e-mailed link, a payment, a second person or browser,
real time passing, or something that would be damaging to automate). They
appear in the report as skipped tests starting with `manual:`. Of the 193
steps in the manual script, **139 have an automated test** (some only for part
of the step) and **54 are manual-only**:

| Why | Steps |
|---|---|
| Needs an e-mailed link, a readable mailbox or an authenticator app | G29, G33, G35, G36, G38, AC2b, AC5, AC6, AC12, AC14, AC20, AC21, AC27, AC28, AC43b, A2, A3, A22, A37 |
| HelloAsso payment (never done by the tests) | AC26, AC29, AC30, AC35, AC36, AC37, AC38, AC42, AC54, M1, A21, E4 |
| Needs a second person, a second browser, or real time | AC40, AC41, VO4, A5b, E7, A23b, M14, M16 |
| Would lock out or change the test account, or sell a real book | AC10, A18 |
| Human or hardware | G24 (calendar app), G43 (private window), AC31 (pickup at the shop) |
| An admin action, done when the test account is set up | M3 (Mark as Member), M13 and A42 (an admin-granted membership has no end date) |
| Other | G30 (sends five real e-mails), G34 (needs a request made by another test and an admin look), AC39 (would hold more books), M11 (same as G23), AC19 (needs a deleted account), A13 (photo scan needs the AI key), A41 (optional paid lookup) |

Parts of steps that are otherwise automated and stay manual are listed too, as
their own skipped tests: A4b (lock-out after many wrong codes), A5c (recovery
code), A14c (delete the test book), A28b (erase a member), A30b to A36b
(create, publish and delete events, sessions, meetings, shifts, announcements,
blog posts and votes), A39b (change the clearance price), AC11b, AC15b and AC18b
(reset e-mail, changing the password for real, really deleting an account).

## Cleaning up

Anything created is named with the run tag (shown at the start and in the
final list) and uses `example.invalid` e-mail addresses.

- **Test book**: admin > Books & Orders > search the tag > open it > **Delete this book**.
- **Test member** (left disabled): admin > Accounts > search the tag > **Erase Member**.
- **Unconfirmed sign-up** (account test AC3): same, **Erase Member** (it also deletes itself 7 days after sign-up if it holds no data).
- **Unpaid orders** (AC24, E2): nothing to do; they expire by themselves after an
  hour and the book goes back on sale (admin > Orders shows them as expired).
- **Book requests**: admin > Book Requests > **Waiting for email confirmation**
  > Delete (an unconfirmed request also expires by itself).
- **Forum thread, charity idea, event sign-up, volunteer shift**: remove from
  the matching admin page (Events > the event > **Remove**; Charities >
  Submitted Ideas; the forum thread has **Hide this post**).
- **E-mails** (contact tests, forum report, test invite): delete them from the
  shop mailbox. The invite for the test member goes to `example.invalid` and
  may come back as a delivery failure message.
- **Everything at once before launch:** the clearing script, `npm run clear-test-data`
  (dry run first, which deletes nothing; back up first; the steps are in
  `docs/runbook.md`, section g, "Clearing the test data"). It removes the shop,
  all non-admin accounts and their data, and the audit log, so it also removes
  what these tests created. The e2e tests never run it.

## Checking the tests themselves (on your computer)

```
npm run e2e:local                       # throwaway copy of the app with sample data and test logins
npm run e2e:local -- --preview          # same, with the app in preview mode (checkout off)
npm run e2e:local -- --persona admin    # only some personas
npm run e2e:local -- --readonly         # without E2E_ALLOW_WRITES
npm run e2e:local -- --serve            # leave the copy running so you can look at it
```

This needs a local PostgreSQL, like `npm test`. It starts the app with the
same helper the integration tests use, makes an account holder, a member, a volunteer and a
two-step admin with random passwords, sample books/events/sessions, and a fake
HelloAsso that only answers "here is a payment page address". It never sends
e-mail and never contacts HelloAsso. `npm test` itself only runs a small test
of the safety guard (`test/unit/e2eSafetyGuard.test.js`), which also checks
that every step of the manual script has an e2e test.

## Known problems the tests report

These are real findings from the first runs; the report keeps showing them
until they are fixed.

- Marked as known (do not fail): the Dashboard shows `NaN%` next to a sales or
  orders figure when last month had none (A6; `views/admin/index.ejs`, the trend
  helper divides by "0.00"; also a known todo in
  `test/integration/adminCalendars.test.js`); admin pages say `<html lang="fr">`
  when French is chosen although they are English only (A8b).
- Fixed, now normal tests: French prices read `12,50 €` (G-FR12), the legal
  pages are French in the HTML the server sends (G40b), and the "session
  expired" page is translated (X6).

Where the manual script and the site differ today, the tests follow the site:
guests are not shown a key icon (G3: `/dashboard` sends them to login); the
search result cards show title, author and price but not the condition labels
or Clearance badge (G12, G17: those are on the book page); a member who opens
`/volunteer` ends on Member's Access, not the home page (VO1); an account holder
who opens any member page (`/dashboard`, `/forum`, `/meetings`, `/announcements`,
`/volunteer`) lands on the home page, which is what AC44 to AC50 assert.

## For developers

- `run.js` (entry point), `local.js` (throwaway local app), `helpers/guard.js`
  (the safety rules), `helpers/config.js` (variables), `helpers/harness.js`
  (browser, logins, screenshots, HelloAsso block), `helpers/summary-reporter.js`
  (the final table), `specs/<persona>.e2e.js` (the tests; the persona to file list is `PERSONA_FILES` in `helpers/config.js`).
- The spec files end in `.e2e.js` on purpose: `node --test` only discovers
  `*.test.js`, so `npm test` never picks them up.
- One login per persona per run (cookies are copied into each test's private
  browser window). The admin's one-time code is computed with `src/lib/totp.js`
  and the code of a 30-second step is never used twice.
- Each test file is a separate process; `run.js` runs them one after another.
