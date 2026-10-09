# French review checklist

For Sharon (or anyone who reads French well). The site is fully translated; this is the list of what is worth **reading with your own eyes** because customers see it most, or because the words matter legally or for money. About an hour, with a coffee.

## How to see French

* **Pages**: open the site and press **FR** at the top right (the choice is remembered in a cookie called `umasbooks_lang`). Pages that need a login: log in first, then press FR. Use the **test site (staging)** to try things freely (runbook, section "Test system (staging)"): nothing there is real and no email reaches real people.
* **Tip**: ask for French permanently in your browser (Settings, Languages, put French first): a visitor with no cookie then gets French by default.
* **Emails** go out in the language the person had **when they created the account or the reservation** (`users.lang`, `orders.lang`). To receive one in French: press FR **before** you sign up or reserve (on the test site). They arrive at the address set as `STAGING_MAIL_TO` on the test site. The admin "Send a test email" button (Admin, Email outbox) sends one fixed English test message and cannot show the real templates, so use the steps in the table below.
* **To print every French text of every page at once** (developers): from `umas-books/`, run `node scripts/i18n-audit.js --dump` and read `/tmp/i18n-fr-dump.txt` (one line per text, with the page it comes from). `node scripts/i18n-audit.js` alone prints the English still left (should be nothing).

## The 30 things to read

Tick them off. Write anything that sounds wrong, stiff or too literal in the last column.

### Pages (switch to FR first)

| # | Screen | Where | Look at |
|---|--------|-------|---------|
| 1 | Home page | `/` | the hero, the three cards, the footer |
| 2 | Books (browse and search) | `/books.html` | filters, "Nouveautés", the "Demandez-nous" box |
| 3 | A book page | `/books/<any id>` | condition names, "Prix et classements", the no-returns notice, "Ajouter au panier" |
| 4 | Cart | `/cart` (add a book first) | the reservation form, the CGV tick box, the free-and-no-commitment sentence |
| 5 | Reservation recorded | after pressing "Réserver" | deadline sentence, how to cancel, shop hours |
| 6 | Reservation (cancelled, collected) | `/account`, open a reservation | status words |
| 7 | Log in / Sign up / Forgot password | `/login`, `/signup`, `/forgot-password` | error messages (wrong password, empty fields) |
| 8 | Email confirmation page (bad link) | `/verify-email/abc` | the "lien invalide" wording |
| 9 | My account | `/account` | the pills, "Mes réservations", "Mes demandes de livres" |
| 10 | Privacy: download or delete my data | `/account/privacy` | the warnings before deleting |
| 11 | Two-step verification | `/account/2fa` | the setup steps |
| 12 | Events and calendar | `/events` | month names, "inscrits", "Paiement sur place" |
| 13 | Drop-in sessions | `/sessions` | "places restantes", "Ajouter au panier" |
| 14 | Membership | `/membership.html` | the benefits, the HelloAsso notice, "Vous êtes membre jusqu'au" (date shown as 2027-04-27 on purpose, see below) |
| 15 | Contact | `/contact` | topics and thank-you message |
| 16 | Ask for a book | `/request-a-book` | the whole page |
| 17 | Volunteer page (public) and shifts (volunteer) | `/volunteer.html`, `/volunteer` | |
| 18 | Members area: dashboard, announcements, forum, meetings, charity vote | `/dashboard` and the links on it (log in as a member) | "Espace membres" |
| 19 | Immersion pages | `/programs.html`, `/immersion.html`, `/pre-registration.html` | |
| 20 | Error pages | `/nothing-here` (404); try a form after waiting a day with the page open (session expired) | |

### Emails (in French, on the test site)

| # | Email | How to get it |
|---|-------|---------------|
| 21 | Confirm your address / choose your password | press FR, then Sign up with a new address |
| 22 | "Someone tried to sign up with your address" | press FR, sign up again with an address that already has an account (the email goes to the account's own language) |
| 23 | Reset your password | FR, Forgot password, an existing account |
| 24 | Reservation confirmation | FR, log in, reserve a book. **Note:** the legal rights block at the bottom is now French only for a French reservation (it was French and English); the English email is unchanged |
| 25 | Pickup reminder (day 10), "reservation ended", drop-in seat reminder | wait for the daily job, or ask a developer to run it on the test site; see runbook, "Background jobs" |
| 26 | Book request: confirm your request, "your link", "we found your book" | FR, `/request-a-book`; the last one when an admin matches the request to a copy and presses "Notify" |
| 27 | Account deleted (goodbye) | FR, Account, Privacy, delete (use a throwaway account) |
| 28 | Inactive-account warning | needs an account unused for almost 3 years: read it in the code (`src/lib/privacy.js`) instead |
| 29 | Post removed from the forum (statement of reasons) | as admin, hide a forum post written by a French-language account |
| 30 | The contact form message you receive (English by design, it goes to the admins) | send one from `/contact` |

## Choices I made that you may want to change

See "Questions for the maintainer" at the end of `docs/i18n-audit.md` (spelling "e-mail", "drop-in", the date on the membership page, the French-only legal block in the reservation email, tone).

## What "good French" means here

`vous` everywhere. Words: réservation, adhésion / adhérent(e), bénévole, librairie, livre d'occasion, état (Neuf, Comme neuf, Très bon état, Bon état, État correct), reliure (Poche, Broché (grand format), Relié), panier, retrait en boutique, régler sur place, mot de passe, e-mail, Se connecter, Créer un compte, Espace membres. Prices `12,50 €`, a no-break space before `: ; ! ?` and `€`, French dates (`lundi 12 octobre`, `14 h`). 0 and 1 are singular (`0 vote`, `1 inscrit`).
