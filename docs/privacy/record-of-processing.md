# Record of processing activities / Registre des activités de traitement

*GDPR article 30. Keep this file up to date: it is the document the CNIL asks for first.*

**Controller / Responsable de traitement:** Uma's Books, association loi 1901
- RNA W811011706, SIRET 109 441 147 00013
- Siège: 5 rue Hippolyte Savary, 81000 Albi
- Contact: admin@umasbooks.org
- Represented by: the President
- Data protection officer (DPO): none appointed (not required for a small association; no large-scale monitoring or sensitive data)

**Last reviewed / Dernière révision:** ____ / ____ / ______  by ____________

**Last checked against the code:** 4 October 2026 (every row below was compared with `umas-books/` on that date).

How to read this: one table per activity. "In the code" means it was checked against the website's source code (`umas-books/`) when this file was written. Anything marked **NOT AUTOMATED** is a manual job for a volunteer. The retention periods are the ones in `umas-books/src/lib/privacy.js` (the `RETENTION` constants) and in the public privacy policy (`views/marketing/privacy-policy.ejs`, section "How long we keep it"). If you change one, change the other, and this file.

Common to all activities: no sensitive data (health, religion, etc.) is collected on purpose; no profiling, advertising or automated decisions; no data is sold. Hosting database and website: Render, Frankfurt (Germany, EU).

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
| Retention | Until the person asks for deletion, or **3 years without login** (`inactiveAccountYears`). A warning email goes out first and deletion follows 30 days later unless they log in (`inactivityWarningDays`). Never auto-deleted: admins and people with a current membership. Reset and verification tokens: removed 7 days after they expire (`tokenGraceDays`). Sessions: cookie lasts 30 days of inactivity; expired session rows are cleaned by the session library. **Automated** in code (`purgeExpiredPersonalData`, runs at start-up and daily). Manual erase: admin > Members > Erase Member. A signed-in member can also delete their own account at My Account > Privacy (password and the word DELETE required; admins cannot): the same erasure code runs, and a confirmation email is sent first. |
| Security | HTTPS; password hash only; login lockout after failed attempts; HIBP check on new passwords; admin area restricted and CSRF-protected; database access limited to Render and the backup job; backups in a private encrypted bucket (nothing is stored in the code repository) |

To answer an access or portability request ("a copy of my data"), use admin > Members > member > **Download data (JSON)**. Members can also do this themselves (and delete their account) at **My Account > Privacy** (`/account/privacy`, current password required); these self-service actions are recorded in the audit log by member id only.

## 2. Orders and payments / Commandes et paiements

| | |
|---|---|
| Purpose | Sell books and drop-in sessions online; confirm orders; keep accounting records |
| Data | Buyer name, email, phone (optional), items and prices, total, status, dates, the language chosen at checkout (`orders.lang`), the date the buyer accepted the withdrawal-right waiver for drop-in sessions, an order access token, the HelloAsso checkout/order numbers, and the buyer's **IP address** (`orders.client_ip`). Card details never reach us (entered on HelloAsso). |
| People | Online buyers (with or without an account) |
| Legal basis | Contract; legal obligation (accounting, 10 years) |
| Recipients / processors | HelloAsso (payment page, receives buyer name and email to create the payment); Render; Google Workspace/Gmail (confirmation emails); Backblaze (backups) |
| Transfers outside EU | HelloAsso and Render: EU. Google/Backblaze as above. |
| Retention | **10 years** (`accountingYears`), then the order and its items are deleted (automated daily). The IP address is only used to cap how many unpaid orders one address can open during the 60-minute hold; it is cleared the moment the order is paid, expires or is cancelled, and in any case **2 days** after the order (`clientIpDays`, automated daily); it is also cleared on erasure. Exception: orders still `pending` are never deleted by the purge (they turn into `expired` or `cancelled` within minutes or hours, and those *are* purged at 10 years). Unpaid (expired/cancelled) orders have no accounting value, so their name, email and phone are anonymised **30 days** after the order (automated daily). On an erasure request the buyer data (and the IP address) is replaced by "Erased" and the access link is rotated, but the amounts and items stay (legal obligation). |
| Security | As in section 1; order pages need a secret link; payment data stays at HelloAsso |

## 3. Book reservations / Réservations de livres

| | |
|---|---|
| Purpose | Hold a book for pickup and pay in the shop; send one pickup reminder |
| Data | Name, email, phone, date of reservation (stored on the book copy) |
| People | Visitors who reserve a book |
| Legal basis | Contract (their request) |
| Recipients / processors | Render; Google Workspace/Gmail (reminder email); Backblaze (backups) |
| Transfers outside EU | Google, Backblaze as above |
| Retention | **14 days** (`RESERVATION_TTL_DAYS`). After that name, email, phone and date are cleared and the book goes back on the shelf. The job runs at start-up and every 6 hours. **Automated.** A reminder is emailed 3 days before the end. |
| Security | Reservation details are shown in the admin area only |

Inventory locations (`book_copies.location`, the shelf code where a physical copy sits) are not personal data and are not covered here.
## 3b. Book requests / Demandes de livres

| | |
|---|---|
| Purpose | Let anyone ask us to look out for a book (no account or membership needed); confirm the request by email; email the person if a copy arrives (and optionally hold it for 7 days) |
| Data | Book title, author, ISBN; email (stored lower-case), optional name and note; the language of the page (en/fr) for emails; the account id when the person was logged in; dates and status; our own staff note. Confirmation and private-link tokens are stored **hashed** only. A "find my requests" link stores the email and a hashed token for 30 days. |
| People | Visitors, account holders and members who fill in the form at `/request-a-book` |
| Legal basis | Their request (pre-contractual steps at their request); double opt-in by email link |
| Recipients / processors | Render; Google Workspace/Gmail (confirmation and notification emails); GitHub and Backblaze (backups). Admins see name and email on the admin Requests page. |
| Transfers outside EU | Google, GitHub, Backblaze as above |
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

