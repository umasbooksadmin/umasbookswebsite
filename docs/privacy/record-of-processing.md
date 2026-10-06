# Record of processing activities / Registre des activités de traitement

*GDPR article 30. Keep this file up to date: it is the document the CNIL asks for first.*

**Controller / Responsable de traitement:** Uma's Books, association loi 1901
- RNA W811011706, SIRET 109 441 147 00013
- Siège: 5 rue Hippolyte Savary, 81000 Albi
- Contact: admin@umasbooks.org
- Represented by: the President
- Data protection officer (DPO): **no DPO required.** GDPR art. 37 only requires one for public bodies, large-scale regular monitoring of people, or large-scale processing of sensitive data; none of these applies (a small association; no tracking; no health data is collected, and the forms tell people not to send any).
- DPIA screening (GDPR art. 35): **no DPIA required.** One-line screening on 6 October 2026: none of the CNIL high-risk criteria combine here (no large scale, no profiling or scoring, no sensitive data on purpose, no systematic monitoring, no data matching); children's names and birth dates reach us only as an email from their parent or guardian for a weekly activity. Re-screen if a feature starts storing children's data or any health data.

**Last reviewed / Dernière révision:** 6 October 2026 (sections 6, 8 and the new Cloudflare, cookies and covers notes; the rest was confirmed by Sharon Bjeletich on 4 October 2026).

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
| Security | HTTPS; password hash only; login lockout after failed attempts; HIBP check on new passwords; admin area restricted and CSRF-protected; database access limited to Render and the backup job; backups in a private encrypted bucket (nothing is stored in the code repository) |

To answer an access or portability request ("a copy of my data"), use admin > Members > member > **Download data (JSON)**. Members can also do this themselves (and delete their account) at **My Account > Privacy** (`/account/privacy`, current password required); these self-service actions need a **confirmed email address** (an unconfirmed account is refused and can ask for the confirmation email again, so nobody can sign up with someone else's address and take or erase that person's orders) and are recorded in the audit log by member id only.

## 2. Orders and payments / Commandes et paiements

| | |
|---|---|
| Purpose | Sell books and drop-in sessions online; confirm orders; keep accounting records |
| Data | Buyer name, email, phone (optional), items and prices, total, status, dates, the language chosen at checkout (`orders.lang`), the date the buyer accepted the withdrawal-right waiver for drop-in sessions, proof of acceptance of the terms of sale (`orders.cgv_accepted_at` and `orders.cgv_version`: when, and which version of the terms; not personal data by itself, kept with the order and on anonymised orders for the 10-year accounting retention), an order access token, the HelloAsso checkout/order numbers, and the buyer's **IP address** (`orders.client_ip`). Card details never reach us (entered on HelloAsso). |
| People | Online buyers: **orders are placed with an account** (login required to check out; browsing and filling a cart need none). `orders.user_id` links the order to the account (empty for orders placed before this rule, and after an account is erased); the order carries the account's confirmed email. |
| Legal basis | Contract; legal obligation (accounting, 10 years) |
| Recipients / processors | HelloAsso (payment page, receives buyer name and email to create the payment); Render; Google Workspace/Gmail (confirmation emails); Backblaze (backups) |
| Transfers outside EU | HelloAsso and Render: EU. Google/Backblaze as above. |
| Retention | **10 years** (`accountingYears`), then the order and its items are deleted (automated daily). The IP address is only used to cap how many unpaid orders one address can open during the 60-minute hold; it is cleared the moment the order is paid, expires or is cancelled, and in any case **2 days** after the order (`clientIpDays`, automated daily); it is also cleared on erasure. Exception: orders still `pending` are never deleted by the purge (they turn into `expired` or `cancelled` within minutes or hours, and those *are* purged at 10 years). Unpaid (expired/cancelled) orders have no accounting value, so their name, email and phone are anonymised **30 days** after the order (automated daily). On an erasure request the buyer data (and the IP address) is replaced by "Erased" and the access link is rotated, but the amounts and items stay (legal obligation). |
| Security | As in section 1; order pages need a secret link; payment data stays at HelloAsso |

## 3. Book reservations / Réservations de livres

| | |
|---|---|
| Purpose | Hold a book for pickup and pay in the shop; send one pickup reminder |
| Data | Name, email, phone, date of reservation and the date the reminder was sent (stored on the book copy: `reserved_by_name`, `reserved_by_email`, `reserved_by_phone`, `reserved_at`, `reminder_sent_at`) |
| People | People who ask the shop to hold a book (entered by an admin), and book requesters whose request is held |
| Legal basis | Contract (their request) |
| Recipients / processors | Render; Google Workspace/Gmail (reminder email); Backblaze (backups) |
| Transfers outside EU | Google, Backblaze as above |
| Retention | **14 days** (`RESERVATION_TTL_DAYS` in `src/lib/reservations.js`). After that name, email, phone and date are cleared and the book goes back on the shelf. The job runs at start-up and every 6 hours. A reminder is emailed once, 3 days before the end (day 11). A reservation that ended another way (the book was sold in the shop, or the reservation was cancelled) keeps no contact details **30 days** after it ended (`closedOrderDays`, step `reservationContacts` of the daily purge). On an erasure request an active reservation is released and the contact details are cleared at once. **Automated.** |
| Security | Reservation details are shown in the admin area only |

