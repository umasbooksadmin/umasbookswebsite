# Record of processing activities / Registre des activités de traitement

*GDPR article 30. Keep this file up to date: it is the document the CNIL asks for first.*

**Controller / Responsable de traitement:** Uma's Books, association loi 1901
- RNA W811011706, SIRET 109 441 147 00013
- Siège: 5 rue Hippolyte Savary, 81000 Albi
- Contact: admin@umasbooks.org
- Represented by: the President
- Data protection officer (DPO): **no DPO required.** GDPR art. 37 only requires one for public bodies, large-scale regular monitoring of people, or large-scale processing of sensitive data; none of these applies (a small association; no tracking; no health data is collected, and the forms tell people not to send any).
- DPIA screening (GDPR art. 35): **no DPIA required.** One-line screening on 6 October 2026: none of the CNIL high-risk criteria combine here (no large scale, no profiling or scoring, no sensitive data on purpose, no systematic monitoring, no data matching); children's names and years of birth reach us only as an email from their parent or guardian for a weekly activity. Re-screen if a feature starts storing children's data or any health data.

**Last reviewed / Dernière révision:** 9 October 2026 (privacy tidy-up: phone numbers removed from orders once collected and at most 30 days, reprice runs store no administrator email, member export completed, recipients and retention periods made exact in the public policy; the "Retention rules" table is in `docs/runbook.md` section s; before that, 7 October 2026: sections 2 and 3 rewritten for the reservation model; before that, 6 October 2026: sections 6, 8 and the new Cloudflare, cookies and covers notes; the rest was confirmed by Sharon Bjeletich on 4 October 2026).

**Last checked against the code:** 4 October 2026 (every row below was compared with `umas-books/` on that date; the reservation, image-cleanup, backup-recipient, font and AI rows were corrected on that date).

How to read this: one table per activity. "In the code" means it was checked against the website's source code (`umas-books/`) when this file was written. Anything marked **NOT AUTOMATED** is a manual job for a volunteer. The retention periods are the ones in `umas-books/src/lib/privacy.js` (the `RETENTION` constants) and in the public privacy policy (`views/marketing/privacy-policy.ejs`, section "How long we keep it"). If you change one, change the other, and this file.

Common to all activities: no sensitive data (health, religion, etc.) is collected on purpose; no profiling, advertising or automated decisions; no data is sold. Hosting database and website: Render, Frankfurt (Germany, EU). AI service for book information (no personal data): Anthropic, see section 11.

---

## 1. Accounts / Comptes

| | |
|---|---|
| Purpose | Let people log in, keep favorites, use member features; protect accounts from guessing |
| Data | Email, display name, password (stored only as a bcrypt hash), admin / member / volunteer flags, member expiry date, email-verified date, last login date, failed-login counter and lock time, date of last password change, inactivity-warning date, the language chosen (`users.lang`, used to write emails in French or English), and for two-step verification an encrypted secret and hashed recovery codes. Short-lived reset and email-verification tokens (stored hashed). Login session (cookie `umasbooks.sid`, session row in the database). |
| People | Website account holders, volunteers, members, admins |
| Legal basis | Contract (the service they asked for); legitimate interest (account security) |
| Recipients / processors | Render (hosting and database); Google Workspace/Gmail (sends verification and reset emails); Have I Been Pwned (password check, see below); Backblaze (backup copies) |
| Transfers outside EU | Google and Backblaze are US companies: covered by their standard contractual clauses / EU-US Data Privacy Framework (confirm per provider in `processors-checklist.md`). Have I Been Pwned: only the first 5 characters of a hash of the password are sent, never the email. |
| Retention | Until the person asks for deletion, or **3 years without login** (`inactiveAccountYears`). A warning email goes out first and deletion follows 30 days later unless they log in (`inactivityWarningDays`). Never auto-deleted: admins and people with a current membership. Reset and verification tokens: removed 7 days after they expire (`tokenGraceDays`). **Accounts whose email was never confirmed** (self-signup, cannot log in): deleted after **7 days** (`unconfirmedAccountDays`, step `unconfirmedAccounts` of the daily purge), but only when nothing else is held under the account or its address (no order, membership payment, sign-up, reservation or book request); otherwise left for a human. Sessions: cookie lasts 30 days of inactivity; expired session rows are cleaned by the session library. **Automated** in code (`purgeExpiredPersonalData`, runs at start-up and daily). Manual erase: admin > Members > Erase Member. A signed-in member can also delete their own account at My Account > Privacy (password and the word DELETE required; admins cannot): the same erasure code runs, and a confirmation email is sent first. |
| Security | HTTPS; password hash only; login lockout after failed attempts; HIBP check on new passwords; admin area restricted and CSRF-protected; database access limited to Render and the backup job; backups in a private encrypted bucket (nothing is stored in the code repository; the dump passes through the GitHub Actions runner briefly during the backup) |

