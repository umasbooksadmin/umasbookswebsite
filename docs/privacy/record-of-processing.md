# Record of processing activities / Registre des activités de traitement

*GDPR article 30. Keep this file up to date: it is the document the CNIL asks for first.*

**Controller / Responsable de traitement:** Uma's Books, association loi 1901
- RNA W811011706, SIRET 109 441 147 00013
- Siège: 5 rue Hippolyte Savary, 81000 Albi
- Contact: admin@umasbooks.org
- Represented by: the President
- Data protection officer (DPO): none appointed (not required for a small association; no large-scale monitoring or sensitive data)

**Last reviewed / Dernière révision:** ____ / ____ / ______  by ____________

How to read this: one table per activity. "In the code" means it was checked against the website's source code (`umas-books/`) when this file was written. Anything marked **NOT AUTOMATED** is a manual job for a volunteer. The retention periods are the ones in `umas-books/src/lib/privacy.js` (the `RETENTION` constants) and in the public privacy policy (`views/marketing/privacy-policy.ejs`, section "How long we keep it"). If you change one, change the other, and this file.

Common to all activities: no sensitive data (health, religion, etc.) is collected on purpose; no profiling, advertising or automated decisions; no data is sold. Hosting database and website: Render, Frankfurt (Germany, EU).

---

## 1. Accounts / Comptes

| | |
|---|---|
| Purpose | Let people log in, keep favorites, use member features; protect accounts from guessing |
| Data | Email, display name, password (stored only as a bcrypt hash), admin / member / volunteer flags, member expiry date, email-verified date, last login date, failed-login counter and lock time, date of last password change, inactivity-warning date. Short-lived reset and email-verification tokens (stored hashed). Login session (cookie `umasbooks.sid`, session row in the database). |
| People | Website account holders, volunteers, members, admins |
| Legal basis | Contract (the service they asked for); legitimate interest (account security) |
| Recipients / processors | Render (hosting and database); Google Workspace/Gmail (sends verification and reset emails); Have I Been Pwned (password check, see below); GitHub and Backblaze (backup copies) |
| Transfers outside EU | Google, GitHub, Backblaze are US companies: covered by their standard contractual clauses / EU-US Data Privacy Framework (confirm per provider in `processors-checklist.md`). Have I Been Pwned: only the first 5 characters of a hash of the password are sent, never the email. |
| Retention | Until the person asks for deletion, or **3 years without login** (`inactiveAccountYears`). A warning email goes out first and deletion follows 30 days later unless they log in (`inactivityWarningDays`). Never auto-deleted: admins and people with a current membership. Reset and verification tokens: removed 7 days after they expire (`tokenGraceDays`). Sessions: cookie lasts 30 days of inactivity; expired session rows are cleaned by the session library. **Automated** in code (`purgeExpiredPersonalData`, runs at start-up and daily). Manual erase: admin > Members > Erase Member. |
| Security | HTTPS; password hash only; login lockout after failed attempts; HIBP check on new passwords; admin area restricted and CSRF-protected; database access limited to Render and the backup job; backups in a private repository and a private encrypted bucket |

To answer an access or portability request ("a copy of my data"), use admin > Members > member > **Download data (JSON)**.

## 2. Orders and payments / Commandes et paiements

| | |
|---|---|
| Purpose | Sell books and drop-in sessions online; confirm orders; keep accounting records |
| Data | Buyer name, email, phone (optional), items and prices, total, status, dates, an order access token, and the HelloAsso checkout/order numbers. Card details never reach us (entered on HelloAsso). |
| People | Online buyers (with or without an account) |
| Legal basis | Contract; legal obligation (accounting, 10 years) |
| Recipients / processors | HelloAsso (payment page, receives buyer name and email to create the payment); Render; Google Workspace/Gmail (confirmation emails); GitHub and Backblaze (backups) |
| Transfers outside EU | HelloAsso and Render: EU. Google/GitHub/Backblaze as above. |
| Retention | **10 years** (`accountingYears`), then the order and its items are deleted (automated daily). Exception: orders still `pending` are never deleted by the purge (they turn into `expired` or `cancelled` within minutes or hours, and those *are* purged at 10 years). **Gap:** unpaid (expired/cancelled) orders have no accounting value but are kept the full 10 years with name, email and phone. If you want to shorten this, it needs a code change. On an erasure request the buyer data is replaced by "Erased" and the access link is rotated, but the amounts and items stay (legal obligation). |
| Security | As in section 1; order pages need a secret link; payment data stays at HelloAsso |

## 3. Book reservations / Réservations de livres

| | |
|---|---|
| Purpose | Hold a book for pickup and pay in the shop; send one pickup reminder |
| Data | Name, email, phone, date of reservation (stored on the book copy) |
| People | Visitors who reserve a book |
| Legal basis | Contract (their request) |
| Recipients / processors | Render; Google Workspace/Gmail (reminder email); GitHub and Backblaze (backups) |
| Transfers outside EU | Google, GitHub, Backblaze as above |
| Retention | **14 days** (`RESERVATION_TTL_DAYS`). After that name, email, phone and date are cleared and the book goes back on the shelf. The job runs at start-up and every 6 hours. **Automated.** A reminder is emailed 3 days before the end. |
| Security | Reservation details are shown in the admin area only |

## 4. Event and session sign-ups / Inscriptions aux événements et séances