Note: there is no public reservation route or form (the former `POST /books/:id/reserve` was removed: it let anyone hold copies and trigger email to any address). Reservations are made at the shop and entered by an admin, or created by the book-request "notify and hold" flow. If a public reservation form is ever added, it needs email verification, a per-email cap and the privacy note (`partials/privacy_note`).

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

The weekly English Immersion pre-registration form on the website (`POST /pre-registration`, `src/routes/marketingForms.js`) sends **one email** to admin@umasbooks.org (or `CONTACT_TO`) with the child's first and last name, date of birth, session, preferred days and times, the parent/guardian's name, email and phone, and optional level and notes. The parent or legal guardian must tick a statement that they are the child's parent or guardian and agree to be contacted; the form tells them not to enter health information. The only copy in the database is the email outbox row (section 6b: recipient, subject and text, so a failed send is retried; erased after 30 days, 90 if it could not be sent). The email arrives in our Gmail inbox and follows the 12-month rule in section 6.

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
| Data | Whatever the person writes: name, email, phone, message. Pre-registration: also a child's name and date of birth, session and availability (given by the parent/guardian). The forms forbid health information. |
| People | Anyone writing to us |
| Legal basis | Their request; legitimate interest in answering |
| Recipients / processors | Google Workspace/Gmail only. The contact form, the volunteer sign-up (`POST /volunteer-signup`) and the pre-registration (`POST /pre-registration`) each send an email to admin@umasbooks.org (or `CONTACT_TO`). Each form has a CSRF token, a honeypot, a per-IP rate limit (5 per 15 minutes) and server-side validation, and no personal data is written to the logs. The messages pass through the email outbox (`email_outbox`, section 6b) so a failed send is retried; the copy in the database is erased after 30 days (`outboxSentDays`). **Nothing else is stored in the database** (checked in `src/routes/contact.js` and `src/routes/marketingForms.js`). The sender's address is the Reply-To. |
| Transfers outside EU | Google: US company; check the DPA and its transfer clauses (see checklist) |
| Retention | The Gmail inbox (admin@umasbooks.org) is the only place they are kept. Emails received through the contact form, the volunteer sign-up and the pre-registration are kept **12 months** in the mailbox, then deleted, unless a conversation is still ongoing (decided by the association; the public policy says the same). **NOT AUTOMATED:** the inbox is never cleaned by code; the yearly manual cleanup is in `docs/runbook.md`, section e) Yearly calendar, and covers all three forms. (This replaces the old rule "until the person asks us to delete them", which did not meet the storage-limitation principle.) Each pre-registration and volunteer email ends with a reminder line giving the 12-month rule. |
| Security | 2-step verification is required to create the app password the website uses to send mail (`README.md`, "Email"). Confirmed by Sharon Bjeletich on 4 October 2026: 2-step verification is on for every Google account that can open the admin@umasbooks.org inbox, and only Sharon Bjeletich has access to that inbox. |

## 6b. Email outbox / File d'attente des e-mails

| | |
|---|---|
| Purpose | Make sure the emails the website sends (order confirmations, account and password links, book-request and reservation mails, forum notices, the contact form to the shop) are delivered: each message is stored first, sent at once, and retried with a delay if Gmail refuses it. Lets an admin resend an order confirmation. |
| Data | Recipient address, subject, text of the email (which may contain a name, an order summary or a one-time link), kind of email, related order number, number of attempts, error text (email addresses and long numbers removed). Stored in `email_outbox` (`src/lib/outbox.js`). |
| People | Everyone the website emails, and people writing through the contact form |
| Legal basis | Contract (confirmations and links the person asked for); legitimate interest (reliable delivery) |
| Recipients / processors | Render (database); Google Workspace/Gmail (sends the mail); Backblaze (backups) |
| Transfers outside EU | Google, Backblaze as above |
| Retention | Recipient, subject and text of **sent** emails are erased after **30 days** (`outboxSentDays`), of emails that **could not be sent** after **90 days** (`outboxFailedDays`); the bare row (kind, dates, status) stays. One-time-link emails (account confirmation, password reset, book-request links) lose their text as soon as they are sent. **Automated** daily (`purgeExpiredPersonalData`, step `emailOutbox`). Also erased on account erasure (`eraseMember`) and by `clear-test-data`. |
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