Requests from people **without an account**, or from an address that is not an account's, are answered with admin > **Privacy requests** (`/admin/privacy`, `src/lib/privacyRequests.js`): it lists everything held under an email address and downloads or erases it in one transaction (paid orders and payments anonymised). Procedure, identity check, deadlines and answer templates: `docs/runbook.md`, section "A data request (access or erasure)"; each request is noted in `docs/privacy/requests-log.md`. To answer an access or portability request ("a copy of my data"), use admin > Members > member > **Download data (JSON)**. Members can also do this themselves (and delete their account) at **My Account > Privacy** (`/account/privacy`, current password required); these self-service actions need a **confirmed email address** (an unconfirmed account is refused and can ask for the confirmation email again, so nobody can sign up with someone else's address and take or erase that person's orders) and are recorded in the audit log by member id only.

## 2. Reservations and payments in the shop / Réservations et paiements à la boutique

*Since the "reserve online, pay at the shop" change (7 October 2026), nothing is paid on the website for books and drop-in seats. An account holder reserves online; the payment is taken in the shop (or at the session) and recorded by staff. Only the membership is paid online (section 5).*

| | |
|---|---|
| Purpose | Let account holders reserve books and drop-in seats online; hold them; send confirmation and reminder emails; record the payment taken in the shop (accounting records) |
| Data | Buyer name, email, phone (optional), items and prices, total, status (`reserved`, `paid`, `cancelled`, `expired`, `refunded`), dates, the language chosen when reserving (`orders.lang`), proof of acceptance of the terms of sale (`orders.cgv_accepted_at` and `orders.cgv_version`: when, and which version of the terms; not personal data by itself, kept with the order and on anonymised orders for the 10-year accounting retention), an order access token, the reservation deadline (`orders.reserved_until`, and `reservation_extended_at` when the shop extended it once), how and when a reservation ended without a sale (`released_at`, `release_reason`: customer, admin, expired, no_show, account_erased), and, once the staff record the payment in the shop, the payment method (cash, card at the shop, cheque or other: `payment_method`), the amount received (`amount_received`, with a note when lower than the total) and who collected it. Card details never reach us for books and seats (nothing is entered on the website). Older orders (before this change) may still carry the HelloAsso checkout/order numbers. No IP address is stored with an order any more (`orders.client_ip` is set to empty by the code; older values are still cleared by the daily purge). |
| People | Account holders who reserve: **only an account holder can reserve** (login with a confirmed email required; browsing and filling a cart need none). `orders.user_id` links the order to the account (empty for orders from before this rule, and after an account is erased); the order carries the account's confirmed email. A staff member can also record an in-shop sale ("Sell in shop"). |
| Legal basis | Contract; legal obligation (accounting, 10 years) |
| Recipients / processors | Render; Google Workspace/Gmail (reservation confirmation and reminder emails); Backblaze (backups). **No payment provider**: HelloAsso is no longer involved in orders (old orders may still hold its numbers). |
| Transfers outside EU | Render: EU. Google/Backblaze as above. |
| Retention | Sales (`paid`, `refunded`): **10 years** (`accountingYears`), then the order and its items are deleted (automated daily). A reservation is held **14 days** (21 if the shop extends it once); a drop-in seat is held until the session is over. Reservations that ended without a sale (`expired`, `cancelled`, including no-show) have no accounting value, so their name, email and phone are anonymised **30 days** after the order (`closedOrderDays`, automated daily). Orders still `pending` (legacy, from the old online checkout) are never deleted by the purge. On an erasure request the buyer data is replaced by "Erased" and the access link is rotated, open reservations are cancelled and the books released, but the amounts and items of sales stay (legal obligation). |
| Phone number | Optional. **Removed from the order as soon as it is collected and paid, cancelled or expired, and at the latest 30 days after it was made** (job `Order phone cleanup`, `src/lib/privacyMaintenance.js`, every 6 hours, visible on `/admin/diagnostics/jobs`); also removed from the held book copy. The phone is not an accounting need. Name and email stay on a paid order for the 10 years above. Orders that never became a sale (cancelled, expired) are anonymised (name, email, phone) 30 days after they were made (step `closedOrders`): the period the policy has always promised. |
| Security | As in section 1; order pages need a secret link; no payment data is handled by the website for orders |

## 3. Book holds without an order / Livres mis de côté