| | |
|---|---|
| Purpose | Manage attendance and capacity for events and English sessions (classes) |
| Data | Name, email, date of sign-up (children may be registered by a parent: the parent's details are the ones stored) |
| People | Attendees; parents/guardians |
| Legal basis | Contract |
| Recipients / processors | Render; Google Workspace/Gmail if an admin emails attendees; GitHub and Backblaze (backups) |
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
| Recipients / processors | HelloAsso. For the payment itself HelloAsso is an **independent controller** (stated in our policy; confirm on their legal page, see checklist). Render; GitHub and Backblaze (backups). |
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
| Recipients / processors | Google Workspace/Gmail only. The contact form sends an email to admin@umasbooks.org (or `CONTACT_TO`). **Nothing is stored in the database.** Other forms open the visitor's own mail app. |
| Transfers outside EU | Google: US company; check the DPA and its transfer clauses (see checklist) |
| Retention | Policy says: until the sender asks for deletion. **NOT AUTOMATED.** The inbox is never cleaned by code. Decide a rule (for example delete messages after 2 years) and write it here: ______________ |
| Security | Google account protected by 2-step verification (**to confirm**: ____ ); only volunteers who need the inbox have access |

## 7. Forum, charity votes, volunteer shifts, meetings / Forum, votes, bénévolat, réunions

| | |
|---|---|
| Purpose | Member community features: forum posts and replies, voting for charities and suggesting ideas, volunteer shift sign-up, meeting RSVPs, favorite books |
| Data | Forum posts and replies (title, text, date), charity votes and ideas, shift sign-ups, meeting RSVPs, favorites, all linked to the account |
| People | Logged-in members and volunteers |
| Legal basis | Contract; for forum posts, the person's choice to publish them |
| Recipients / processors | Other members see forum posts. Render; GitHub and Backblaze (backups) |
| Transfers outside EU | As above for backups |
| Retention | While the account exists. When the account is erased: votes, RSVPs, shift sign-ups and favorites are deleted; **forum posts and charity ideas are kept with no author** (their text stays; a post that contains personal details written by the member will remain, so check by hand if the person asks). |
| Security | Forum and community pages need a logged-in member (checked in the code) |

## 8. Error alerts and server logs / Alertes d'erreur et journaux

| | |
|---|---|
| Purpose | Know when the site breaks; keep it running; limit abuse |
| Data | Server logs at Render (technical details, IP addresses as seen by the host). Application log lines do not contain emails (see `ARCHITECTURE.md`). Error alert emails to admin@umasbooks.org contain an error message and technical stack trace, at most one every 15 minutes. |
| People | Visitors and members (technical data only) |
| Legal basis | Legitimate interest (security and reliability) |
| Recipients / processors | Render (logs); Google Workspace/Gmail (alert emails) |
| Transfers outside EU | Render logs: Frankfurt, EU (**confirm** on the Render dashboard). Alert emails: Google. |
| Retention | Policy says "a few weeks at most". **NOT controlled by our code.** It depends on the Render plan; check the log retention shown in the Render dashboard and write it here: __________. Alert emails sit in the inbox until deleted (**NOT AUTOMATED**). |
| Security | Logs are only available to people with Render access |

Also note: the website's pages load typefaces from Google Fonts, so a visitor's IP address is sent to Google when a page loads (disclosed in the privacy policy). Consider hosting the fonts ourselves in future to remove this.

## 9. Backups / Sauvegardes

| | |
|---|---|
| Purpose | Recover from a failure or loss of the hosting account |
| Data | A full copy of the database every night (so: everything in sections 1 to 7) |
| People | Everyone in the database |
| Legal basis | Legitimate interest (continuity); same bases as the original data |
| Recipients / processors | GitHub (private repository, branch `db-backups`); Backblaze B2 (private bucket, EU region, default encryption on, per the README) |
| Transfers outside EU | GitHub: US company. Backblaze: the bucket is in an EU region (**confirm** the bucket region in the B2 console); Backblaze is a US company. |
| Retention | **GitHub:** the nightly job keeps the newest 30 dump files in the branch. **Gap to know about:** older files are removed from the latest version of the branch but remain in Git's history, so they are not truly gone. This is not what the privacy policy says (30 days). To fix it properly the branch history would have to be rewritten or the GitHub copy stopped (the README already suggests deciding this once Backblaze is proven). **Backblaze:** the code never deletes anything; deletion depends on lifecycle rules set by hand in the Backblaze console: the README says nightly files hidden after 35 days and monthly files after 730 days (2 years). **Check that these rules exist** (**NOT AUTOMATED / not visible in the code**). Policy says "30 days nightly, up to 2 years monthly", so the 35 days differs by a few days. A deletion request therefore disappears from backups only after those periods. |
| Security | Private repository (the job refuses to run if the repository is public); private bucket with encryption; access keys limited to the one bucket; monthly automatic restore test; failure emails to admin |

---

## Open points for the volunteer in charge / Points à traiter

1. Fill in the blanks above (inbox retention rule, Render log retention, Google 2-step verification, B2 region and lifecycle rules).
2. Sign the data processing agreements listed in `processors-checklist.md`.
3. Decide about the old GitHub backup history (section 9) and about keeping unpaid orders for 10 years (section 2).
4. Re-read this file once a year, and whenever a new feature collects personal data.