The weekly English Immersion pre-registration form on the website only opens the visitor's own email app (a `mailto:` link). Nothing is stored by the website; the email arrives in our Gmail inbox (see section 6).

## 5. Membership via HelloAsso / Adhésions

| | |
|---|---|
| Purpose | Recognise paid members on the website (member area) |
| Data | HelloAsso order number, payer email, amount (cents), payment date, and a link to the matching account. Stored by the website in `membership_payments`. The person's full details (name, address, card) stay at HelloAsso. |
| People | People who join through the HelloAsso membership form |
| Legal basis | Contract; legal obligation (accounting) |
| Recipients / processors | HelloAsso. For the payment itself HelloAsso is an **independent controller** (stated in our policy; confirm on their legal page, see checklist). Render; Backblaze (backups). |
| Transfers outside EU | None for HelloAsso (France) |
| Retention | **10 years** from payment date (`accountingYears`), automated daily. On erasure the payer email is replaced and the account link removed; the amount and date stay. Membership status itself expires automatically. |
| Security | The website only receives a payment notice (webhook) and then re-checks the order with HelloAsso's API before trusting it; API keys are stored as Render environment variables |

## 6. Contact messages (email only) / Messages de contact

| | |
|---|---|
| Purpose | Answer questions; organise activities and volunteering; pre-registrations |
| Data | Whatever the person writes: name, email, phone, message |
| People | Anyone writing to us |
| Legal basis | Their request; legitimate interest in answering |
| Recipients / processors | Google Workspace/Gmail only. The contact form sends an email to admin@umasbooks.org (or `CONTACT_TO`). **Nothing is stored in the database** (checked in `src/routes/contact.js`: it only sends the email, with the sender's address as Reply-To). Other forms open the visitor's own mail app. |
| Transfers outside EU | Google: US company; check the DPA and its transfer clauses (see checklist) |
| Retention | The Gmail inbox is the only place they are kept, and the public policy still says "until you ask us to delete them". **NOT AUTOMATED.** The inbox is never cleaned by code. Decide a rule (for example delete messages after 2 years) and write it here: ______________ |
| Security | Google account protected by 2-step verification (**to confirm**: ____ ); only volunteers who need the inbox have access |

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
| Data | Server logs at Render (technical details, IP addresses as seen by the host). Application log lines do not contain emails (see `ARCHITECTURE.md`). Request rate limits count requests per IP address in the application's memory only (lost at each restart, never written to the database). Error alert emails to admin@umasbooks.org contain an error message and technical stack trace, at most one every 15 minutes. |
| People | Visitors and members (technical data only) |
| Legal basis | Legitimate interest (security and reliability) |
| Recipients / processors | Render (logs); Google Workspace/Gmail (alert emails) |
| Transfers outside EU | Render logs: Frankfurt, EU (**confirm** on the Render dashboard). Alert emails: Google. |
| Retention | Policy says "a few weeks at most". **NOT controlled by our code.** It depends on the Render plan; check the log retention shown in the Render dashboard and write it here: __________. Alert emails sit in the inbox until deleted (**NOT AUTOMATED**). |
| Security | Logs are only available to people with Render access |

Uploaded images (book covers, blog, announcement and charity photos) are stored in the database table `images` and are not personal data. Images no longer used by anything are **not deleted automatically** (**NOT AUTOMATED**: `src/lib/imageCleanup.js` does not exist yet); they stay in the database and the backups until someone removes them.

Also note: the website's pages load typefaces from Google Fonts, so a visitor's IP address is sent to Google when a page loads (disclosed in the privacy policy). Consider hosting the fonts ourselves in future to remove this.

## 9. Backups / Sauvegardes

| | |
|---|---|
| Purpose | Recover from a failure or loss of the hosting account |
| Data | A full copy of the database every night (so: everything in sections 1 to 7) |
| People | Everyone in the database |
| Legal basis | Legitimate interest (continuity); same bases as the original data |
| Recipients / processors | Backblaze B2 (private bucket, EU region, default encryption on, per the README); Render (its own automatic database recovery) |
| Transfers outside EU | Backblaze: the bucket is in an EU region (**confirm** the bucket region in the B2 console); Backblaze is a US company. |
| Retention | **Backblaze** (the only offsite copy; the code repository on GitHub holds no data): the nightly backup and the monthly restore test both passed on 1 October 2026. One full dump a night, kept 30 days; one on the 1st of each month, kept 2 years. Login sessions are left out of every dump (`--exclude-table-data=session`). **Render:** its own point-in-time recovery covers the last **7 days**. Backblaze deletion depends on lifecycle rules set by hand in the Backblaze console (nightly files hidden after **30 days**, monthly files after 730 days, matching the policy). **Check that these rules exist** (**NOT AUTOMATED / not visible in the code**). A deletion request therefore disappears from backups only after those periods. |
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

---

## Open points for the volunteer in charge / Points à traiter

1. Fill in the blanks above (inbox retention rule, Render log retention, Google 2-step verification, B2 region and lifecycle rules).
2. Sign the data processing agreements listed in `processors-checklist.md`.
3. Check the Backblaze lifecycle rules (30 days nightly, 730 days monthly) in the B2 console: the code cannot see them.
4. Re-read this file once a year, and whenever a new feature collects personal data.