| | |
|---|---|
| Purpose | Hold a book for someone outside the online reservation (a copy an admin holds for a customer, or the book-request "notify and hold" flow); send one reminder. Online reservations (section 2) also copy the buyer's name, email and phone onto the reserved copy so the shelf list can show who it is for. |
| Data | Name, email, phone, date of reservation and the date the reminder was sent (stored on the book copy: `reserved_by_name`, `reserved_by_email`, `reserved_by_phone`, `reserved_at`, `reminder_sent_at`) |
| People | People for whom an admin holds a book, book requesters whose request is held, and account holders with an online reservation |
| Legal basis | Contract (their request) |
| Recipients / processors | Render; Google Workspace/Gmail (reminder email); Backblaze (backups) |
| Transfers outside EU | Google, Backblaze as above |
| Retention | Copies held without an order: **14 days** (`RESERVATION_DAYS` in `src/lib/legal.js`, used as `RESERVATION_TTL_DAYS` in `src/lib/reservations.js`). After that name, email, phone and date are cleared and the book goes back on the shelf. The job runs at start-up and every 6 hours. A reminder is emailed once, 3 days before the end (day 11). Online reservations follow the deadline on their order (section 2: 14 days, 21 if extended). A reservation that ended another way (the book was collected and paid, sold in the shop, cancelled or expired) keeps no contact details on the copy **30 days** after it ended (`closedOrderDays`, step `reservationContacts` of the daily purge). On an erasure request an active reservation is released and the contact details are cleared at once. **Automated.** |
| Security | Reservation details are shown in the admin area only |

Note: the former public route `POST /books/:id/reserve`, which let anyone hold copies and trigger email to any address, stays removed. The only public way to reserve is the cart's "Reserve (free, no commitment)" button (`POST /cart/reserve`), which needs a logged-in account with a confirmed email address, and is limited to 10 copies and 3 open reservations per account.

Inventory locations (`book_copies.location`, the shelf code where a physical copy sits) are not personal data and are not covered here.

## 3b. Book requests / Demandes de livres

| | |
|---|---|
| Purpose | Let anyone ask us to look out for a book (no account or membership needed); confirm the request by email; email the person if a copy arrives (and optionally hold it for 7 days) |
| Data | Book title, author, ISBN; email (stored lower-case), optional name and note; the language of the page (en/fr) for emails; the account id when the person was logged in; dates and status; our own staff note. Confirmation and private-link tokens are stored **hashed** only. A "find my requests" link stores the email and a hashed token for 30 days. |
| People | Guests, account holders and members who fill in the form at `/request-a-book` |
| Legal basis | Their request (pre-contractual steps at their request); double opt-in by email link |
| Recipients / processors | Render; Google Workspace/Gmail (confirmation and notification emails); Backblaze (backups). Admins see name and email on the admin Requests page. |
| Transfers outside EU | Google, Backblaze as above |
| Retention | **Unconfirmed** requests: deleted after **7 days**. **Open, matched or notified** requests: **12 months at most** from the request, then marked expired and the email, name, note and account link are cleared. **Fulfilled, cancelled or expired** requests lose email, name, note, staff note and account link **30 days** after they ended (cancelling by the person clears them at once). Title, author and ISBN stay without any personal data, for anonymous demand counts. Expired "find my requests" links are deleted. **Automated** daily (`purgeExpiredPersonalData`, step `bookRequests`). Also cleared on erasure (`eraseMember`) and included in the member data export (`book_requests`). |
| Security | Tokens are random and stored hashed; pages reached by a token link are not cached and send no Referer; the form is rate limited (5 a day per connection, 3 pending requests per email) and gives the same answer whether or not an address is known; the admin Requests page is admin-only and every action is in the audit log (ids only). |

## 4. Event and session sign-ups / Inscriptions aux événements et séances