**Cookies and browser storage (all strictly necessary, no consent banner).** `umasbooks.sid`: session cookie, up to 30 days (login, cart, CSRF token). `umasbooks_lang`: language cookie, 1 year, stores only `en` or `fr` (`assets/site.js`). localStorage: `umasbooks.lang` (language) and `umasbooks.favorites` (favorite book ids of a visitor who is not logged in); these never leave the device. The HelloAsso membership form is an iframe that is created only after the visitor clicks "Show the HelloAsso form" (`assets/membership-widget.js`), so HelloAsso receives nothing (IP address, cookies) before that click; HelloAsso may set its own payment cookies afterwards.

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
| Recipients / processors | Backblaze B2 (private bucket, EU region, default encryption on, per the README); Render (its own automatic database recovery) |
| Transfers outside EU | Backblaze: the setup instructions require a bucket in an EU region (`README.md`, "Backups"; the region code is a repository variable, `BACKUP_S3_REGION`, e.g. `eu-central-003`); Backblaze is a US company. The bucket region is `eu-central-003` (an EU region), confirmed by Sharon Bjeletich on 4 October 2026. |
| Retention | **Backblaze** (the only offsite copy; the code repository on GitHub holds no data): the nightly backup and the monthly restore test both passed on 1 October 2026. One full dump a night, kept 30 days; one on the 1st of each month, kept 2 years. Login sessions are left out of every dump (`--exclude-table-data=session`). **Render:** its own point-in-time recovery covers the last **7 days**. Backblaze deletion depends on lifecycle rules set by hand in the Backblaze console (`store-backups/full/`: hidden after **30 days**; `store-backups/monthly/`: hidden after 730 days; both then deleted after 1 day, as set out in `README.md` "Retention"; matching the policy). The maintainer confirmed on 4 October 2026 that the lifecycle is configured in the Backblaze console to delete nightly dumps after 30 days and monthly copies after 730 days (**set in the console, not verifiable from the repository**). A deletion request therefore disappears from backups only after those periods. |
| Security | Private bucket with encryption (no backup is kept in the code repository); access keys limited to the one bucket; monthly automatic restore test (the 1st of each month); failure emails to admin |

## 10. Administrator action log / Journal des actions des administrateurs

| | |
|---|---|
| Purpose | Accountability: know which administrator did what (erasures, deletions, two-step resets, forum moderation, admin logins) |
| Data | Table `admin_audit_log`: time, the administrator's id and email at the time, the action, the kind and numeric id of what was acted on, a short detail (never a member's email, name or post text), and the administrator's IP address. Members' own export and deletion are logged with the member's id only. |
| People | Administrators; indirectly the members acted upon (by id only) |
| Legal basis | Legitimate interest (security and accountability) |
| Recipients / processors | Render; Backblaze (backups). Read-only page for admins at `/admin/audit`. |
| Transfers outside EU | As above for backups |
| Retention | **12 months** (`auditLogMonths`), automated daily. |
| Security | Admin only; append-only from the code; writing it can never block an admin action |

## 11. AI lookups of book information / Recherches d'informations sur les livres par IA

| | |
|---|---|
| Purpose | Help administrators catalogue second-hand books: read a book's cover or barcode photo, write or translate a short description, suggest genres, suggest a used-book price, and find documented awards and best-seller lists |
| Data | **No personal data about customers, members or volunteers.** What is sent (checked in `src/lib/coverVision.js`, `bookDescription.js`, `bookGenre.js`, `pricing/market.js` and `awards/ai.js`): book facts only (title, author, ISBN, publisher, year, binding, an existing description text), and, for a cover scan, the **photo of a book cover or barcode** that an administrator uploads. Results are cached per ISBN (`price_lookups`) and stored as book data; AI-found awards stay hidden until an administrator approves them. |
| People | None: the data is about books. Only administrators can trigger a lookup. (Rule for volunteers: photograph only the book, never people or documents; if a face or a written name ends up in a photo, retake it.) |
| Legal basis | Legitimate interest (running the shop efficiently); no personal data involved |
| Recipients / processors | **Anthropic** (AI service, API). Off unless `ANTHROPIC_API_KEY` is set; price lookups also need `PRICING_AI` and award lookups need `AWARDS_AI`. See `processors-checklist.md`. |
| Transfers outside EU | Anthropic is a US company. Because no personal data is sent, no transfer of personal data takes place; check Anthropic's terms if this ever changes. |
| Retention | Book data is kept as long as the book is in the catalogue. Price-lookup cache: 30 days for a found price, 7 days for no result, 1 hour after a failure (`TTL_MS` in `src/lib/pricing/market.js`). Anthropic's own retention of API requests is set by Anthropic's terms (per Anthropic's privacy centre, confirmed 4 October 2026: inputs and outputs are deleted from Anthropic's systems within 30 days, except content flagged for usage-policy violations, which is kept longer; the site sends only book facts and cover photos, no personal data). |
| Security | API key stored as a Render environment variable; the calls fail open (a failure never blocks an admin action); daily caps on lookups (`PRICING_AI_DAILY_MAX`, `AWARDS_AI_DAILY_MAX`) |

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