| | |
|---|---|
| Purpose | Manage attendance and capacity for events and English sessions (classes) |
| Data | Name, email, date of sign-up (children may be registered by a parent: the parent's details are the ones stored) |
| People | Attendees; parents/guardians |
| Legal basis | Contract |
| Recipients / processors | Render; Google Workspace/Gmail if an admin emails attendees; Backblaze (backups) |
| Transfers outside EU | As above |
| Retention | **12 months after the event or session date** (`signupMonths`). **Automated** (daily). Also deleted on erasure. |
| Security | Rosters are in the admin area |

The weekly English Immersion pre-registration form on the website (`POST /pre-registration`, `src/routes/marketingForms.js`) sends **one email** to admin@umasbooks.org (or `CONTACT_TO`) with who is registering (an adult for themselves, or a parent/guardian for a child), the session, preferred days and times, and, for a child only, the child's first and last name and **year of birth** (the form asks for the year, not the full date, as data minimisation; a post from the old form with a full date is reduced to the year), then the name, email and phone of the person registering (the adult, or the parent/guardian), and optional level and notes. The person must tick that they agree to be contacted, and for a child the parent or legal guardian must also tick that they are the child's parent or guardian (both checked on the server); the form tells them not to enter health information. The only copy in the database is the email outbox row (section 6b: recipient, subject and text, so a failed send is retried; erased after 30 days, 90 if it could not be sent), and that row is also in the database backups for up to 2 years (section 9), so the public wording is: "A copy stays in our outgoing-mail queue for up to 30 days (90 if sending failed) and in our backups (up to 2 years); then it is erased." (the website must not say that nothing is stored). The email arrives in our Gmail inbox and follows the 12-month rule in section 6.

## 5. Membership via HelloAsso / Adhésions

| | |
|---|---|
| Purpose | Recognise paid members on the website (member area). Becoming a member needs an account: the membership page creates it in one step (name + email, same data and rules as a signup, see section 1), then the person pays on HelloAsso and confirms their email afterwards |
| Data | HelloAsso order number, payer email, amount (cents), payment date, and a link to the matching account. Stored by the website in `membership_payments`. A payment whose payer email matches no confirmed account is kept without an account link and shown to the admin ("Unmatched membership payments") until linked by hand. The person's full details (name, address, card) stay at HelloAsso. |
| People | People who join through the membership page and its HelloAsso form (logged-in account holders, or new people who create their account on that page). The email typed on the page is kept in the person's session for up to 2 hours to show it on the payment step (never in a URL). "Check my membership" asks HelloAsso about the logged-in account's own confirmed email only. |
| Legal basis | Contract; legal obligation (accounting) |
| Recipients / processors | HelloAsso. For the payment itself HelloAsso is an **independent controller** (stated in our policy; confirm on their legal page, see checklist). Render; Backblaze (backups). |
| Transfers outside EU | None for HelloAsso (France) |
| Retention | **10 years** from payment date (`accountingYears`), automated daily. On erasure the payer email is replaced and the account link removed; the amount and date stay. Membership status itself expires automatically. |
| Security | The website only receives a payment notice (webhook) and then re-checks the order with HelloAsso's API before trusting it; API keys are stored as Render environment variables |

## 6. Contact messages (email only) / Messages de contact

| | |
|---|---|
| Purpose | Answer questions; organise activities and volunteering; pre-registrations |
| Data | Whatever the person writes: name, email, phone, message. Pre-registration: also whether it is an adult or a child, and for a child the name and year of birth, session and availability (given by the parent/guardian). The forms forbid health information. |
| People | Anyone writing to us |
| Legal basis | Their request; legitimate interest in answering |
| Recipients / processors | Google Workspace/Gmail only. The contact form, the volunteer sign-up (`POST /volunteer-signup`) and the pre-registration (`POST /pre-registration`) each send an email to admin@umasbooks.org (or `CONTACT_TO`). Each form has a CSRF token, a honeypot, a per-IP rate limit (5 per 15 minutes) and server-side validation, and no personal data is written to the logs. The messages pass through the email outbox (`email_outbox`, section 6b) so a failed send is retried; the copy in the database is erased after 30 days (`outboxSentDays`). **The only database copy is the outbox row**, which stays up to 30 days (90 if sending failed) and is therefore also in the backups for up to 2 years, then erased (checked in `src/routes/contact.js` and `src/routes/marketingForms.js`). The sender's address is the Reply-To. |
| Transfers outside EU | Google: US company; check the DPA and its transfer clauses (see checklist) |
| Retention | The Gmail inbox (admin@umasbooks.org) is the only place they are kept. Emails received through the contact form, the volunteer sign-up and the pre-registration are kept **12 months** in the mailbox, then deleted, unless a conversation is still ongoing (decided by the association; the public policy says the same). **NOT AUTOMATED (cannot be: it is the Gmail inbox), but prompted:** the website emails a reminder to `ALERT_TO` **once a month** (job `Contact mailbox reminder`, `src/lib/privacyMaintenance.js`; the manual cleanup, Gmail search `older_than:1y`, review, delete, empty the Trash, is in `docs/runbook.md`, section e), and covers all three forms. (This replaces the old rule "until the person asks us to delete them", which did not meet the storage-limitation principle.) Each pre-registration and volunteer email ends with a reminder line giving the 12-month rule. |
| Security | 2-step verification is required to create the app password the website uses to send mail (`README.md`, "Email"). Confirmed by Sharon Bjeletich on 4 October 2026: 2-step verification is on for every Google account that can open the admin@umasbooks.org inbox, and only Sharon Bjeletich has access to that inbox. |

## 6b. Email outbox / File d'attente des e-mails

| | |
|---|---|
| Purpose | Make sure the emails the website sends (reservation confirmations and reminders, account and password links, book-request and reservation mails, forum notices, the contact form to the shop) are delivered: each message is stored first, sent at once, and retried with a delay if Gmail refuses it. Lets an admin resend a reservation confirmation. |
| Data | Recipient address, subject, text of the email (which may contain a name, an order summary or a one-time link), kind of email, related order number, number of attempts, error text (email addresses and long numbers removed). Stored in `email_outbox` (`src/lib/outbox.js`). |
| People | Everyone the website emails, and people writing through the contact form |
| Legal basis | Contract (confirmations and links the person asked for); legitimate interest (reliable delivery) |
| Recipients / processors | Render (database); Google Workspace/Gmail (sends the mail); Backblaze (backups) |
| Transfers outside EU | Google, Backblaze as above |
| Retention | Recipient, subject and text of **sent** emails are erased after **30 days** (`outboxSentDays`), of emails that **could not be sent** after **90 days** (`outboxFailedDays`); the bare row (kind, dates, status) stays. One-time-link emails (account confirmation, password reset, book-request links) lose their text as soon as they are sent, **as soon as they fail**, and when their link lifetime passes while still unsent (1 hour for a reset, 24 hours for a confirmation; the row is marked `expired`, never retried), so a live link never sits in a database copy or backup. Messages sent to the shop inbox by the contact form, volunteer sign-up and pre-registration keep the submitter's address in `email_outbox.subject_email`, so an erasure request for that address finds and erases them too (also within the 30 days). Anti-abuse: a recipient receives at most one email of each link kind per 10 minutes and five per day, and the shop sends a capped number per hour (no address is logged, only counters). **Automated** daily (`purgeExpiredPersonalData`, step `emailOutbox`). Also erased on account erasure (`eraseMember`) and by `clear-test-data`. |
| Security | Admin-only page `/admin/email-outbox`; failed-send alerts to the admin mailbox contain no email addresses |

## 7. Forum, charity votes, volunteer shifts, meetings / Forum, votes, bénévolat, réunions

| | |
|---|---|
| Purpose | Member community features: forum posts and replies, voting for charities and suggesting ideas, volunteer shift sign-up, meeting RSVPs, favorite books |
| Data | Forum posts and replies (title, text, date), charity votes and ideas, shift sign-ups, meeting RSVPs, favorites, all linked to the account. For a post an administrator has hidden: the date, a reason code (illegal content, harassment, spam, other), an optional note of up to 500 characters and the id of the administrator (`hidden_at`, `hidden_reason`, `hidden_by`). |
| People | Logged-in members and volunteers |
| Legal basis | Contract; for forum posts, the person's choice to publish them |
| Recipients / processors | Other members see forum posts. A member's report of a post (reporter name and member number, reason, comment, first 300 characters of the post) is **emailed only** to admin@umasbooks.org (Google Workspace/Gmail) and not stored in the database. When an administrator hides a post, a statement of reasons is emailed to its author (EU Digital Services Act, art. 17; in their language, skipped if the account is gone). Render; Backblaze (backups) |
| Transfers outside EU | As above for backups |
| Retention | While the account exists. A hidden post stays in the database, so it can be restored or reviewed if the author contests it; members never see its text, and it follows the same rules as any post. Hiding and restoring are written to the audit log (section 10) with the kind of post and the reason code only. When the account is erased: votes, RSVPs, shift sign-ups and favorites are deleted; **forum posts and charity ideas are kept with no author** (their text stays; a post that contains personal details written by the member will remain, so check by hand if the person asks). |
| Security | Forum and community pages need a logged-in member (checked in the code) |

## 8. Error alerts and server logs / Alertes d'erreur et journaux

| | |
|---|---|
| Purpose | Know when the site breaks; keep it running; limit abuse |
| Data | Server logs at Render (technical details, IP addresses as seen by the host). Application log lines do not contain emails or form contents (see `ARCHITECTURE.md`; the form routes log only an error message). Request rate limits count requests per IP address in the application's memory only (lost at each restart, never written to the database). Error alert emails to admin@umasbooks.org contain an error message and technical stack trace, at most one every 15 minutes. |
| People | Guests and members (technical data only) |
| Legal basis | Legitimate interest (security and reliability) |
| Recipients / processors | Render (logs); **Cloudflare** (see below); Google Workspace/Gmail (alert emails) |
| Transfers outside EU | Render logs: the web service and database are in the Frankfurt region (`render.yaml`, `region: frankfurt`). Alert emails: Google. |
| Retention | Policy says "a few weeks at most". **NOT controlled by our code.** It depends on the Render plan: the workspace is on the Pro plan, where platform logs are kept **14 days** (confirmed by Sharon Bjeletich on 4 October 2026; not visible in the code). Alert emails sit in the inbox until deleted (**NOT AUTOMATED**). |
| Security | Logs are only available to people with Render access |

**Cloudflare.** The website is served through Cloudflare, the content-delivery and security network Render places in front of its web services. Every request passes through it, so Cloudflare sees visitors' IP addresses, the pages they ask for and the content relayed to our host (including form contents, over HTTPS between the visitor and Cloudflare). We have no separate Cloudflare account and do not configure it; it is Render's sub-processor and is named in the public privacy policy as a recipient (US company: transfers rely on the standard contractual clauses / EU-US Data Privacy Framework, see `processors-checklist.md`).

**Cookies and browser storage (all strictly necessary, no consent banner).** `umasbooks.sid`: session cookie, up to 30 days when logged in; 2 hours for a visitor who is not logged in (24 hours with items in the cart) (login, cart, CSRF token). `umasbooks_lang`: language cookie, 1 year, stores only `en` or `fr` (`assets/site.js`). localStorage: `umasbooks.lang` (language) and `umasbooks.favorites` (favorite book ids of a visitor who is not logged in); these never leave the device. The HelloAsso membership form is an iframe that is created only after the visitor clicks "Show the HelloAsso form" (`assets/membership-widget.js`), so HelloAsso receives nothing (IP address, cookies) before that click; HelloAsso may set its own payment cookies afterwards.

**Book covers are served from our own server.** A cover is downloaded once by our server from Open Library / the Internet Archive when a book is added (and by a gentle background job for older books: 20 every 5 minutes, at most 3 attempts a week for a cover that cannot be fetched), re-encoded (at most 600 px wide, metadata removed) and stored in the `images` table (`src/lib/coverStore.js`). Pages only use `/img/<hash>.jpg`; the Content-Security-Policy `img-src` is `'self' data:`, so visitors' browsers never contact Open Library or the Internet Archive and their IP addresses never reach them. Those two services only receive book details (title, author, ISBN) and cover requests from our server: no personal data.

Uploaded images (book covers, blog, announcement and charity photos) are stored in the database table `images` and are not personal data. Images no longer used by anything are deleted automatically once they have been unused for at least 7 days (`src/lib/imageCleanup.js`, daily at start-up and every 24 hours; the list of columns that can hold an image is `IMAGE_REFERENCES`). They remain in older backups for the backup periods in section 9.

Fonts: the website serves its typefaces itself (self-hosted files in `assets/fonts/`, declared in `public/style.css`, and the Content-Security-Policy allows fonts from the site only: `fontSrc: ["'self'"]` in `src/index.js`). No person IP address is sent to Google Fonts by the website. The old Squarespace-era snippet files at the repository root (`squarespace-*.html`) still import Google Fonts, but they are not served by the website; they matter only if someone pastes them into a Squarespace page (they date from when the site was built on Squarespace). Squarespace is still used, but only as domain registrar and DNS host (section 12); it does not host or serve the website.

## 9. Backups / Sauvegardes

| | |
|---|---|
| Purpose | Recover from a failure or loss of the hosting account |
| Data | A full copy of the database every night (so: everything in sections 1 to 7) |
| People | Everyone in the database |
| Legal basis | Legitimate interest (continuity); same bases as the original data |
| Recipients / processors | Backblaze B2 (private bucket, EU region, default encryption on, per the README); Render (its own automatic database recovery); **GitHub (GitHub Actions, USA)**: it runs the nightly backup job, so the dump is a **transient copy on the GitHub runner** during the backup, before upload to Backblaze; GitHub keeps no backup (DPA + EU-US Data Privacy Framework / standard contractual clauses to confirm: `docs/privacy/processors-checklist.md`). TODO(the association): consider encrypting the dump before upload so the transient copy is unreadable on GitHub. |
| Transfers outside EU | GitHub (United States): the transient copy during the backup job; DPF/SCC to confirm. Backblaze: the setup instructions require a bucket in an EU region (`README.md`, "Backups"; the region code is a repository variable, `BACKUP_S3_REGION`, e.g. `eu-central-003`); Backblaze is a US company. The bucket region is `eu-central-003` (an EU region), confirmed by Sharon Bjeletich on 4 October 2026. |
| Retention | **Backblaze** (the only offsite copy; the code repository on GitHub holds no stored data, but the backup job runs on GitHub Actions, so the dump passes through GitHub briefly): the nightly backup and the monthly restore test both passed on 1 October 2026. One full dump a night, kept 30 days; one on the 1st of each month, kept 2 years. Login sessions are left out of every dump (`--exclude-table-data=session`). **Render:** its own point-in-time recovery covers the last **7 days**. Backblaze deletion depends on lifecycle rules set by hand in the Backblaze console (`store-backups/full/`: hidden after **30 days**; `store-backups/monthly/`: hidden after 730 days; both then deleted after 1 day, as set out in `README.md` "Retention"; matching the policy). The maintainer confirmed on 4 October 2026 that the lifecycle is configured in the Backblaze console to delete nightly dumps after 30 days and monthly copies after 730 days (**set in the console, not verifiable from the repository**). A deletion request therefore disappears from backups only after those periods. |
| Security | Private bucket with encryption (no backup is kept in the code repository); access keys limited to the one bucket; monthly automatic restore test (the 1st of each month); failure emails to admin |

## 10. Administrator action log / Journal des actions des administrateurs

| | |
|---|---|
| Purpose | Accountability: know which administrator did what (erasures, deletions, two-step resets, forum moderation, admin logins) |
| Data | Table `admin_audit_log`: time, the administrator's id and email at the time (the email label is cleared when that administrator's account is erased), the action, the kind and numeric id of what was acted on, a short detail (never a member's email, name or post text), and the administrator's IP address. Members' own export and deletion are logged with the member's id only. |
| People | Administrators; indirectly the members acted upon (by id only) |
| Legal basis | Legitimate interest (security and accountability) |
| Recipients / processors | Render; Backblaze (backups). Read-only page for admins at `/admin/audit`. |
| Transfers outside EU | As above for backups |
| Retention | **12 months** (`auditLogMonths`), automated daily. The free-text `detail` of an entry (a refund note or void reason can contain a customer's name) is blanked after **6 months** (`auditDetailMonths`, step `auditDetail` of the daily purge); action, administrator and time stay until 12 months. Privacy-request entries (`privacy.lookup/export/erase`) hold a keyed hash of the address, never the address. Viewing the Accounts report page is logged once an hour per administrator (`reports.accounts.view`). |
| Security | Admin only; append-only from the code; writing it can never block an admin action |

## 11. AI lookups of book information / Recherches d'informations sur les livres par IA

| | |
|---|---|
| Purpose | Help administrators catalogue second-hand books: read a book's cover or barcode photo, write or translate a short description, suggest genres, suggest a used-book price |
| Data | **No personal data about customers, members or volunteers.** What is sent (checked in `src/lib/coverVision.js`, `bookDescription.js`, `bookGenre.js`, and `pricing/market.js`): book facts only (title, author, ISBN, publisher, year, binding, an existing description text), and, for a cover scan, the **photo of a book cover or barcode** that an administrator uploads. Results are cached per ISBN (`price_lookups`) and stored as book data. |
| People | None: the data is about books. Only administrators can trigger a lookup. (Rule for volunteers: photograph only the book, never people or documents; if a face or a written name ends up in a photo, retake it.) |
| Legal basis | Legitimate interest (running the shop efficiently); no personal data involved |
| Recipients / processors | **Anthropic** (AI service, API). Off unless `ANTHROPIC_API_KEY` is set; price lookups also need `PRICING_AI`. See `processors-checklist.md`. |
| Transfers outside EU | Anthropic is a US company. Because no personal data is sent, no transfer of personal data takes place; check Anthropic's terms if this ever changes. |
| Retention | Book data is kept as long as the book is in the catalogue. Price-lookup cache: 30 days for a found price, 7 days for no result, 1 hour after a failure (`TTL_MS` in `src/lib/pricing/market.js`). Anthropic's own retention of API requests is set by Anthropic's terms (per Anthropic's privacy centre, confirmed 4 October 2026: inputs and outputs are deleted from Anthropic's systems within 30 days, except content flagged for usage-policy violations, which is kept longer; the site sends only book facts and cover photos, no personal data). |
| Security | API key stored as a Render environment variable; the calls fail open (a failure never blocks an admin action); daily caps on lookups (`PRICING_AI_DAILY_MAX`) |

## 11a. Book-information and security-check services / Services d'informations sur les livres et de contrôle de sécurité

| | |
|---|---|
| Purpose | Look up a book by ISBN when an administrator adds it (Google Books, ISBNdb, BnF, Open Library), find awards and best-seller lists (Wikidata/Wikimedia, New York Times Books API), and refuse passwords found in known breaches (Have I Been Pwned) |
| Data | **No personal data about customers, members or volunteers.** The server sends an ISBN, title or author, never a visitor's address. Have I Been Pwned receives only the first 5 characters of the SHA-1 hash of a password being chosen (`src/lib/passwordPolicy.js`), never the password, email or name. |
| Recipients / processors | Google (Google Books), ISBNdb, Bibliothèque nationale de France, Wikimedia Foundation (Wikidata), The New York Times Company, Troy Hunt / Cloudflare (Have I Been Pwned). All named in the public privacy policy ("Who receives your data"). |
| Transfers outside EU | No personal data is sent, so no transfer of personal data takes place. |
| Retention | Nothing personal is kept by us about these calls (lookup statistics are counts only, section 11b). |

## 11b. Book lookup statistics / Statistiques des recherches de livres

| | |
|---|---|
| Purpose | Technical statistics so the maintainer can see which book catalogs (Open Library, BnF, Google Books, ISBNdb) are used and worth keeping: report "Book lookup sources used" (`/admin/reports/lookup-sources`) |
| Data | **Aggregate counts only, no personal data**: per day and per catalog, how many lookups were made, how many gave the title, failed or were refused, and the total response time. **No ISBN, no title, no user or administrator identifier, no IP address** is stored (`lookup_source_stats`, `src/lib/lookupStats.js`). |
| People | None. Only administrators can see the report. |
| Legal basis | Legitimate interest (running the shop efficiently); no personal data involved |
| Recipients / processors | None beyond the database host already listed (Render). |
| Transfers outside EU | None specific to this data. |
| Retention | Daily rows older than 36 months are deleted by a daily job ("Lookup statistics retention" in `src/index.js`, visible on `/admin/diagnostics/jobs`). |
| Security | Admin-only page and CSV (the CSV download is logged in the administrator action log); the counts are held in memory and saved in batches, never blocking a lookup. |

### 11b (continued). AI usage statistics / Statistiques d'utilisation de l'IA

| | |
|---|---|
| Purpose | Technical statistics so the maintainer can see what uses the Anthropic API credit and notice when it runs out: section "AI usage" of the report "Book lookup sources used" |
| Data | **Aggregate technical statistics, no personal data**: per day and per feature (description, French translation, genre, cover photo, price check), the number of calls, how many succeeded, failed, were refused (rate limit) or hit a credit/billing error, the token counts, the number of web searches, the total response time and the time of the last credit error. **No prompt, title, ISBN, description text, photo, user or administrator identifier, IP address or API key** is stored (`ai_usage_stats`, `src/lib/aiUsageStats.js`). The daily cap on AI calls keeps one counter per day and scope in `ai_daily_cap` (`src/lib/aiLimits.js`): a number only, deleted after 40 days. |
| People | None. Only administrators can see the report. |
| Legal basis | Legitimate interest (running the shop and its costs); no personal data involved |
| Recipients / processors | None beyond the database host already listed (Render). (The AI calls themselves are described in section 11.) |
| Transfers outside EU | None specific to this data. |
| Retention | Daily rows older than 36 months are deleted by a daily job ("AI usage statistics retention" in `src/index.js`). Kept by "Clear test data" (not personal data). |
| Security | Admin-only page and CSV (the CSV download is logged in the administrator action log); the counts are held in memory and saved in batches, never blocking or changing an AI call. |

## 12. Domain name and DNS / Nom de domaine et DNS

| | |
|---|---|
| Purpose | Register the domain `umasbooks.org` and run its DNS (the records that point the domain to the website at Render and to Google Workspace mail) |
| Data | The domain owner's account details (name, contact details, billing) held by the registrar. **No member, buyer or guest data.** Squarespace does **not** host the website: Render does. |
| People | The domain owner / account holder (a volunteer of the association) |
| Legal basis | Contract (domain registration); the association's legitimate interest in keeping its domain |
| Recipients / processors | Squarespace Domains II LLC (registrar and DNS host; nameservers `squarespacedns.com`) |
| Transfers outside EU | Squarespace is a US company; the data is only the owner's account details. Check its terms and DPA (see `processors-checklist.md`). |
| Retention | As long as the domain is registered and the account exists. |
| Security | Keep the Squarespace account protected by a strong password and 2-step verification if offered. **TODO (the association): confirm who holds the Squarespace account and whether 2-step verification is on.** |

---

## 13. Photos and videos / Photos et vidéos

| | |
|---|---|
| Purpose | TODO (the association): confirm why photos or videos are taken (for example documenting events, social media, the shop's walls) |
| Data | Images of customers, members or children, only if taken at the shop or at events. **The website does not take, upload or keep any photo or video of people, and has no photo database.** |
| People | Customers, members, children (via a parent or legal guardian) |
| Legal basis | Consent. Taken only with the person's consent; for a child, the consent of a parent or legal guardian is asked first. Consent can be withdrawn at any time by writing to admin@umasbooks.org, after which the image is no longer used. This is promised in the public privacy policy ("Photos and videos" section). |
| Recipients / processors | None through the website. TODO (the association): say where any photos are stored (phone, shared drive...) and whether any are published (website, Instagram, Facebook), then add the provider to `processors-checklist.md` |
| Transfers outside EU | TODO (the association): depends on where the photos are stored or published |
| Retention | TODO (the association): set how long photos are kept; stop using and delete an image when consent is withdrawn |
| Security | TODO (the association): who may take and hold photos; keep consent records (a parent or guardian's agreement for a child) |

## Open points for the volunteer in charge / Points à traiter

1. Fill in every item still marked **TODO (the association)** above (at present: who holds the Squarespace account and whether it has 2-step verification, and section 13, photos and videos: purpose, where photos are stored, whether any are published, how long they are kept).
2. Sign the data processing agreements listed in `processors-checklist.md`.
3. The Backblaze lifecycle rules (30 days nightly, 730 days monthly) were confirmed by the maintainer on 4 October 2026; the code cannot see them, so re-check them in the B2 console at the yearly review.
4. Re-read this file once a year, and whenever a new feature collects personal data.
