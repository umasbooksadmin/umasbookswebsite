# Manual test scripts (before launch)

Plain-language checklists for testing the whole site by hand, one script per
kind of user. There are exactly **five kinds of user**, and every script is
written for one of them (a sixth script collects edge cases). Written for the
maintainer (not a developer). No tools needed beyond a browser and a mailbox
you can read.

| # | Kind of user | Who that is | Step ids |
|---|---|---|---|
| 1 | **Guest** | Anyone who is not logged in. Browses everything public, can fill a cart and use the contact and book-request forms. **Cannot reserve**: "Reserve (free, no commitment)" asks them to log in or create an account first. | `G` |
| 2 | **Account holder** | Logged in, email confirmed, **not** a paying member (`is_member` false, not a volunteer). Creating an account never needs membership. This is who **reserves** books and drop-in seats (nothing is paid online: they pay at the shop or at the session). | `AC` |
| 3 | **Member** | An account holder who also paid the membership fee (`is_member` true): a HelloAsso payment matched by email (lasts 365 days) or an admin pressing **Mark as Member** (no end date). A member has an account but has not necessarily reserved anything. | `M` |
| 4 | **Volunteer** | Marked as volunteer by an admin. Also passes every member check. | `VO` |
| 5 | **Admin** | Runs the shop. Two-step verification is required. | `A` |
| 6 | Edge cases | Cut across all of the above. | `E` |

Written against the site as of 7 October 2026: books and drop-in seats are **reserved online and paid in person** (at the shop, or at the session for a drop-in seat); **only the membership is paid online**, through HelloAsso. Includes pull request #181
(no login until the email is confirmed) and #191 (the sign-up form asks only
for name and email; the password is chosen after the confirmation link).
Things I could
not verify from the code are marked **TODO**.

## Where did the old steps go?

The scripts used to be split differently (six scripts, with browsing, buying and
sign-up in different places). They now follow the five kinds of user above. **No step was dropped**:
this table lists every step whose id changed. Ids that are not listed (`VO1` to
`VO7`, all `A...` and `E...` steps) are unchanged.

* The old browsing steps `V1` to `V46` became `G1` to `G46` (the same number).
* The old buying steps: the cart steps `G1` to `G3` became `G47` to `G49`
  (a guest can fill a cart). The buying steps `G4` to `G24` became `AC22` to
  `AC42` (buying needs an account). Since 7 October 2026 these are **reservation**
  steps (reserve online, pay in the shop): the ids stay, the steps were rewritten.
  `AC38`, `AC38a`, `AC39`, `AC40`, `AC41` and `AC42` used to be about abandoning
  a HelloAsso payment; they are now about cancelling, the limits, the deadline,
  and the back button. New steps: `AC56`, `AC57` (the 10-book and 24-hour limits),
  `A24h` to `A24l` (pickup list, partial pickup, extend / cancel / no-show,
  Reservations report, lowering the amount).
  **Retired** (they only made sense with online payment of books and seats):
  `A24e` (a refund done in HelloAsso noticed by the site) and `A24g` (cancelling
  an unpaid reservation).
* The old sign-up steps: sign-up, login, password and account steps became `AC...`;
  membership, forum, charity and meetings steps became `M...`; `M23` (logged-out
  forum) became `G52`.
* New steps with no old id: `G50`, `G51` (checkout asks a guest to log in),
  `AC2` is reworded, `AC43`, `AC43b` (two-step for an ordinary account),
  `AC44` to `AC50` (member pages must not open for an account holder),
  `M3`, `M12` to `M14` (marking as member, announcements, how long membership lasts),
  `VO8` (a volunteer also reaches the member pages), and the new membership
  flow: `G53` to `G56` (guest: the name and email form), `AC51` to `AC54`
  (account holder: payment form only, "Check my membership"), `M15`, `M16`
  (member status text, renewal window), `A42` (Mark as Member gives no end date).
  The pre-registration and volunteer forms became server forms (they no longer
  open your email app): `G57` to `G60` and the FR check (forms) in 1K; `G61`
  (book covers served from this site); `AC55` (the HelloAsso form loads only
  after you press **Show the HelloAsso form**).
* `AC2` (old `M2`, a weak password typed on the sign-up form) now checks that
  the sign-up form has no password box; the weak and breached password checks
  moved to `AC2b`, on the choose-your-password page.

| Old id | New id | Old id | New id | Old id | New id | Old id | New id |
|---|---|---|---|---|---|---|---|
| V1 | G1 | V2 | G2 | V3 | G3 | V4 | G4 |
| V5 | G5 | V6 | G6 | V7 | G7 | V8 | G8 |
| V9 | G9 | V10 | G10 | V11 | G11 | V12 | G12 |
| V13 | G13 | V14 | G14 | V15 | G15 | V16 | G16 |
| V17 | G17 | V18 | G18 | V19 | G19 | V20 | G20 |
| V21 | G21 | V22 | G22 | V23 | G23 | V24 | G24 |
| V25 | G25 | V26 | G26 | V27 | G27 | V28 | G28 |
| V29 | G29 | V30 | G30 | V31 | G31 | V32 | G32 |
| V33 | G33 | V34 | G34 | V35 | G35 | V36 | G36 |
| V37 | G37 | V38 | G38 | V39 | G39 | V40 | G40 |
| V41 | G41 | V42 | G42 | V43 | G43 | V44 | G44 |
| V45 | G45 | V46 | G46 | G1 | G47 | G2 | G48 |
| G3 | G49 | G4 | AC22 | G5 | AC23 | G6 | AC24 |
| G7 | AC25 | G8 | AC26 | G9 | AC27 | G10 | AC28 |
| G11 | AC29 | G12 | AC30 | G13 | AC31 | G14 | AC32 |
| G15 | AC33 | G16 | AC34 | G17 | AC35 | G18 | AC36 |
| G19 | AC37 | G20 | AC38 | G21 | AC39 | G22 | AC40 |
| G23 | AC41 | G24 | AC42 | M1 | AC1 | M2 | AC2 |
| M3 | AC3 | M4 | AC4 | M5 | AC5 | M6 | AC6 |
| M7 | AC7 | M8 | AC8 | M9 | AC9 | M10 | AC10 |
| M11 | AC11 | M12 | AC12 | M13 | M1 | M14 | M2 |
| M15 | M4 | M16 | AC13 | M17 | AC14 | M18 | AC15 |
| M19 | AC16 | M20 | M5 | M21 | M6 | M22 | M7 |
| M23 | G52 | M24 | M8 | M25 | M9 | M26 | M10 |
| M27 | M11 | M28 | AC17 | M29 | AC18 | M30 | AC19 |
| M31 | AC20 | M32 | AC21 | | | | |


## How to use these scripts

- Work through one script at a time. Each script takes about 20 to 40 minutes.
- Tick `[ ]` as you go. Write any failure in the results table at the end,
  with the step number (for example `AC25`) and what you saw instead.
- **(must)** marks the most important steps: money, legal text, login, and
  anything that could lose or leak data. Do those first if you are short on time.
- **You should see:** is the expected result. If it is different, that is a
  failure, even if it looks fine to you.
- **FR check:** means switch the site to French (click **FR** at the top right)
  and check that the French is correct: titles, buttons, error messages,
  prices, emails.
- A step starting **Known:** describes something that works differently from
  what you might expect. It is not a test failure; it is listed so you are not
  surprised.
- Admin pages are English only. That is intended.
- Use a private/incognito window for every "not logged in" script, and a second
  browser (or a second private window of a different browser) when a step says
  "someone else".

- Step ids start with the kind of user: **G** guest, **AC** account holder,
  **M** member, **VO** volunteer, **A** admin, **E** edge case.


## Before you start

### 1. Which site, and is it safe to test?

- Test on the real site only while it still holds sample and test data (preview
  mode on) or on a copy. Never run the reservation scripts against real customers (a reservation holds real books).
- **Preview mode** (Render environment variable `PREVIEW_MODE=true`, runbook
  section g): the site shows a "Preview" banner, and **reservations and payments
  are switched off** (the cart's reserve button and the membership form). Script 1 and
  most of scripts 2 and 3 work in preview mode. The reservation steps (script 2, 2F to
  2H, the reservation steps in script 5) and the payment step M1 in script 3 only work with
  preview mode **off**.
- **Only the membership is paid online.** Books and drop-in seats are reserved
  on the site and paid in the shop, so no reservation step needs HelloAsso, a card
  or a sandbox. Everything below about HelloAsso applies to the **membership
  payment (M1)** only.
- **TODO (ask the developer before the first membership payment test):** which HelloAsso
  the live service is connected to. Payment in test mode needs the Render
  environment variables `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`,
  `HELLOASSO_ORG_SLUG` and `HELLOASSO_API_BASE` to point at the **HelloAsso
  sandbox** (`https://api.helloasso-sandbox.com/v5`, which needs a separate
  sandbox HelloAsso account; production and sandbox keys are not
  interchangeable). If the service still has the real keys, a "test" payment
  would be a real payment. Do not enter a real card unless you accept a real
  charge that you will refund.
- **TODO (HelloAsso sandbox details unknown):** the sandbox login, the test
  card number to type on the sandbox payment page, and the sandbox membership
  form are not written down in this repository. Find them in HelloAsso's
  developer documentation (dev.helloasso.com, "sandbox") and write them in the
  box below once, so the next tester does not have to look.
  Sandbox test card: ______________________  Sandbox account: ______________________
- **Known:** the membership payment form (membership page) is HelloAsso's own
  form embedded in the page, pointing at the real organisation page. It does
  not follow `HELLOASSO_API_BASE`. So membership payment cannot be tested in
  sandbox mode at the moment (see M1). **TODO** confirm with the developer.

### 2. Accounts you need

Use **throwaway** accounts. Never use a real member's account.

| Kind of user | How to get it | Notes |
|---|---|---|
| Guest | No account. Private window. | |
| Account holder | Sign up yourself in script 2 with an address you can read, for example `YOU+account1@gmail.com` (Gmail delivers `+anything` to your inbox). Use a different `+` for every test account. | Signing up does **not** make you a member, and an account needs no membership. This is also the account that reserves (script 2F onwards). Keep one account holder that is **never** made a member, for AC44 to AC50. |
| Member | A second throwaway account, confirmed like the first, that an admin marks as member (M3: **Mark as Member**; or a real HelloAsso payment, M1). | Has an account, but has not necessarily reserved anything: nothing in script 3 needs a reservation. |
| Volunteer | A third throwaway account that an admin marks as volunteer (script 4). | |
| Admin | Your own admin account, plus a second throwaway admin (script 5, A2) so you can test two-step set-up and reset without risking your own access. | The first admin is created at start-up from the Render values `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (runbook section c). |

**Seeded persona accounts (local or CI copy only, not the live site):** the
script `umas-books/scripts/sitemap/seed-crawl-accounts.js` creates
`crawl-account@`, `crawl-member@`, `crawl-volunteer@` and `crawl-admin@`
`example.test`. Their shared password is the `PASSWORD` constant at the top of
that script (written here as `<CRAWL_PASSWORD>`; look it up there, do not paste
it anywhere public). These addresses cannot receive email, so they cannot be
used for any step that needs an email link. They are for developers' automated
crawl, not for this checklist.

### 3. Mailbox

You need to read the mailbox of every address you use. Emails come from the
shop's Gmail sender; check the spam folder if nothing arrives within 2 minutes.
Emails are sent in the language the site was in when you signed up, reserved, or
asked for a book (for a logged-in member, the language saved on their account).

### 4. Language and cookies

The language buttons are at the top right: **EN | FR**. Your choice is
remembered in your browser. Use a private window to start from "no choice yet":
the site then follows the browser's language.

## Test data

Add these test books in admin first (script 5, A6 to A12) or make sure the
sample books already exist. All are real ISBN-13s that exist in Open Library
(checked, the check digits are valid and Open Library returns a record for
each), so the ISBN lookup should find a title and cover:

| ISBN | Book | Use it for |
|---|---|---|
| 9780141036144 | Nineteen Eighty-Four (Penguin) | A normal used paperback; also "very good" condition |
| 9780451524935 | 1984 (Signet Classic) | Mass market paperback: suggested price should be low (default 5 euros) |
| 9780743273565 | The Great Gatsby | Several copies of the same book (clearance rule), different conditions |
| 9780747532743 | Harry Potter and the Philosopher's Stone | A "New" copy at publisher's price (publisher's price is printed on the book; for the test invent one, for example 12.00) |
| 9780060935467 | To Kill a Mockingbird | Hardback/trade and awards test |
| 9780141439518 | Pride and Prejudice | Request-a-book test (do NOT add it to stock until you have asked for it, R3) |
| 9782070360024 | L'Etranger (Folio) | A French-language book |
| 9780439023481 | The Hunger Games | Spare |

Other test values: a name such as `Test Buyer`, a phone `0600000000` (optional
field), a throwaway password `Test-Password-2026!` (any password with 8+
characters, upper and lower case, a number and a symbol, which is not in a known
data breach; the site rejects leaked passwords, so if it complains, choose
another).

## Script 1. Guest (not logged in)

Use a private window. Time: 35 to 45 minutes. A guest browses, searches, fills a cart, and can use the forms; to reserve, they must log in or create an account (see 1I and script 2).

### 1A. Home, menu, footer

- [ ] **G1 (must).** Open the home page `/`. **You should see:** the Uma's Books & Adventures page, a menu (Home, Browse Books, English Programs, Events), icons at the top right (heart, receipt/account, cart with a number, key, person, **EN | FR**), and a footer with **Contact Us**, **Albi, France**, **Privacy Policy**, **Terms of Sale**, **Legal Notice**.
- [ ] **G2.** Click each footer link. **You should see:** each page opens, no error page. (The footer has an Instagram icon that opens the association's page in a new tab; there is no Facebook icon until a real address is set in `SOCIAL_LINKS`, `umas-books/src/lib/legal.js`. The Instagram link is not part of this click-through.)
- [ ] **G3.** Click the key icon (Member's Access) while logged out. **You should see:** the membership page (not a login form).
- [ ] **G4.** Click the person icon. **You should see:** the Log in page with "Forgot your password?" and "Create an account" links.

### 1B. Preview banner and reservations off (only while `PREVIEW_MODE` is on)

- [ ] **G5 (must).** Look at the top of any page. **You should see:** a banner "Preview — Uma's Books is opening soon. You're looking at a test version with sample books: nothing here is real yet and no payment is taken." with a link **Tell us what you think!**
- [ ] **G6.** Click **Tell us what you think!** **You should see:** the contact form with the topic already set to "Feedback on the preview".
- [ ] **G7 (must).** Add any book to the cart, open the cart. **You should see:** the cart, the total, and the message "Online reservations open when we launch. This is a preview, so you can fill a cart to see how it works, but nothing can be reserved yet." and **no** Name/Reserve form.
- [ ] **G8 (must).** Open the membership page `/membership.html`. **You should see:** "Membership opens at launch" and **no** payment form.
- [ ] **G9.** Open `/robots.txt`. **You should see:** a line `Disallow: /` (search engines told to stay away). After launch (preview off) this line must be gone: re-check at launch.
- [ ] **FR check.** Switch to FR on steps G5, G7, G8. **You should see:** the banner, the cart notice and the membership notice in French ("Aperçu — Uma's Books ouvre bientôt...", "Les réservations en ligne ouvriront au lancement...", "L'adhésion ouvrira au lancement").
- [ ] **G10.** (Preview **off** only.) None of the above appears; the cart no longer shows the preview notice. A guest then sees the prompt to log in or create an account (G50), not a reserve form.

### 1C. Books: search, filters, book page

- [ ] **G11 (must).** Open **Browse Books** (`/books.html`). **You should see:** a search box ("Search by title, author, keyword, or genre…"), genre buttons, a "New In" carousel with arrows and **See All New In**.
- [ ] **G12.** Type part of a title you know (for example `Gatsby`) and press **Search**. **You should see:** a results grid with covers, titles, prices, condition labels. A search with no match should show a "no results" message, never an error or a blank page (report it if blank). (At most 60 books are listed.)
- [ ] **G13.** Click a genre button. **You should see:** only books of that genre. Click another genre; the list changes.
- [ ] **G14.** Click the arrows on "New In" and **See All New In**. **You should see:** the carousel moves; the full new-arrivals list opens.
- [ ] **G15 (must).** Open a book with stock (click a card). **You should see:** cover (or "No cover"), title, "by <author>", **Binding** (Mass Market / Trade / Hardback / Other; FR: Poche / Broché (grand format) / Relié / Autre) when known, the lowest price as `€x.xx` (`x,xx €` with the site in FR) with "Price incl. tax, TVA non applicable" under it (FR: "Prix TTC, TVA non applicable"), "Available in Shop", "N copies on our shelves.", a table **Condition / Price** with an **Add to Cart** button per copy, a note that cover images may not show the real condition of the copy, the friendly used-book note ("Our second-hand books are sold as described, so please read the condition grade, and ask us if you have any question." followed by "Used books: no returns or exchanges for a change of mind in the shop. For online orders, your statutory 14-day right of withdrawal and the legal guarantees still apply." and a link to the Terms of Sale), and "More by <author>" if there are others. **The note must never say that your legal rights are waived.**
- [ ] **G16 (must).** Open **What the grades mean**. **You should see:** the line "The grade is the description of the book: please read it before you buy." and four grades with descriptions: New, Very Good, Good, Acceptable.
- [ ] **G17.** Find a book with a clearance copy. **You should see:** a **Clearance** badge next to the price (on the book page and in the results).
- [ ] **G18.** Find a book with awards. **You should see:** a line "Awards & lists: ..." (more than 8: **Show all (N)**). Nothing appears for a book with no award.
- [ ] **G19.** Open a book with no copy in stock. **You should see:** "Currently unavailable" and "All copies of this title are spoken for right now — check back soon."
- [ ] **G20.** Click the heart on a book, then open the heart icon at the top (`/favorites`). **You should see:** the book listed. **Known:** favorites are saved in this browser only ("Books you've hearted on this device"), not in an account.
- [ ] **G80. Marketing pages without inline scripts.** Open Home, Books, Events, Blog, Membership, Volunteer and Pre-registration. **You should see:** each page works as before: the **EN / FR** toggle changes the page, the newest books and the events schedule load, the blog list and home carousel show, the forms show errors and send, and on Membership (logged in) the HelloAsso form appears only after pressing **Show the HelloAsso form**. (The page's strings now travel as a data block and the scripts are separate files, so the site's security policy no longer needs to allow inline scripts.)
- [ ] **G21 (must). Copy with no price.** Find a book that has a copy with no price (in admin, add a used copy and leave Price empty, A11). **You should see:** that copy shows **Ask in the shop** (French: **Se renseigner en boutique**) instead of a price, with **no Add to Cart** button, and the headline price ignores it.
- [ ] **FR check (books).** Switch to FR on the search page, a book page, the grade legend. **You should see:** "Parcourez les livres" menu, "Disponible en boutique", "Ajouter au panier", conditions "Neuf / Bon état / Très bon état / État correct", "Déstockage" badge, "Reliure : Relié / Broché / Poche", "Prix et classements :", "Actuellement indisponible". **Known:** prices show as `€12.50` in both languages on the book page, cart and reservation email. The French style `12,50 €` is only used in book-request emails. Decide whether you want it everywhere and tell the developer; this is not a tester error.

### 1D. Events, English programs, blog

- [ ] **G22 (must).** Open **Events** (`/events`). **You should see:** a calendar with **Month / Week**, **Previous / Next**, upcoming events, "Everyone's welcome — browse what's coming up and sign up below, no account needed." An event with a price also says "Payment on the day" (events are never paid on the website).
- [ ] **G23.** Sign up for an event with a name and email (use `YOU+event1@gmail.com`). **You should see:** back on the calendar; the event shows one more "going". Signing up again with the same email does not add a second place. **Known:** no confirmation email is sent for events. A full event shows **Full** and no sign-up form.
- [ ] **G24.** Click **Add to My Calendar**. **You should see:** a calendar file (.ics) downloads and opens in your calendar app.
- [ ] **G25.** Open **English Programs** (`/immersion.html`), then `/programs.html` and `/pre-registration.html`. **You should see:** the English Immersion pages, with links **Preregister**, **Check upcoming sessions**. **Known:** the pre-registration form and the volunteer form on `/volunteer.html` are real forms that send an email to the shop mailbox (they no longer open your email app); nothing is stored on the site. See 1K (G57 to G60) for what they check.
- [ ] **G25a.** Open `/visit.html`, then `/membership-terms.html` and `/privacy-policy.html` (English). **You should see:** on the visit page "Wed – Sat", the hours "14:00–19:00" and "Extra opening hours when volunteers are available: see our Instagram." (Instagram is a link that opens the association's page in a new tab); on the membership terms "Last updated: 6 October 2026." and, under "Right of withdrawal", "If you join online you may withdraw within 14 days by writing to admin@umasbooks.org; we will refund your payment and the membership then ends."; in the privacy policy, under "Who receives your data", a line for GitHub (United States) saying it runs the automatic backup job and that the database copy passes through it briefly before Backblaze, and, under "How long we keep it", "Render keeps platform logs for 14 days" and "Accounts with a current membership are not deleted automatically".
- [ ] **G25b.** Switch to FR and reload the same three pages. **You should see:** the hours as "14 h–19 h" (a space between the number and "h"), "Si vous adhérez en ligne, vous pouvez vous rétracter dans les 14 jours en écrivant à admin@umasbooks.org ; nous vous remboursons et l’adhésion prend fin.", "La cotisation est versée à l’association et régie par ses statuts", "voter pour l’œuvre caritative que nous soutenons" and the GitHub (États-Unis) line.
- [ ] **G25c.** Only once the maintainer has set `MEMBERSHIP_PRICE_EUR` and `SHOP_STREET_NUMBER` in `src/lib/legal.js` (both are empty for now: `docs/legal-todos.md`). **You should see:** on the membership page, above the join form, "Membership fee: <price> for 12 months, paid on the HelloAsso form." (and nothing at all while it is empty); and "<number> rue Peyrolière" in the legal notice, the visit page and the pickup lines.
- [ ] **G25d.** Scroll to the footer of any page (home, Visit, Books), in English and then in FR. **You should see:** a small coloured map of the streets around the shop in Albi with red arrows showing the route from Rue de l'Oulmet along Rue Peyrolière to the impasse and the "Uma's Books & Adventures" label (full width on a phone, no wider than about 420 pixels on a computer, no sideways scrolling, nothing jumps when it loads), captioned "Albi, France: Rue Peyrolière" (FR: "Albi, France : rue Peyrolière"). Clicking the map opens the larger image. Hovering the image or using a screen reader gives "Map showing the route to Uma's Books and Adventures from Rue de l'Oulmet along Rue Peyrolière to the impasse, Albi" (FR: "Plan de l’itinéraire vers Uma’s Books and Adventures depuis la rue de l’Oulmet, par la rue Peyrolière jusqu’à l’impasse, Albi"). The browser makes no request to any other website for it. (The automatic e2e run checks the English part as G25d and the French part as G25e.)
- [ ] **G26.** Open the sessions calendar (`/sessions`). **You should see:** "Upcoming Sessions" with filters **All Sessions, Drop-ins Only, Little Explorers, Adventurers, Readers, Teens, Café / Adults**, and **Month / Week**. Each session shows "N places left" or **Full**; a drop-in session with a price shows **Add to Cart**.
- [ ] **G27.** Open the blog (`/blog.html`) and one post. **You should see:** published posts only (not drafts); a post opens with a back link; an unknown post address shows a "not found" message.
- [ ] **FR check.** Switch to FR on events, sessions and blog. **You should see:** "Événements", "Mois / Semaine", "Précédent / Suivant", "Complet", "Ajouter au panier", "Place drop-in".

### 1E. Contact form

- [ ] **G28 (must).** Open **Contact Us**. Fill in name, email, topic, message and press **Send message**. **You should see:** "Thank you! Your message has been sent". Topics are General question, Books & reservations, English programs, Events, Donating books, Membership, Other (plus "Feedback on the preview" in preview mode).
- [ ] **G29 (must).** Check the shop mailbox `admin@umasbooks.org`. **You should see:** your message (within 2 minutes). Reply-to is the address you typed.
- [ ] **G30.** Send 6 messages in a row. **You should see:** after the 5th in 15 minutes: "Too many messages from this connection — please try again in a little while, or email admin@umasbooks.org." Do not repeat this more than once.
- [ ] **FR check.** In French, submit the form with a message. **You should see:** "Merci ! Votre message a été envoyé" (and the rate-limit message in French).

### 1F. Request a book (no account)

- [ ] **G31 (must).** Open `/request-a-book` ("Can't find a book? Ask us"; also linked from Browse Books). Enter **Title** `Pride and Prejudice`, ISBN `9780141439518`, your email, name, and **Send request**. **You should see:** "Check your inbox" and the line that the request only counts once you have confirmed.
- [ ] **G32.** Leave the title empty and send. **You should see:** "Please tell us the title of the book." An ISBN of 5 digits gives "The ISBN should have 10 or 13 digits (or leave it empty)."
- [ ] **G33 (must).** Open the email "Please confirm your book request at Uma's Books". Click its link. **You should see:** "Confirm your book request" with the book, a **Confirm my request** button; press it: "Thank you, your request is confirmed. We'll email you if a copy arrives." The link works for 7 days and once only; clicking it again shows "This link is not valid any more..." with **Make a new request**.
- [ ] **G34.** Do not press the confirm button at all for a second request (use another title). **You should see:** in admin (script 5, A15) the request appears under "Waiting for email confirmation", not in "Active".
- [ ] **G35 (must). Manage link and find-my-requests.** Open `/my-requests`. Enter the same email, press **Send me the link**. **You should see:** "If requests exist for that address, we have sent you a link. It works for 30 days." Open the email "Your book requests at Uma's Books"; click the link. **You should see:** "My book requests" with your requests and **Cancel** / **Cancel all**. Press **Cancel** on one: "Done. Cancelled requests no longer hold your email address." (The request's name and email are deleted.)
- [ ] **G36.** Use the "Cancel this request" link from the confirmation or "good news" email. **You should see:** the "My book request" page; after cancelling, "This request is cancelled and your contact details have been deleted."
- [ ] **G37.** Try a made-up link `/my-requests/abc`. **You should see:** "This link is not valid. Use the most recent email we sent you, or find your requests with your email address."
- [ ] **FR check.** Do G31 to G35 in French. **You should see:** the pages and **both emails** in French (subjects "Merci de confirmer votre demande de livre chez Uma's Books" and "Vos demandes de livres chez Uma's Books").
- [ ] **G38 (continues in A15).** An admin adds a copy of the requested book and presses **Notify**: **You should see** the email "Good news: "Pride and Prejudice" is now at Uma's Books" (French: "Bonne nouvelle : ... est arrivé chez Uma's Books") with price, a link to the book, and, if the admin pressed **Notify and hold 7 days**, a line that the copy is held for 7 days.

### 1G. Legal pages and language toggle on every page type

- [ ] **G39 (must).** Open each legal page from the footer: **Terms of Sale** (`/terms-of-sale.html`), **Privacy Policy**, **Legal Notice** (`/mentions-legales.html`) and **Membership Terms** (`/membership-terms.html`, linked from the membership page). **You should see:** each opens with full text, the seller's identity (Uma's Books, association loi 1901, address in Albi, RNA and SIRET numbers), email `admin@umasbooks.org`. The Terms of Sale have sections on products (second-hand, and new books at the publisher's price), "Second-hand books: no returns" (it ends by saying your legal rights are not affected), "Reserving and paying" (nothing is paid online; paid at the shop; the hold lasts 14 days, extendable once by 7; at most 10 books and 3 reservations), "Cancelling a reservation", "Collecting and paying at the shop" (Wednesday to Saturday 14:00-19:00), "Memberships: paid online" (through HelloAsso, link to the membership terms), the right of withdrawal for books (with "This right applies where the law provides for it.") and the model withdrawal form, the legal guarantees, and the consumer mediator. The Legal Notice gives the hosting provider ("phone number not published by the host") and the forum moderation contact; the Membership Terms have a "Forum moderation" section.
- [ ] **G40 (must).** Switch each legal page to FR. **You should see:** "Conditions générales de vente", "Politique de confidentialité", "Mentions légales", "Conditions d'adhésion" and the full French text (no English paragraphs left).
- [ ] **G41 (must).** On each page type in the table below, click **FR**, check the page is French, then click **EN** and check it returns to English. Reload after switching: the language stays. Then click through to a different type of page: the language stays.

| Page | Address | FR ok | EN back ok |
|---|---|---|---|
| Home | `/` | [ ] | [ ] |
| About | `/about.html` | [ ] | [ ] |
| Visit | `/visit.html` | [ ] | [ ] |
| Books search | `/books.html` | [ ] | [ ] |
| Book page | `/books/<number>` | [ ] | [ ] |
| Favorites | `/favorites` | [ ] | [ ] |
| Cart (empty and with items) | `/cart` | [ ] | [ ] |
| Events | `/events` | [ ] | [ ] |
| Sessions | `/sessions` | [ ] | [ ] |
| English programs / immersion | `/immersion.html`, `/programs.html` | [ ] | [ ] |
| Pre-registration, volunteer info | `/pre-registration.html`, `/volunteer.html` | [ ] | [ ] |
| Blog | `/blog.html` | [ ] | [ ] |
| Membership | `/membership.html` | [ ] | [ ] |
| Contact | `/contact` | [ ] | [ ] |
| Request a book / find my requests | `/request-a-book`, `/my-requests` | [ ] | [ ] |
| Log in, Sign up, Forgot password | `/login`, `/signup`, `/forgot-password` | [ ] | [ ] |
| Legal pages (4) | see G39 | [ ] | [ ] |
| 404 page | `/no-such-page` | [ ] | [ ] |

- [ ] **G41b (must).** With the browser set to English and no saved site data, set the language cookie to French (or choose FR once, then clear only the site's local storage) and open `/books.html`. **You should see:** the page stays in French (no flash of English, no jump). Then on `/cart` click **EN** then **FR**. **You should see:** the whole page, not only the header and footer, changes language.

- [ ] **G41c (must).** On a phone (or a browser window made 375 px wide), open the home page. **You should see:** a compact header, about 105 px tall: the logo and the four icons on one row, then a **Menu** button on the left and **EN | FR** on the right (in preview mode the banner above is one line with **More**). Tap **Menu**: Home, Browse Books, English Programs and Events drop down. Press Esc (or tap anywhere outside): the menu closes. Tap **More** on the banner: the whole notice and **Tell us what you think!** show; **Less** folds it again. The icons and EN / FR are easy to hit with a thumb.
- [ ] **G41d (must).** On the same phone, switch to French and open **Parcourir les livres**. **You should see:** under "Parcourir par genre" a row of round genre buttons you can slide sideways; every label is a whole word (**Jeune adulte**, **Documentaires**), none cut off.
- [ ] **G41e.** On a computer, open the home page. **You should see:** the **EN | FR** buttons are comfortable to click (not tiny), the dots under the "What's new" carousel are easy to click, and so are the footer links and **Tell us what you think!**.

### 1H. Cookies, language memory, 404

- [ ] **G42 (must).** Visit any page in a fresh private window. **You should see:** **no** cookie-consent banner. (The privacy policy says the site uses one session cookie that is strictly necessary, plus your language choice in the browser, so no banner is required.)
- [ ] **G43.** Choose FR, add a book to the cart, close the private window completely, open a new one. **You should see:** back to the browser's default language and an empty cart (private windows forget everything). In a normal window the language and the cart are still there next day.
- [ ] **G44 (must).** Open `/no-such-page`. **You should see:** "Page not found" / "This page doesn't exist or has moved. If the problem continues, email us at admin@umasbooks.org." and a **Go home** button; the menu still works. FR: the same in French.
- [ ] **G45.** Open `/books/99999999` and `/books/abc`. **You should see:** the same 404 page (not a crash).
- [ ] **G46.** Open `/admin` and `/account` while logged out. **You should see:** the Log in page.


### 1I. The cart, and where "Reserve" asks for an account

Reserving needs an account: a guest can fill a cart, but "Reserve (free, no commitment)" sends them to log in or sign up first.

- [ ] **G47 (must).** On a book page press **Add to Cart** for one copy. **You should see:** the cart page with that book (cover or "No cover", title, author, condition label, `€price`, **Remove**) and **Total**. **Known:** adding to the cart does **not** reserve the copy; it is only held once an account holder presses **Reserve (free, no commitment)** (AC24).
- [ ] **G48.** Add a second book, then press **Remove** on it. **You should see:** it disappears and the total updates. (A cart holds at most 20 lines.)
- [ ] **G49.** Open the cart header icon from another page. **You should see:** the number on the cart icon matches the lines in the cart.
- [ ] **G50 (must).** In a cart with a book in it, as a guest, look for the reserve button. **You should see:** a prompt to **log in or create an account**, with a link to each, and **no** reserve form for a guest; nothing is held and no reservation is made.
- [ ] **G51 (must).** Choose **Log in** from the cart, log in as an account holder (script 2). **You should see:** you land back on the cart with your items still in it. (Create an account instead: after the confirmation email and choosing a password, log in and the cart is still there, AC1 to AC7.)
- [ ] **G52.** Log out and open `/forum`. **You should see:** the Log in page (member pages need a login). What a logged-in account holder who is **not** a member sees instead is in script 2J (AC46).

### 1J. Becoming a member: the membership page for a guest

Becoming a member needs an account, created on the membership page itself. Not in preview mode (there the page only says "Membership opens at launch", G8).

- [ ] **G53 (must).** Open `/membership.html` as a guest. **You should see:** a short form with **Name** and **Email** and a **Continue to payment** button, a link to the membership terms and privacy policy, a "Log in" link for people who already have an account, and **no** HelloAsso payment form yet.
- [ ] **G54.** Press **Continue to payment** with the Email box holding something that is not an address (the browser may stop you first; a script can send it anyway). **You should see:** "Please enter your name and a valid email address." and nothing is created.
- [ ] **G55 (must).** Enter name `Test Member Guest` and `YOU+join1@gmail.com`, press **Continue to payment**. **You should see:** the page "Next: pay for your membership" with "We have emailed you a link: click it after paying to confirm your address and choose your password", the line "Use this same email on the payment form: <your email>", and a **Show the HelloAsso form** button (nothing is loaded from HelloAsso until you press it: press it and the HelloAsso payment form appears). An email "Confirm your email for Uma's Books" arrives. On the HelloAsso form, read its final payment button: it is HelloAsso's own wording (see `docs/legal-todos.md`). Do the same with an address that **already has an account**: the next page is **identical** (the site never reveals whether an address is registered) and the real owner gets "Someone tried to sign up with your email".
- [ ] **G56.** On that page press **Use a different email**. **You should see:** the Name and Email form again.
- [ ] **FR check (membership).** Switch to FR on G53 and G55. **You should see:** "Devenir membre", "Continuer vers le paiement", "Étape suivante : réglez votre adhésion", "Utilisez cette même adresse e-mail sur le formulaire de paiement :".

### 1K. The pre-registration and volunteer forms, and book covers

These two forms send an email to the shop mailbox (`CONTACT_TO`). The emails are kept 12 months and then deleted (quarterly job, runbook section e). A copy also stays in the outgoing-mail queue for up to 30 days (90 if sending failed) and in the backups (up to 2 years). Steps G58 and G59 send a real email: say it is a test and delete it afterwards.

- [ ] **G57 (must).** Open `/pre-registration.html`. **You should see:** the first question "Who is registering?" with two choices ("An adult, for themselves" and "A parent or guardian, for a child"), the section "About the child (only if you are registering a child)", days and times as **tick boxes** (not a list that needs Ctrl or Cmd), and the line "Do not enter health information here (allergies, medical conditions, disabilities): tell us in person." Press **Submit Pre-Registration** with nothing filled in. **You should see:** the page reloads with a box "There is a problem" listing who is registering, the session, days, times, your name, email, phone and the agreement to be contacted (not the child's fields yet), each line a link that jumps to its field; each such field has a red border and a message under it ("This field is required."); the keyboard focus is on the box. Nothing is sent.
- [ ] **G57a.** Choose "An adult, for themselves". **You should see:** the child section disappears (with JavaScript off it stays, with its heading saying it is only for a child). Submit with nothing else filled in. **You should see:** no child field and no guardian box in the error list. Then choose "A parent or guardian, for a child" and submit again: **you should see** the child's first and last name, year of birth and the box "I am the parent or legal guardian of the child." in the list.
- [ ] **G58 (must).** Choose "A parent or guardian, for a child", fill in every field (the child's **year of birth**, for example `2018`, not a full date) but leave both boxes unticked, and submit. **You should see:** only "Tick this box to continue." next to "I am the parent or legal guardian of the child." and next to "I agree to be contacted about this program.", and everything you typed is still there (including the ticked days). Tick both and submit. **You should see:** "Thank you, your pre-registration has been sent". The shop mailbox gets an email "Website pre-registration: <session>" with "Registering: A parent or guardian, for a child", the child's name and year of birth (no full date), availability, your contact details, the notes and the line saying the guardian confirmed they are the child's parent or legal guardian and agree to be contacted. Try a year of birth in the future or `1900`: "Enter the year the child was born, with four digits (for example 2017)." Repeat as an adult ("An adult, for themselves"): the email says "Registering: An adult, for themselves" and has no child section.
- [ ] **G59 (must).** Open `/volunteer.html`, press **Send Sign-up** with nothing filled in. **You should see:** the same kind of error box for Name, Email and the box "I agree to be contacted about volunteering." Fill name and email, tick the box, submit. **You should see:** "Thank you, your sign-up has been sent" and an email "Website volunteer sign-up" in the shop mailbox.
- [ ] **G60.** Check the email from G58 and G59. **You should see:** it arrived within 2 minutes, in English, with your own address as the reply-to, a line "Site language: ..." and a last line reminding that it is deleted after 12 months.
- [ ] **FR check (forms).** Switch to FR on G57. **You should see:** "Il y a un problème", "Ce champ est obligatoire.", "Qui s’inscrit ?", "Je suis le parent ou le représentant légal de l’enfant.", "J’accepte d’être contacté(e) au sujet de ce programme.", "Ne saisissez pas d’informations de santé ici…" and, after a good submission, "Merci, votre pré-inscription a bien été envoyée".
- [ ] **G61.** Open a book page that has a cover. **You should see:** the cover appears in a box that was already the right size (the text below does not jump when it loads), the cover comes from this site (its address starts with `/img/`), and nothing is requested from openlibrary.org or archive.org (browser developer tools, Network tab). A book whose cover could not be copied shows a grey "No cover" box, never a broken-image icon.

## Script 2. Account holder (logged in, not a member)

An account holder has a confirmed account but has **not** paid for membership.
Time: 50 to 70 minutes. Needs a mailbox. Preview mode does not matter except in
2F to 2H (reserving), which need preview mode **off**. No HelloAsso, no card: books
and seats are reserved here and paid in the shop. Use a different `+` address for every account you create.

### 2A. Sign up, confirm, choose a password, log in

**Signing up asks only for your name and your email.** The confirmation email link then lets you choose your password. A person cannot log in before confirming.

- [ ] **AC1 (must).** Open **Create an account** (`/signup`). **You should see:** a form with **Name** and **Email** only (no password box), and the line "We will email you a link to confirm your address and choose your password."
- [ ] **AC2.** Look for a password box on the sign-up form. **You should see:** there is none (the password is chosen after the email is confirmed).
- [ ] **AC2b.** Later, on the choose-your-password page (AC6), enter a weak password (`abc`) and press **Set password**. **You should see:** "Password must be at least 8 characters." or "Password must include ...". A known-breached password (for example `Password123!`) gives "That password has appeared in a known data breach. Please choose a different one." (the site rejects leaked passwords).
- [ ] **AC3 (must).** Enter name `Test Account One`, `YOU+account1@gmail.com`, press **Create account**. **You should see:** the same page with the message "Thanks! Check your inbox for an email with next steps: open its link to confirm your address and choose your password, then log in. If you already have an account, try logging in or resetting your password." You are **not** logged in.
- [ ] **AC4 (must).** Before opening the email, try to log in with that address and any password. **You should see:** "Incorrect email or password." (the site does **not** say that the account is waiting for confirmation, so nobody can discover which addresses are registered). On the login page open **Just signed up? Send me the confirmation link again**, enter the address, press **Send me the link again**: "If that account is waiting for confirmation, we've sent a new link. Check your inbox." (at most one new link every 5 minutes).
- [ ] **AC5 (must).** Open the email "Confirm your email for Uma's Books" and click the link. **You should see:** a page "Confirm your email" with a single **Confirm my email** button (opening the link changes nothing by itself; this is what protects it from mail scanners). Press the button. **You should see:** a page "Email confirmed: now choose your password": "Thank you! To keep your account safe, please pick your password now. It replaces the one entered when the account was created." **Known:** the link is good for 24 hours and works once; reopening it shows a page "This confirmation link is not valid any more" with a **Request a new confirmation link** form and a **Forgot your password?** link.
- [ ] **AC6 (must).** Choose a password (twice if asked) and press **Set password**. **You should see:** the Log in page with "Password saved — your email is confirmed. Log in to get started."
- [ ] **AC7 (must).** Log in with the new password. **You should see:** you land on the home page (an account holder is not a member, so the site does not take you to Member's Access) and the person icon at the top right is now the **Log Out** button. **Known:** a logged-in account that is not a member cannot open the Member's Access area; the key icon sends you to the home page (see 2H).
- [ ] **AC8 (must). Same address again.** Log out; sign up again with the same email. **You should see:** exactly the same "Thanks! Check your inbox" message (the site never reveals whether an address is registered), and the real owner receives "Someone tried to sign up with your email at Uma's Books" with links to log in or reset.
- [ ] **FR check (sign-up).** Switch to **FR** before AC1 and redo with `YOU+account2@gmail.com`. **You should see:** "Créer votre compte", "Nom", "E-mail", **Créer mon compte**, the notice "Merci ! Consultez votre boîte de réception...", and the email "Confirmez votre adresse e-mail pour Uma's Books" in French. After setting the password: "Mot de passe enregistré : votre adresse e-mail est confirmée. Connectez-vous pour commencer."

### 2B. Wrong password, lockout, forgot and reset

- [ ] **AC9 (must).** Log in with the right email and a wrong password. **You should see:** "Incorrect email or password." (same message for an unknown email).
- [ ] **AC10 (must).** Do it 5 times in a row. Then log in with the **right** password. **You should see:** still "Incorrect email or password." (the account is locked for 15 minutes and the site does not say so). After 15 minutes the right password works. Use a throwaway account only, and note the time.
- [ ] **AC11 (must). Forgot password.** Press **Forgot your password?** Enter the address, press **Send reset link**. **You should see:** "If an account exists for that email, we've sent a password reset link." (also for an address that has no account). Open "Reset your Uma's Books members password" (FR: "Réinitialisez votre mot de passe membre Uma's Books"), click the link (valid 1 hour, once): "Set a new password"; set one; **You should see:** "Password updated — log in with your new password." The old password no longer works.
- [ ] **AC12.** Click the same reset link again. **You should see:** the page says the link is not valid with a **Request a new reset link** button.

### 2C. My account, reservation history, book requests, password, favorites

- [ ] **AC13 (must).** Open the receipt icon (`/account`). **You should see:** "My Account", a "My reservations" list (for an account that reserved something with the same email, once the email is confirmed: each reservation with its status, **Reserved** while it is open, with **Open** and **Cancel reservation** buttons; an account that never reserved shows "No reservations yet"), links "Two-step verification" and "Privacy: download or delete my data", and "My book requests". Before the email is confirmed you see "Confirm your email address to see your reservations here".
- [ ] **AC14.** In "My book requests" press **Cancel this request** on one, and **Ask for another book**. **You should see:** the request disappears (contact details deleted); the request form opens.
- [ ] **AC15.** Open `/account/password` (**Change Password**): enter the current and a new password. **You should see:** a confirmation; log in again with the new one. A wrong current password is refused, and 5 wrong attempts in 15 minutes block more tries.
- [ ] **AC16.** Heart a book; log out and in again; open `/favorites`. **Known:** favorites are saved in this browser, not on the account; they are still there in the same browser and absent in another.

### 2D. Privacy page: download, delete

- [ ] **AC17 (must). Download my data.** Open "Privacy: download or delete my data" (`/account/privacy`). If the email is not confirmed you see "Confirm your email address first" and **Resend the confirmation email**. Otherwise press **Download my data**. **You should see:** a file `umasbooks-my-data.json` downloads, and opening it shows your name, email, reservations, requests, forum posts.
- [ ] **AC18 (must). Delete my account.** **Use a throwaway account only (not the one needed for later steps).** Enter your **Current password**, type `DELETE` (in French `SUPPRIMER`) in the confirmation box, press **Delete my account for good**. **You should see:** the page "Account deleted" / "Your account has been deleted" with **Go home**, you are logged out, the old password no longer works, and an email "Your Uma's Books account has been deleted" (French: "Votre compte Uma's Books a été supprimé") arrives. A wrong password gives "Current password is incorrect."; anything other than the word gives "Type DELETE in the confirmation box to delete your account."
- [ ] **AC19.** Admin: `/admin/members` search for that address. **You should see:** no account. **Known:** an admin cannot delete their own account here ("Administrators can't delete their own account here: ask another administrator."), and the last admin cannot be deleted.

### 2E. Language saved, emails in chosen language

- [ ] **AC20 (must).** Log in with the site in **FR**, log out, switch to **EN**, log in again, switch to **FR**, log out. Then use **Forgot your password?** with the site in **FR**. **You should see:** the reset email in French. Repeat in EN: English. **Known:** the account's saved language is updated at each login if you chose a language on the site.
- [ ] **AC21.** Reserve something (2F) or request a book while logged in with the site in French. **You should see:** the emails in French.

### 2F. Reserving: cart, reservation page, confirmation email

Needs preview mode **off**. If the cart shows the preview notice, steps AC22 onward cannot be run. Log in as the account holder first. Only account holders can reserve; a guest is sent to log in first (G50). **Nothing is paid on the website:** you reserve, then pay at the shop when you collect.

- [ ] **AC22 (must).** In the cart, check the reserve form: **Name**, **Email** (your account's, read-only), **Phone (optional)**, "Nothing is paid online. We hold your books for 14 days: come to the shop and pay when you collect them.", "We hold your books for 14 days. Pay and collect them at the shop, Rue Peyrolière, Albi. Collect your books during our regular hours, Wednesday to Saturday, 14:00–19:00. We are sometimes open at other times when volunteers are available, but only the regular hours are guaranteed.", a checkbox "I have read and accept the terms of sale" with a link that opens the Terms of Sale in a new tab, a privacy note, a short line "Used books: no returns or exchanges for a change of mind in the shop. The legal guarantees still apply, and so does the statutory right of withdrawal where the law provides for it." with a link to the Terms of Sale just above the button, and the button **Reserve (free, no commitment)**. Under the cart total: "Price incl. tax, TVA non applicable". **You should see:** all of these, and no mention of HelloAsso or of paying online.
- [ ] **AC23 (must).** Try to reserve without ticking the terms checkbox. **You should see:** the browser refuses and points at the checkbox (you cannot submit). The email box cannot be edited: a reservation always uses the account's confirmed email.
- [ ] **FR check (cart).** Switch to FR. **You should see:** "Votre panier", "Retirer", "Total :", "Réservation", "Nom", "E-mail", "Téléphone (facultatif)", "J'ai lu et j'accepte les conditions de vente", **Réserver (gratuit, sans engagement)**, the line "Livres d’occasion : pas de reprise ni d’échange pour simple changement d’avis en boutique. Les garanties légales de conformité et des vices cachés restent applicables, ainsi que le droit légal de rétractation lorsque la loi le prévoit.", "Prix TTC, TVA non applicable", and the messages "Rien n’est payé en ligne. Nous gardons vos livres 14 jours : passez à la boutique et réglez-les au moment du retrait." and "Nous gardons vos livres 14 jours. Réglez-les et retirez-les à la boutique, du mardi au samedi, 10h–19h, rue Peyrolière, Albi."

- [ ] **AC24 (must).** Fill Name `Test Reserver`, tick the terms box, press **Reserve (free, no commitment)** once. **You should see:** you land on the page "Reservation #N recorded" (not on any payment page: nothing is paid), with the items and the total to pay at the shop; the cart is now empty.
- [ ] **AC25 (must). Hold.** In another browser (someone else), open the same book. **You should see:** the reserved copy is no longer for sale (that copy is gone from the table, or "Currently unavailable" if it was the only one). **Known:** the hold lasts until the end of the 14th day (an admin can extend it once by 7 days); it is released by itself after that, or when you cancel (AC38).
- [ ] **AC26 (must).** Read the reservation page. **You should see:** "Reservation #N recorded", "Nothing is paid online", the items, "Total to pay at the shop", "We hold your books until the end of <date> (Paris time)" (the 14th day from today), the shop address (Rue Peyrolière) and the sentence "Collect your books during our regular hours, Wednesday to Saturday, 14:00–19:00. We are sometimes open at other times when volunteers are available, but only the regular hours are guaranteed." with "give this reservation number", "A confirmation email is on its way to <your email>", a **Print this page** button and a **Cancel reservation** button. (This page is your proof even if the email never arrives.)
- [ ] **AC27 (must). Confirmation email (English).** Open the email "Your reservation at Uma's Books". **You should see:** "Thanks for your reservation. Nothing has been paid online: you pay at the shop when you collect.", "Reservation #<number>" with the date, each item with `€price`, "Total to pay at the shop", the heading "PAY AT THE SHOP WHEN YOU COLLECT" with "We hold your books until the end of <date> (Paris time)" and the shop address and hours, "Cash, card and cheque are accepted", "TO CANCEL" with a link to your account page, and then, in this order:
  - [ ] a link to the Terms of Sale and "Terms of sale accepted on <date> (version <version>).";
  - [ ] "YOUR RIGHTS" starting with the free-reservation / used-book sentence ("Reserving is free and commits you to nothing. You pay and the sale is made in the shop... Used books are not taken back for a change of mind once bought in the shop; the legal guarantees still apply."), then the legal guarantees. **There is no withdrawal notice and no withdrawal form** (a reservation is a free hold, the sale is made in the shop; see `docs/legal-todos.md` section 7);
  - [ ] the **seller identity**: Uma's Books, association loi 1901, RNA, SIRET, address in Albi, phone, `admin@umasbooks.org`, "TVA non applicable";
  - [ ] the **free consumer mediator** (CM2C, Paris address and web address) for complaints.
- [ ] **AC28 (must). Confirmation email (French).** Repeat AC22 to AC27 with the site switched to **FR** before pressing **Réserver (gratuit, sans engagement)**. **You should see:** the subject "Votre réservation chez Uma's Books", the body in French ("Merci pour votre réservation. Rien n’a été payé en ligne : vous réglez à la boutique au moment du retrait.", "Réservation n° ...", "Total à régler à la boutique : €...", "À RÉGLER À LA BOUTIQUE AU RETRAIT", "POUR ANNULER"), the terms line "Conditions générales de vente acceptées le ... (version ...)", and the legal blocks (withdrawal, form, seller, mediator). **Known:** the legal blocks are written in both French and English in every email (required by law), and prices in the email read `€12.50`.
- [ ] **AC29.** Refresh the reservation page, and open its address from a second browser (not logged in). **You should see:** still "Reservation #N recorded" (no second email, no error), but **without** the Cancel button: only the owner can cancel. Only people with the unguessable link can see the page; a made-up link gives a 404.
- [ ] **AC30 (must). Admin sees the reservation.** In admin open **Books & Reservations** > reservations (`/admin/orders`). **You should see:** the page opens on **Reserved: awaiting pickup** and lists the reservation with your name, items, total and "held until the end of <date>"; the books are no longer in stock on the site.
- [ ] **AC31 (must). Pickup.** Pretend to be the customer at the shop: give your name or the reservation number; a volunteer finds the reservation in `/admin/orders` (search by the number, email or name), takes the payment, opens it, chooses **How did they pay?** and presses **Mark collected and paid** (A24c). **You should see:** the reservation shows Paid and Collected with the time and the payment method; it leaves the "Reserved: awaiting pickup" list; your reservation page now says "Reservation #N collected".
- [ ] **AC31a. Reminder and ending emails.** These are sent by the site on their own: to the customer on day 10 (4 days before the deadline: "Your reserved books are waiting at the shop"), to the admin once when a reservation is within 2 days of its deadline ("N reservations expiring within 2 days"), to the customer when a reservation lapses ("Your reservation #N has ended": no payment, no penalty), and for a reserved drop-in seat 24 hours before the session ("Reminder: your drop-in seat tomorrow"). **You should see:** to test it, ask the developer to move the reservation's deadline back in a test database; each email is sent once, in the customer's language.
- [ ] **AC32. 14-day rule.** Read the Terms of Sale, "Collecting and paying at the shop" and "Reserving and paying": **You should see:** "Please come within 14 days of reserving; if you need longer, write to us.", "A reservation that is not collected in time simply lapses, without penalty, and the items go back on sale. The shop can extend the hold once, by 7 days." (and the French equivalents). **Known:** the software releases a reservation by itself after its deadline (no penalty, no email beyond "your reservation has ended"); what to do for a customer who asks for more time is in the runbook ("Reservations not collected"). A **held** book (request hold, exactly 7 days) also returns to the shelf by itself.

### 2G. Drop-in class seat (reserved online, paid at the session)

- [ ] **AC33 (must).** Open `/sessions`, choose **Drop-ins Only**, press **Add to Cart** on a session with a price. **You should see:** the cart shows "Session" with "Drop-in seat · <date and time>" and the price.
- [ ] **AC34 (must).** In the cart, look at the reserve form. **You should see:** "Drop-in seats: you pay at the session. You can cancel a seat online until 24 hours before it starts." and the button **Reserve (free, no commitment)** (or **Reserve (free, no commitment)** when the cart also holds books). There is **no** waiver checkbox any more: nothing is paid online. (The Terms of Sale say drop-in sessions have no right of withdrawal, art. L.221-28 12°.)
- [ ] **AC35.** Press the reserve button. **You should see:** the reservation page with the session line and "Drop-in seats: you pay at the session. A seat can be cancelled online until 24 hours before the session." (no "We hold your books" line for a seat-only reservation); the confirmation email says you pay at the session. A seat is held until the session is over.
- [ ] **AC36.** Back on `/sessions`. **You should see:** one place fewer ("N places left") while the seat is reserved; a session with no places shows **Full**. After you cancel the reservation the place is back.
- [ ] **AC37.** Admin: `/admin/sessions`, open the session. **You should see:** the reserved seat, not counted as free. (Pressing **Mark collected and paid** on the reservation after the session records the payment taken at the session.)
- [ ] **FR check.** The seat lines read "Places « drop-in » : vous réglez à la séance. Vous pouvez annuler une place en ligne jusqu’à 24 heures avant le début." and the button **Réserver (gratuit, sans engagement)**.

### 2H. Cancelling, limits, hold expiry, retries

- [ ] **AC38 (must). Cancel from your account page.** Open `/account` with a reservation open (AC24). **You should see:** it listed as **Reserved**, with "Nothing is paid online: you pay at the shop when you collect." and "Held until the end of <date>", plus **Open** and **Cancel reservation**. Press **Cancel reservation** and confirm. **You should see:** "Your reservation was cancelled and its items are available again."; the book is for sale again; its reservation page now says "Reservation cancelled".
- [ ] **AC39.** Make three reservations in a row (one book each), then try a fourth. **You should see:** "You already have 3 open reservations, which is the most we can hold for one account. Please collect or cancel one first (see your account page)." and nothing is held. Cancel them afterwards.
- [ ] **AC38a (must). Cancel from the reservation page.** Make a reservation, and on its page press **Cancel reservation**. **You should see:** "Your reservation was cancelled and its items are available again."; opening the reservation's old link says "Reservation cancelled — Nothing was charged". Another account that opens the link sees no Cancel button, and cannot cancel it.
- [ ] **AC40 (must).** Wait for the deadline to pass (14 days; or ask the developer to move the deadline back in a test database), then open the book page. **You should see:** the copy is for sale again, the reservation page says "Reservation ended" ("There is nothing to pay and no penalty. You can reserve them again if they are still available."), the reservation in admin is **Expired**, and the customer received the email "Your reservation #N has ended".
- [ ] **AC41.** Someone else takes your book: add a book to the cart (do not reserve), in the other browser (another account) reserve that same copy, then in your cart press **Reserve (free, no commitment)**. **You should see:** "Sorry, something in your cart was just taken by someone else. Please review your cart and try again." and the cart refreshed without that book.
- [ ] **AC42.** Reserve, then use the browser's back button until you reach the shop (see also E3). **You should see:** no error page and no duplicate reservation (still one in `/account`).
- [ ] **AC56.** Put 11 books in the cart (cart limit is 20 lines) and press **Reserve (free, no commitment)**. **You should see:** "We can hold at most 10 books at a time for one account, counting your other open reservations. Please remove some books from your cart, or collect or cancel a reservation first." and nothing is held.
- [ ] **AC57.** Reserve a drop-in seat for a session that starts within 24 hours, then press **Cancel reservation** on `/account`. **You should see:** "A drop-in seat can only be cancelled online until 24 hours before the session. Please contact the shop." and the seat stays reserved.

### 2I. Two-step verification for an ordinary account

Two-step is optional for an account holder (an admin must use it). It uses the same pages as in script 5.

- [ ] **AC43.** Log in as an account holder, open `/account` > **Two-step verification**. **You should see:** "Set up two-step verification" with a QR code, a "Can't scan?" key, **Your account password** and **Code** boxes and **Turn on two-step verification**, and **no** line about admin accounts having to use it.
- [ ] **AC43b.** Scan the QR code with an authenticator app, enter the password and the 6-digit code. **You should see:** recovery codes shown once. Log out and in: after the password the site asks for the 6-digit code. Then turn two-step off again (**Turn off**, which asks for a code): the next login asks for the password only. (Use a throwaway account: the automated tests log in with a password only.)

### 2J. Member-only pages must NOT show member content to an account holder

Log in as an account holder who is **not** a member, volunteer or admin. **What the site does today:** a logged-in account that is not a member is sent to the **home page** (`/`) from every member-only page; it is not offered membership there and sees no member content. (A guest who opens `/dashboard` is instead taken to the membership page, and for the other pages to the Log in page.) Each step below must **fail the test** if member content appears.

- [ ] **AC44 (must).** Open `/dashboard` (also what the key icon links to). **You should see:** you end on the home page; **no** Member's Access ("Welcome back"), no announcements, charity or forum links.
- [ ] **AC45 (must).** Open `/announcements`. **You should see:** you end on the home page, with no announcements list.
- [ ] **AC46 (must).** Open `/forum` and `/forum/new`. **You should see:** you end on the home page both times; no threads, no **Start a thread** form. Posting to the forum by a crafted request is refused the same way.
- [ ] **AC47 (must).** Open `/meetings`. **You should see:** you end on the home page; no calendar, no **I'll be there** buttons.
- [ ] **AC48 (must).** Open `/charity`. **You should see:** either the home page, or (only if the current vote was set to "Visible to: Everyone" by an admin) the vote shown **read-only**: no **Submit My Votes** button and no **Suggest a Charity** form. A vote sent by a crafted request is refused.
- [ ] **AC49.** Open `/volunteer`. **You should see:** you end on the home page (the shifts are for volunteers and admins).
- [ ] **AC50.** Click the key icon (Member's Access) in the header. **You should see:** the home page, still logged in (the person icon is **Log Out**), with no member content. (`/admin` for an account holder is E8.)

### 2K. The membership page for an account holder

Log in as an account holder who is **not** a member. Not in preview mode.

- [ ] **AC51 (must).** Open `/membership.html`. **You should see:** **only** the HelloAsso payment form (behind a **Show the HelloAsso form** button, see AC55), with the line "Use the same email as your account (<your account email>) so your membership is linked to it", and **no** Name and Email sign-up form.
- [ ] **AC55 (must).** On `/membership.html` (the page of AC51), look before pressing anything. **You should see:** a short note that HelloAsso loads only on your request, and a **Show the HelloAsso form** button, but no payment form yet (and no request to helloasso.com in the Network tab). Press the button. **You should see:** the HelloAsso payment form appears in its place and the button goes away.
- [ ] **AC52.** Send a membership sign-up request anyway (a script posting to `/membership/join`; there is no form to press). **You should see:** nothing happens: you land back on the membership page, still logged in, no new account is made and no email is sent.
- [ ] **AC53 (must).** Press **Check my membership** (under the payment form) before paying. **You should see:** "We have not found your payment yet. It can take a few minutes. Make sure you used the email <your account email> on the payment form." (If HelloAsso cannot be reached: "We could not check right now.") It is limited to 5 tries in 10 minutes. If your email is not confirmed yet: "Please confirm your email address first".
- [ ] **AC54 (must).** After a real payment made with the account's email (see M1), press **Check my membership**. **You should see:** "Membership found: you are a member until <date>." at once, without waiting for the automatic check, and Member's Access now opens.

## Script 3. Member

A member is an account holder who also paid the membership fee. Time: 30 to 40
minutes. **A member does not need to have bought anything:** none of these steps
needs a reservation or reservation history (reservation history is checked for account holders
who bought, AC13). Preview mode does not matter except M1.

### 3A. Becoming a member

- [ ] **M1 (must). Pay for membership (a person with no account yet).** Preview **off**: as a guest open `/membership.html`, fill the short form (G53, G55) and note the email shown, then pay on the HelloAsso form on the next page **with that same email**. **Then**, after paying, open the confirmation email and click its link (AC5), choose a password (AC6) and log in. **You should see:** within a few minutes the key icon opens **Member's Access** ("Welcome back, <name>"), and in admin **Members** the account shows its membership dates (one year from the payment). An account holder who already exists logs in first and pays on the page that shows only the payment form (AC51); **Check my membership** (AC54) finds the payment at once. **Known:** the payment form is HelloAsso's own embedded form, pointing at the real organisation page; it does not follow `HELLOASSO_API_BASE`, so a test payment would be real (see "Before you start"). **TODO** confirm with the developer; until then use M3 and do one real payment at launch with a small amount, refunding it afterwards. **Known:** the account's email must be confirmed before the payment is attached, which is why the page asks you to click the link after paying.
- [ ] **M2.** Read **Membership Terms** from the membership page. **You should see:** the terms (see G39/G40).
- [ ] **M3 (must). Admin grants membership.** Because the HelloAsso form cannot be tested in sandbox (M1): in admin > Accounts, open the confirmed test account, press **Mark as Member** (script 5, A24). **You should see:** the button now says **Remove Member Status**, and the account holder who is logged in opens **Member's Access** on the next click, without logging in again.

### 3B. Member area: dashboard, announcements

- [ ] **M4 (must).** As a member (M1 or M3), open the key icon. **You should see:** "Member's Access" with Announcements, "Charity We Support", Community Forum, Meetings Calendar, Volunteer Sign Up (that one only works for volunteers) and "Change Password".
- [ ] **M12 (must).** Open **View All Announcements** (`/announcements`). **You should see:** the published announcements, pinned ones first; a draft or scheduled one is not shown (admin A34).

### 3C. Forum, charity vote, meetings

- [ ] **M5 (must). Forum post.** Open **Go to Forum** (`/forum`), **Start a thread**, give a Title and Message, **Post**. **You should see:** the thread, your first name or "Member", the date. The list shows "1 reply" / "N replies".
- [ ] **M6.** Open a thread, write a reply in "Add a reply", press **Reply**. **You should see:** the reply under "Replies".
- [ ] **M7 (must). Report.** Press **Report** on a post, pick a reason (Illegal content, Harassment, Spam, Other), add a comment, **Send report**. **You should see:** "Thanks, we will review it." and the shop mailbox (the contact address, normally `admin@umasbooks.org`) gets "Forum report: <reason> (thread/reply <id>)".
- [ ] **M8 (must). Charity vote.** Open **Vote Now** (`/charity`). **You should see:** the open vote question, the charities with votes, "You can select multiple charities." if allowed, and **Submit My Votes**. Vote; **You should see:** your vote counted ("1 vote"). Voting twice for the same option is not possible. When no vote is open: "No vote is open right now."
- [ ] **M9.** In "Suggest a Charity" send an idea (name, category, why, website) with **Submit Idea**. **You should see:** it appears under "Your submitted ideas" as "Pending review"; after admin approval "Approved" (or "Not selected").
- [ ] **M10. RSVP.** Open **View Calendar** (`/meetings`). Press **I'll be there** on a meeting. **You should see:** "N going" goes up and the button becomes **Cancel RSVP**; press it: the count goes back. "Past meetings & minutes" lists old ones, with "Minutes not posted yet." when empty.
- [ ] **M11.** Open the Events page logged in and sign up for an event. **You should see:** the same as G23.
- [ ] **FR check (member area).** Switch to FR on the dashboard, forum, charity page, meetings and account. **You should see:** "Espace membres", "Bienvenue" (welcome), "Annonces", "Signaler", "Envoyer le signalement", "Voter", "Je serai là" (or similar). Note any English left over.

### 3D. How long membership lasts

- [ ] **M13 (must). Admin-granted membership has no end date.** Admin > Accounts > the member made with **Mark as Member** (M3) > **View**. **You should see:** **no** "Membership" end-date line (a membership paid through HelloAsso shows a date a year after the payment). An admin-granted member stays a member until an admin presses **Remove Member Status**; the nightly expiry job never touches it.
- [ ] **M14 (must). An expired paid membership loses access.** A paid membership ends 365 days after the payment (an hourly background job turns off members whose end date has passed). Waiting a year is not practical, so check the effect with the admin toggle: with the member logged in in one browser, press **Remove Member Status** on the account in another. **You should see:** at the member's next click, `/dashboard`, `/forum`, `/meetings`, `/announcements` and `/charity` send them to the home page, exactly as in AC44 to AC48, and the key icon no longer opens Member's Access. Press **Mark as Member** again to restore. **Known:** the website cannot set an end date by hand, so a real expiry can only be seen on a paid membership after a year (or in a local test copy with the end date changed in the database).

- [ ] **M15 (must).** As a member, open `/membership.html`. **You should see:** "You are a member", with "You are a member until <date>." for a paid membership (a year after the payment) or "You are a member, with no end date." for one an admin granted (M13), and **no** payment form.
- [ ] **M16.** Renewal window. Take a paid member whose end date is less than 30 days away (see the **Known** below), open `/membership.html`. **You should see:** "You can renew from this page during the last 30 days of your membership" and the payment form again; after the end date has passed, the page treats the account like an account holder (AC51). **Known:** an admin cannot set an end date by hand, so this needs a real payment about a year old or a test copy with the date changed in the database.

## Script 4. Volunteer

An admin marks a throwaway **confirmed** account as volunteer (script 5, A24).
Time: 15 to 20 minutes.

- [ ] **VO1 (must).** As a member who is not a volunteer open `/volunteer`. **You should see:** you are sent to the home page (the shifts calendar is for volunteers and admins only).
- [ ] **VO2.** Log in as the volunteer, open Member's Access > **Sign Up to Volunteer** (`/volunteer`). **You should see:** "Volunteer Shifts" with the intro "Sign up for a shift below...", a Month/Week calendar with **Prev / Next**, shifts showing "0/1 filled" (or "N/max filled"), **Sign up**; a shift already taken shows **Full**.
- [ ] **VO3 (must).** Press **Sign up** on a shift. **You should see:** the shift under **My upcoming shifts**, and "1/1 filled".
- [ ] **VO4.** Someone else (another volunteer account) opens the same shift. **You should see:** **Full**; no sign-up button.
- [ ] **VO5 (must).** Press **Cancel** on your shift. **You should see:** it leaves "My upcoming shifts" and the shift is free again for the other volunteer.
- [ ] **VO6.** Volunteers can also use the forum, charity vote and meetings (script 3C). **You should see:** all of them open.
- [ ] **VO7.** Admin: `/admin/volunteer-shifts`. **You should see:** the shift with "1 / 1 filled" while signed up, and the volunteer's name when you click it.
- [ ] **FR check.** Switch to FR. **You should see:** "Créneaux de bénévolat" (or similar), "S'inscrire", "Annuler", "Complet", "Mes prochains créneaux".
- [ ] **VO8 (must).** As the volunteer, open `/dashboard` (Member's Access) and `/announcements`. **You should see:** both open with no membership needed (a volunteer passes every member check, even if the account is not marked as member). The volunteer also opens `/forum`, `/charity` and `/meetings` (VO6).

## Script 5. Admin

Log in with your admin account on the site as a normal user. Time: 40 minutes
or more (it is the longest). Admin pages are in English only: check that
pressing **FR** does not break them.

### 5A. Login, two-step verification, recovery codes

Two-step verification is **always required** for admins on the real site.

- [ ] **A1 (must).** Log in as a normal admin who already has two-step set up. **You should see:** after the password, a page "Two-step verification": "Enter the 6-digit code from your authenticator app." with a **Verify** button and a "Lost your phone? Enter one of your recovery codes instead (each works once)." section; after the right code you land on **Dashboard** (`/admin`).
- [ ] **A2 (must). First-time set-up with a throwaway second admin.** Make a second admin: **Accounts** > **+ Add Member**: Name, Email (a real mailbox, for example `YOU+admin2@gmail.com`), tick **Make an admin**, press **Add & Send Invite**. **You should see:** an email to set a password (same link as "Forgot password"). Set the password, log in. **You should see:** you are sent to "Set up two-step verification": "Admin accounts must use two-step verification. Set it up now to continue to the admin area.", with a QR code, "Can't scan?" text, **Your account password** and **Code** boxes and **Turn on two-step verification**. Scan the QR with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy), type the password and the 6-digit code.
- [ ] **A3 (must). Recovery codes.** **You should see:** "Your recovery codes" with 10 codes, "They are shown only once. Each one works a single time...", and a confirmation button. Save them (a password manager), press the button. **You should see:** the Dashboard. Admin pages other than the set-up page stay blocked until set-up is done.
- [ ] **A4 (must). Wrong code and lockout.** Log out and in; type a wrong 6-digit code. **You should see:** "That code didn't work. Try again." Keep typing wrong codes: after several tries you are sent back to the login page with "Too many wrong codes. Log in again."; if you keep going, "Too many wrong attempts. Try again in a few minutes." Five wrong **passwords** lock the account for 15 minutes and still show "Incorrect email or password."
- [ ] **A5 (must). Use a recovery code.** Log in with the password and, at the code page, type one recovery code instead of the app code. **You should see:** you get in. Use the same code again later: it is refused. Open **Two-step verification** (`/account/2fa`): "Two-step verification is on for your account. You have 9 unused recovery codes." **Get new recovery codes** needs a current code and replaces all the old ones. An admin has no **Turn off** option.
- [ ] **A5b (must). Reset two-step.** As your own admin: **Accounts** > the second admin > **Reset Two-Step** (a confirm box: "Reset two-step verification for this account? They will be logged out and must set it up again."). **You should see:** the second admin is logged out, and at next login sets up again as in A2. (If you lock out your only admin: runbook section c.) The button only shows for accounts that have two-step on.

### 5B. Dashboard and admin menu

- [ ] **A6.** Open the **Dashboard**. **You should see:** figures (Collected Reservations Today, This Month, Sales this month, In-Stock Books, Added This Month, Total Accounts, Members) and tiles: Books & Reservations, English Programs, Bookstore Events, Account Section, Members, Volunteer Shifts, Meetings, Announcements, Charities, Blog; in preview mode a red strip "PREVIEW MODE is ON".
- [ ] **A7.** Open every item of the left menu once: Dashboard, Books & Reservations, Book Requests, English Programs, Events, Volunteer Shifts, Meetings, Announcements, Accounts, Members, Charities, Blog, Reports, Pricing rules, Admin activity. **You should see:** each opens in English, no error.
- [ ] **A8.** Press **FR** (public pages) then return to an admin page. **You should see:** admin stays English; the public site is French.

### 5C. Add books: scan, manual, photo

- [ ] **A9 (must). ISBN entry, looked up in place.** **Books & Reservations** > **Scan a book** (opens **Add Book**). The cursor is in the **ISBN** box at the top; on the very first use **Location** says `STORE`, **Source** Donation, **Binding** the last one in the list (Other) and **Condition** Very Good. Type `9780141036144` (or scan a barcode) and press **Enter**. **You should see:** "Looking up…" then "Found: <title>" under the box, **without the page reloading**, and the form filled with the title, author, cover, publisher, year, genres and a description (written automatically, English and French, when the AI key is set; otherwise empty), the price suggestion, and the **This copy** section. A field you had already typed in is not overwritten. Scanning a book you already stock says "Already in stock: N copies". An ISBN that is not found says "Not found: fill in by hand". The old **Look up** button still works without JavaScript.
- [ ] **A9b (must). Phone layout.** On a phone (or a browser window 375 and 320 pixels wide) open **Add Book**. **You should see:** one column, no sideways scrolling, the ISBN box near the top, fields at least as tall as a fingertip, the price choices as big buttons that wrap, **Save and add another** in a bar that stays at the bottom of the screen (also above the on-screen keyboard), and the page does not zoom in when you tap a field. Tap the ISBN box: **the keyboard opens** (on an iPhone the keyboard only opens from a tap, not by itself on load: that is how iOS works; a Bluetooth or wedge scanner needs no keyboard).
- [ ] **A9c. Scan mode.** Tick **Scan mode**, scan a book new to the shop. **You should see:** a large **Save (suggested price EUR n)** button; one tap saves and returns to the empty ISBN box. Untick it: back to the normal buttons. It is off on a first visit and remembered afterwards.
- [ ] **A9d. Remembered values.** Save a book as Hardback, Good, Source Purchase, at `FICTION-A1`. **You should see:** the next form has the same **Binding**, **Condition**, **Source** and **Location**, also after a page reload and after closing and opening the page again on that device. A binding named by the catalog appears only as small text ("Open Library says: Paperback") and does not change your choice.
- [ ] **A10c (must). A new location, and the last values.** On **Add Book** (on a computer, then on an iPhone) tap **Location**, clear it and type a place that does not exist yet, for example `NEW-SHELF-1`, then press Enter or **Save and add another**. **You should see:** the text stays as you typed it (in capital letters), the book is saved there, and the next form starts with `NEW-SHELF-1`; it is also in the dropdown of every Location field afterwards. Now open **Add Book** on a different phone or computer that has never been used: **Location**, **Source**, **Binding** and **Condition** are the ones of the last book you saved (`STORE`, Donation, Other and Very Good appear only if no book was ever saved by you).
- [ ] **A10 (must). Condition, binding, price.** Choose **Condition** (New / Very Good / Good / Acceptable) and **Binding** (Mass Market / Trade / Hardback / Other), look at the **Price** choice: radio buttons **Clearance EUR 1.00**, **EUR 3.00**, **EUR 5.00**, **EUR 8.00**, **EUR 10.00**, **Custom...**, with **Suggested** tag on one and a **Suggest price** button and **Why this price?**. Press **Save book**. **You should see:** "Book saved — ready for the next one." and the book in the list with its copy.
- [ ] **A11 (must). Price suggestion rules** (default rules; check **Pricing rules** if someone changed them). Add `9780451524935` (mass market): **You should see:** suggested EUR 5.00 and the reason in **Why this price?**. Add a hardback: never suggested under EUR 10.00. Add a book with no ISBN: **no price suggested** ("a person looks it up"). Add three copies of `9780743273565` one after the other: the **third** copy is suggested **Clearance EUR 1.00** (clearance starts when 2 copies are already in stock or reserved, for the "A" rule and mass-market books only), and if the shop is set to "All its copies" a box offers "Also reprice the other N copies". **Known:** the condition of the copy never changes the price.
- [ ] **A12 (must). New book at publisher's price (loi Lang, 5%).** Add `9780747532743` with condition **New**. **You should see:** a field **Publisher's price (prix éditeur) (€)**, required only for New. Leave it empty and save: "New books need the publisher's price (prix éditeur): French law requires them to be sold at that price." Enter 12.00, leave Price empty: the price becomes 12.00. Enter Price 11.00 (more than 5% off): **You should see:** "A new book must be sold at the publisher's price (€12.00), with at most 5% off: the price must be between €11.40 and €12.00." Enter 11.40 (exactly 5% off): saved. A New book is never put on clearance.
- [ ] **A13. Photo scan.** On **Scan a book** use **Take or Choose Photo** with a photo of a cover or barcode. **You should see:** the book looked up and the form filled in. If you see "Photo scanning isn't set up yet (needs an ANTHROPIC_API_KEY)", the key is missing: use ISBN or **Add manually**. **TODO:** confirm with the developer whether the key is set on the live service.
- [ ] **A14. Add manually.** **Add manually** (`/admin/inventory/new`): fill Title, Author, ISBN (optional), Genres, Description, **Generate description**, upload a cover photo ("A photo overrides the URL above"). **You should see:** the book saved; no cover found shows "No cover found — Take or Upload a Photo". An empty title: "Title is required."
- [ ] **A14a. Bad numbers are refused.** In a copy's price, acquisition cost, or a book's published year type `-5`, `abc`, `12.345`, `99999`. **You should see:** a clear English error each time, nothing saved, and what you typed still in the form. In a session, a drop-in price of 0 or a capacity of 0 or 5000 is refused.
- [ ] **A14b. Edit and delete.** Open a book: **Edit details** > change author > **Save changes**; per copy **Save copy**, **Delete 1 copy**; **Delete this book** (ask first, it cannot be undone). **You should see:** each change saved; the public page updates.

### 5D. Awards, locations, sources, selling in shop

- [ ] **A15 (must). Awards.** Open a book > **Awards & lists**: type `Booker Prize (2019)` in **Add awards (comma separated)** and press **Add**. **You should see:** it shows on the public book page at once under "Awards & lists:". **Remove** it: gone. **Re-check now** looks again on Wikidata and the New York Times (best-seller lists need the NYT key). Found entries are listed on the book page with their source and show to customers at once; there is no review step. **You should see:** an entry in **Admin activity** for each add, remove and re-check.
- [ ] **A16 (must). Locations and Move books.** Open **Move books** (`/admin/inventory/move`): choose or type a new place ("Move books to"), scan or type an ISBN, press **Move**. **You should see:** "N moved so far" and the new place offered in lists. On **Books & Reservations** use the **Location** filter and see the copy there.
- [ ] **A17. Copy source.** Check a copy's **Source** (Donation / Purchase / Job lot / Other / Unknown) on the book page and in the **Inventory on hand** report. **You should see:** it saved.
- [ ] **A18 (must). Sell in shop is retired.** Open `/admin/inventory/sell` (an old bookmark). **You should see:** the Till, with the note "Sales are made at the Till now"; nothing is sold and there is no "Sell in shop" button in Books & Reservations or on the scan page. Old sales made there still appear in **Reports > Sales over time** and the accounting export.

### 5E. Reports and CSV

- [ ] **A19 (must). Reports.** Open **Reports**. **You should see:** eight: **Inventory on hand**, **Aging stock**, **Sales over time**, **Sell-through by genre**, **Membership**, **Intake log**, **Accounts**, **Accounting export**. Open each: it shows tables; with **From / To / Group by** and **Show** where available ("Paris days. Without dates, the last 12 months are shown.").
- [ ] **A20 (must). CSV.** On each report press **Download CSV** for at least one table. **You should see:** a file `umas-books-<report>-<table>.csv` that opens in a spreadsheet with the same numbers, and **no buyer names** (the **Accounts** report is the one exception: it lists names and emails). Each download is logged in **Admin activity** ("report.csv").
- [ ] **A19b.** **Reports** > **Accounts**. **You should see:** a summary of counts (total accounts, admins, volunteers, members, expired members, account holders, unconfirmed, created in the last 7 and 30 days, with at least one paid reservation) and a table of all accounts with Name, Email, Type (Admin, Volunteer, Member, Account or Unconfirmed), Member until ("no end date" for a granted membership), Email confirmed, Created, Last login, Paid reservations, Total spent (refunded reservations not counted) and Disabled. Filter by **Type**, by name or email and by creation dates > **Show**; pages of 50; **Download CSV** gives the same filtered list with the same columns, logged in **Admin activity** as `report.csv`.
- [ ] **A21.** Sales report after AC26, AC35 and A63 (a sale at the Till). **You should see:** the online sale, the shop sale, and the drop-in seat counted separately.

### 5F. Book requests

- [ ] **A22 (must). Matching on intake.** Make sure a confirmed request for `9780141439518` exists (G31 to G33). **Add** that book to stock (A9). **You should see:** on the scan page "1 customer asked for this book" (or on the book page), and under **Book Requests** the request moved to **Matched (a copy is in the shop)**.
- [ ] **A23 (must). Notify and hold.** In **Book Requests** (`/admin/requests`; filters Active, Open, Matched, Notified, Waiting for email confirmation, Fulfilled, Cancelled, Expired, All) press **Notify**: "Email sent." The requester receives the "Good news" email (G38). Press **Notify and hold 7 days**: "Email sent and the copy is held for 7 days." and the copy shows as Reserved on the book page ("Cancel reservation & return to stock" frees it). Then **Mark fulfilled**: "Marked as fulfilled." Also try **Match to a book** with a book id or ISBN, **Save note**, **Cancel** ("Request cancelled and the requester's contact details removed.") and **Delete**.
- [ ] **A23b.** A hold ends by itself after its time (7 days for a request hold) and the copy goes back on sale. **Known:** not practical to wait for it in a test; check on a real hold during the first weeks.  The public "reserve a book" button no longer exists: only an admin can hold a copy for someone.

### 5G. Reservations

- [ ] **A24a (must).** `/admin/orders` after the reservation steps (2F to 2H). **You should see:** the page opens on **Reserved: awaiting pickup**, with name, email, items, total, "held until the end of <date>" and the status for each reservation; the **Show** menu (Reserved, Expiring in 3 days, Expired, All reservations, Paid, Refunded, Cancelled), a link to the **Pickup list** and its print version, 50 per page with Newer/Older links. A reservation that nobody collects becomes **Expired** after its deadline (AC40).
- [ ] **A24b (must). Find a reservation.** On `/admin/orders` use **Show** (Reserved, Expiring in 3 days, Expired, All reservations, Past the deadline, or one status), the **Reserved from / until** dates, and **Search** (reservation number such as `12` or `#12`, email or name). Open a reservation. **You should see:** the list narrows to matching reservations, with counts in the Show menu; the reservation page lists the items (and what happened to each book or seat, with its shelf), the buyer and account, the payment ("Nothing was paid online" while reserved, or how and when it was paid in the shop), when the terms of sale were accepted, the history, and the action buttons.
- [ ] **A24c (must). Mark collected and paid.** Open a reserved reservation with books. Choose **How did they pay?** (Cash, Card at the shop, Cheque or Other); **Amount received** is already filled in with the total. Press **Mark collected and paid**. **You should see:** "Collected and paid: the books and seats are sold and the reservation now counts as a sale."; the reservation is **Paid** and **Collected** with "Paid in the shop on <date> by Cash: €X received"; the form is gone; **Admin activity** has a line `order.collected_paid`; the sale appears in the dashboard and the sales report **today** (the day of the payment, not of the reservation). Pressing it again (second tab) changes nothing.
- [ ] **A24d (must). Refund a paid reservation.** First give the money back to the customer in the shop (cash, cheque or card; runbook, section k: "Refund after collecting"). Then open the reservation, press **Mark refunded**. **You should see:** a page with the warning "Do this only AFTER you gave the money back to the customer in the shop (cash, cheque or card)", a tick box and a required note. Confirm. **You should see:** the reservation is **Refunded** with your note and the time; its books are **in stock** again on the public site; a drop-in seat is open again; the reservation is gone from **Total Sales**, the sales report and the buyer's totals; the sales report has a **Refunds** table; **Admin activity** has `order.refunded`. Doing it twice, or on a reservation that was not collected, changes nothing.
- [ ] **A24f. Needs attention box.** On the dashboard, with a reservation that expires within 3 days, or one past its deadline that has not been released yet. **You should see:** a **Needs attention** box with a count and a link for each, going to the matching list (**Expiring in 3 days**, **Past the deadline, not yet released**). With nothing to do, the box is not shown. Reservation and sales figures count only paid reservations (not refunded ones), by the day the payment was recorded, in Paris time.
- [ ] **A24h. Pickup list.** On `/admin/orders` press **Pickup list**, then **Print version** (`/admin/orders/pickup-list?print=1`). **You should see:** every open reservation grouped by customer (name, email, phone), each with its items, the shelf of each book (or "drop-in seat (pay at the session)"), the amount to collect, a total at the top; the print version is compact and has a **Print** button. With no reservation: "No reservation is waiting for pickup."
- [ ] **A24i. Partial pickup.** Open a reservation holding at least two items (**Collect selected items** is only shown then), tick one, choose how they paid, press **Collect selected items**. **You should see:** "Collected and paid for the selected items. The other items stay reserved on a new reservation with the same deadline."; the reservation lists the ticked item as sold and shows "Related reservation: #<new number>"; the new reservation is **Reserved** with the other items.
- [ ] **A24j. Extend, cancel, no-show.** On a reservation holding books press **Extend by 7 days**. **You should see:** "The deadline was extended by 7 days.", "Extended once on <date>", the deadline 7 days later, and the button gone (once only). Press **Cancel reservation** (confirm): "The reservation was cancelled: its books are back on the shelf and its seats are free again." On another reservation press **Mark no-show / expired**: "Marked as no-show: the books are back on the shelf and the seats are free again." and the status is **Expired** (the customer's page says "Reservation ended").
- [ ] **A24k. Reservations report.** **Reports** > **Reservations** (`/admin/reports/reservations`). **You should see:** by month: Reserved, Collected (sold), Expired / no-show, Cancelled, Still open, Value collected and the Conversion rate (collected out of the reservations that are over); **Download CSV** works; no names or emails.
- [ ] **A24l. Collecting for less than the total.** On a reservation lower **Amount received** (a discount given at the till) and leave **Note** empty, press **Mark collected and paid**. **You should see:** "When the amount received is lower than the total, please write a note saying why" and nothing recorded. With a note it works, and the reservation shows "reserved for €X" next to the amount received. The amount cannot be higher than the total. Without choosing **How did they pay?** it is refused too.

- [ ] **A44 (must). Resend confirmation.** In `/admin/orders`, find a **reserved** reservation. **You should see:** under it "Confirmation: sent <date>" (or **NOT SENT** in red words if the email never went out) and a **Resend confirmation** button. Press it. **You should see:** "Confirmation sent." and a new reservation confirmation email in the customer's mailbox. Only a reservation that is still open has the button ("Only a reservation that is still open has a confirmation to resend.").
- [ ] **A43. Email outbox.** Open **Email outbox** (menu, or `/admin/email-outbox`). **You should see:** the last 100 emails the site sent (kind, to, subject, status sent / pending / failed, tries, last error), **Retry now** on those not sent, and **Mark failed as handled**. After a signup or a contact-form message, a new row appears with status **sent**. If Gmail is down a row stays **pending** with an error and is retried by itself after 1, 5, 15, 60 minutes (runbook section k).
- [ ] **A46. Needs attention.** On the dashboard (`/admin`), a "Needs attention" box appears only when something is wrong: a reservation with no confirmation sent after 30 minutes, a reservation expiring soon, failed emails, or a membership payment that matches no account. **You should see:** no box when everything is fine.
- [ ] **A80 (must). Privacy requests.** Open **Privacy requests** (menu, or `/admin/privacy`). Type the email of a throwaway account that also made a test reservation and signed up to an event > **Look up**. **You should see:** counts for accounts, reservations, event and class sign-ups, book requests, membership payments, stored emails (subject and date only, no text) and form mail. **Download everything (JSON)** gives a file with that data and no password hashes. **Erase everything for this address** asks you to type the address again; a wrong address erases nothing; the right one erases the account and sign-ups, and the reservation stays with the name "Erased". An administrator's own address is refused. On **Admin activity** the entries are `privacy.lookup`, `privacy.export`, `privacy.erase` with a code, **never the address**. Runbook section "A data request (access or erasure)".
- [ ] **A81. Accounts report view is logged.** Open **Reports > Accounts** (it lists every account's email). **You should see:** on **Admin activity** one `reports.accounts.view` entry for you; reloading or filtering within the hour adds none.
- [ ] **A82 (must). Both addresses, before launch.** While still in preview mode, open `/admin/diagnostics/client-ip` on `https://umas-books-cmvv.onrender.com` **and** on `https://umasbooks.org`. **You should see:** req.ip is your own public address on both (runbook "Check the real client IP", step 5). After launch the Render address only answers `/healthz` and the HelloAsso webhook: a page there redirects to umasbooks.org.

### 5H. Members and roles

- [ ] **A24 (must). Create, roles.** **Accounts** > **+ Add Member** (Name, Email, optional **Mark as a member**, **Mark as a volunteer**, **Make an admin**) > **Add & Send Invite**. Open an account (**View**): **Mark as Member** / **Remove Member Status**, **Mark as Volunteer**, **Make Admin** / **Remove Admin**. **You should see:** the status changes at once; the person's open session loses or gains access soon after.
- [ ] **A42 (must). Mark as Member gives no end date.** On a confirmed throwaway account press **Mark as Member**, then **View** it. **You should see:** **no** "Membership" end-date line (a paid membership shows one), and when that person opens `/membership.html` it says "You are a member, with no end date." (M15). **Remove Member Status** takes it away at once (M14).
- [ ] **A45 (must). Unmatched membership payment.** Make a test payment on the HelloAsso membership form using an email that has **no** account (for example a typo of your own). **You should see:** within a few minutes an email "Membership payment from <that email> matches no confirmed account", the dashboard box (A46), and on **Accounts** (`/admin/members`) a section **Unmatched membership payments** listing it. Type part of your real account's email under it > **Search** > **Link to account**. **You should see:** "Payment linked and membership granted.", the payment leaves the list, and your account is a member with an end date 365 days after the payment. Runbook section n.
- [ ] **A25 (must). Disable.** **Deactivate Account** on a throwaway account. **You should see:** that person (with the right password) sees "This account has been deactivated. Contact us if you think this is a mistake."; **Reactivate Account** restores it.
- [ ] **A26.** Demote the second admin (**Remove Admin**). **You should see:** they lose admin pages. You cannot demote yourself, and the last admin cannot be demoted or erased.
- [ ] **A27.** **Edit** tab: change the Name and Email of a throwaway account. **You should see:** saved; an email already used is refused ("That email is already used by another account — nothing was changed."); a changed email needs a new confirmation.
- [ ] **A28.** **Download data (JSON)** on an account. **You should see:** a JSON file. **Erase Member** on a throwaway account (cannot be undone). **You should see:** the account is gone (like AC18).
- [ ] **A29.** **Members** menu (`/admin/members?role=member`) and filters (All accounts, Admin, Volunteer, Member, Account holder, Unconfirmed, each with a count; All Statuses; date ranges; sort). **You should see:** only paying or granted members whose membership has not ended; **Clear Filters** resets.
- [ ] **A29b.** **Accounts** menu (`/admin/members`). **You should see:** everyone with an account, not only members, with a **Role** pill on each: **Admin**, **Volunteer**, **Member** or **Account** (a confirmed account that is not a member), plus extra pills when several apply (for example Admin + Member), **Not confirmed** for an email never confirmed and **Membership expired** for a lapsed member. Each filter (Volunteer, Account holder, Unconfirmed...) lists the right people, and the footer reads "of N accounts".

### 5I. Events, English programs, meetings, shifts

- [ ] **A30 (must). Events.** **Events** (`/admin/events`): click a day or **+ Add event**: Title, Start time, End time, Location, Capacity, Price. **You should see:** it appears on the public `/events` page. Sign up as a guest (G23): admin sees the person under "Signed up" with **Remove**. **Edit** changes the event; **Delete event** removes it. A full event (capacity reached) shows **Full** publicly.
- [ ] **A31 (must). English Programs / sessions.** **English Programs** (`/admin/sessions`): **+ Add session**: Title, Program type, Start time, End time, Location, Capacity, **Drop-in price**. **You should see:** it appears on `/sessions` (with a price an account holder can reserve a seat, AC33). Reserved drop-in seats show under "Drop-in seats (reserved = pay at the session)"; free legacy sign-ups under "Signed up (free, legacy)".
- [ ] **A32. Meetings.** **Meetings**: **+ Add meeting**: Title, Time, Location, Agenda; after the meeting add **Minutes** > **Save minutes**; **Delete meeting**. **You should see:** members see it on `/meetings` with "N going" (M10) and the minutes under "Past meetings & minutes".
- [ ] **A33. Volunteer Shifts.** **Volunteer Shifts**: **+ Add shift**: Role, Start time, End time, **Repeat weekly, this many times (including this one)**, Notes. **You should see:** one shift per week; "N / 1 filled"; **Delete** removes it.

### 5J. Announcements, blog, charity

- [ ] **A34 (must). Announcements.** **Announcements**: create with Title, Excerpt, Content, category, status (Publish Now, Draft, Scheduled), **Pin**. Filter tabs All / Published / Scheduled / Drafts / Archived / Trash; bulk **Publish / Archive / Move to Trash**; **Restore**; **Delete Permanently** (ask first). **You should see:** a published announcement on the members' dashboard ("View All Announcements"), a draft or scheduled one not; pinned ones first.
- [ ] **A35 (must). Blog.** **Blog**: Title, Content, Excerpt, Publish Date, Status (Draft / Scheduled / Published), Featured Image (JPG or PNG, max 5 MB), Category, Tags, **Preview**. **You should see:** a published post on `/blog.html`, a draft not; bulk **Publish / Move to Draft / Delete**.
- [ ] **A36 (must). Charity.** **Charities** > **Start a New Vote**: Question, Label, Voting ends, **Allow multiple selections**, **Show results while voting is open**, **Visible to** (Members Only / Everyone), **Start Vote**. Add charities (**From the library** or **Or create a new charity** > **Add & Include in Vote**). **You should see:** members can vote (M8); results show votes and percent; **Edit Vote Settings**, **Remove from Vote**, **Close Vote** (it moves to "Past Votes"). **Submitted Ideas** tab: approve or reject (M9).

### 5K. Forum moderation

- [ ] **A37 (must). Hide with a statement of reasons.** As admin on a forum thread or reply press **Hide this post**: pick a **Reason (sent to the author)** (Illegal content, Harassment, Spam, Other), add a **Note to the author**, confirm. **You should see:** the post now says "This post was removed by the moderators." to members and the admin sees "Hidden:" with **Restore**. The author receives "A post of yours was removed from the Uma's Books forum" with the reason (and the way to contest). Hiding it twice does not send a second email. **Restore** puts it back.

### 5L. Audit log, pricing settings, price stickers

- [ ] **A38 (must). Admin activity.** **Admin activity** (`/admin/audit`). **You should see:** a table When / Admin / Action / Target / Detail with recent actions (logins, book changes, sales, CSV downloads, hides, role changes). Nothing sensitive (no post text, no passwords).
- [ ] **A39 (must). Pricing rules.** **Pricing rules** (`/admin/pricing`): read the rules; change **Clearance price (EUR)** to 2, **Save pricing rules**; add a copy; **You should see:** the new clearance price offered. Set it back to 1. **Try it** (calculator) shows the price that would be suggested for an online value, a binding and a number of copies already in stock. **Price check** (`/admin/pricing/review`): "Needs review", "Priced differently from the suggestion" with **Use suggested**, and "Clearance candidates" with **Apply clearance to these copies** (preview: nothing changes until you confirm).
- [ ] **A40. Price sticker colors.** **Coming.** The page for price sticker colors is not on the site yet. When it is merged, add steps here: open the page from the admin menu, change a colour, check that the price labels follow it.
- [ ] **A41. Online price check (optional).** If `PRICING_AI` is on, adding a book also fetches an online market value ("Why this price?" lists "Listings found"). It is off by default (runbook section h): then suggestions use the built-in rules only and that is normal.

### 5M. The till, copy labels, end of day, accounting export

- [ ] **A60 (must). The Till page.** In the admin menu press **Till**. **You should see:** a big scan box with the cursor in it, **Cash** and **Card** buttons (greyed until something is on the sale), quick items if you made some. Click on empty space, then type a code: it still goes into the scan box. Type `hello` and Enter: a red message "Code not recognised" (and a beep if the sound is on).
- [ ] **A61. Copy labels.** **Books & Reservations** > a book > a copy > **Label**, or **Price stickers** > **Print labels (barcodes)**, or `/admin/inventory/labels`. Choose copies, **Print labels**. **You should see:** a label with a barcode, the code `UB-` and the copy number, the color chip, the price, the title, the author and the ISBN (or "No ISBN"). Change the size (50 x 25 mm by default) and print preview: the label fits the page.
- [ ] **A62. End of day, quick items, accounting export open.** `/admin/till/day` shows the cash drawer and **Close the day**; **Inventory > Other stock (not books)** (`/admin/till/items`) lets you add items such as a tote bag (price, category, optional stock); **Reports > Accounting export** shows one row per day, category and payment method, with **Download CSV** and no names.
- [ ] **A63 (must). Sell with cash.** On the Till scan a copy label (or an ISBN), press **Cash**, **Exact**, **Confirm sale**. **You should see:** "Sale recorded", **Next customer**, the receipt page (TVA non applicable, no customer data). Then under "Today's sales" **Void sale** with a reason: the book is back in stock.
- [ ] **A64 (must). Sell with card.** Scan, press **Card**; the screen says "Charge EUR x on the SumUp reader, then press Card paid". Charge the reader, press **Card paid** (optionally type the last 4 digits first). **You should see:** "Sale recorded".
- [ ] **A65 (must). Close the day.** On **End of day** enter the opening float in the morning; at night count the drawer, type the total, **Close the day**. **You should see:** the difference (over/short), the day marked CLOSED, and the Void buttons gone for that day. A past day with sales that was never closed appears in **Needs attention** on the Dashboard.
- [ ] **A66 (must). The scanner.** Open the Till, scan a label with the barcode scanner. **You should see:** the code appears in the scan box and the book is added at once (the scanner presses Enter by itself). If it types strange characters, see the runbook, section "The till".
- [ ] **A67. Things that are not books.** **Manual item** (description, price, quantity, category) and an item added under **Inventory > Other stock (not books)**, such as a tote bag. **You should see:** they are on the receipt, in End of day by category, and in the accounting export under Merchandise, Refreshments or Donation.
- [ ] **A68. A book with no ISBN.** **Add Book**: "No ISBN? Enter the details by hand": fill the title, author, genres, binding, condition and price; print the label; sell it at the till by scanning the label. **You should see:** "No ISBN" on the label and no error anywhere.
- [ ] **A69 (must). Accounting export.** Download the CSV and give it to the treasurer. **You should see:** the treasurer can import it (see `docs/till-todos.md`: this is not confirmed yet).
- [ ] **A71 (must). Collect a reservation at the till.** Make a reservation as a customer (steps AC22 to AC24, two books if you can). At the till (`/admin/till`) type or scan **ORDER-<the reservation number>** (the number is on the reservation page and in the email) and press Enter. **You should see:** all the reservation's lines appear at the reserved prices (books with their shelf, a drop-in seat as a line), with the message "Reservation #N for <name>". Remove one book (the customer leaves it), press **Cash**, give an amount and confirm. **You should see:** the sale is recorded and the receipt lists the lines; in admin Reservations the reservation is **Paid** with payment method **Cash** (for the books that were taken), and the book you removed is still reserved on a **new reservation** with the same deadline (scan its new reservation number to collect it later). Scanning the **UB- label** of a reserved book opens its reservation too. A sale that collected a reservation cannot be voided at the till: the message tells you to use **Mark refunded** on the reservation.

- [ ] **A70. Barcodes on items.** Under **Inventory > Other stock (not books)** click in an item's **Barcode** box and scan the item with the scanner; **Save**. On the Till scan it twice. **You should see:** the item added, then a quantity of 2 (use + and - to change it). For an item with no barcode press **Generate a shop code**, then **Print barcode label**: a label with `ITEM-<number>`. Using a code that starts with `UB-` or one already used by an active item is refused with a clear message.
- [ ] **A71. Tablet layout.** Open the Till on a tablet (or a browser window 768 px and then 1024 px wide) with three books on the sale. **You should see:** the sale in one column with the title readable (not one letter per line), the price and **Remove** under or beside it, the total and Cash / Card below, and the admin menu behind a menu button (three lines) rather than a permanent sidebar. At 375 px the page does not scroll sideways.
- [ ] **A72. Admin menu.** **You should see:** the menu grouped under Sell, Reservations & members, Programs, Reports, Site content and Settings; **Till** is an outlined button that turns filled (white text) only while you are on the till; the "Search books" box shows only on the Dashboard and Inventory.
- [ ] **A73. Print a label roll.** Print 3 labels on a roll (**Printing on: A label roll**, 50 x 25 mm). **You should see:** 3 pages, the first one a label (no "Copy labels" heading), bars that scan with the scanner. Try 203 and 300 dpi and a 30 mm width (a warning appears).
- [ ] **A74. Confirmations.** Press **Delete this book**, **Delete 1 copy**, **Delete event**, **Remove** (a sign-up), **Deactivate Account**, **Make Admin**, **Close the day**, **Void this sale**. **You should see:** a clear question each time; Cancel does nothing.
- [ ] **A75. Add Book form.** Open **Add Book**. **You should see:** the cursor in the ISBN box, no red "Manual review" message, **Save book** and **Save and add another** always visible at the bottom, and after "Save and add another" a blank form with the location kept.
- [ ] **A76. French receipt.** Sell something and open the receipt. **You should see:** "Ticket n° 2026-0001" style numbering without gaps, "Payé en espèces" / "Payé par carte", "Reçu", "Rendu", "Merci de votre visite", "TVA non applicable"; a voided sale prints "ANNULÉ" with the same number.
- [ ] **A77. French Excel export.** Download the Accounting export with **Download for French Excel** and open it in French Excel. **You should see:** nine columns and numbers (not text) with decimal commas; a refunded online reservation has a negative row on the refund day; **Accounts mapping** shows the accounts and a change is listed in Admin activity.
- [ ] **A90 (must). The price changed under a card sale.** On the Till put a book (asking price 5.00) on the sale. In a second tab change that copy's price to 8.00 (Books & Reservations > copy > save). Back on the Till press **Card**, then **Card paid**. **You should see:** a red message "The price changed: new total EUR 8.00. For a card sale do not charge again: cancel the card charge on the reader and restart." and a **Restart the sale** button; **nothing is recorded** (the book is still in stock, no sale in Today's sales).
- [ ] **A91 (must). The card was charged but the sale is refused.** Put a book on the sale, press **Card**. In a second tab sell the same book at another till (or mark the copy withdrawn). **You should see:** the Card screen shows the reason as soon as it opens (before you charge). Then try the other order: open Card, press **Card paid** and only then make the book unavailable: **You should see** the red box "The card was already charged. Do NOT charge again." with the reason under it, the button now **Record card sale**, and **Record anyway**; reloading the page keeps the screen. Never "Connection problem" for a server error.
- [ ] **A92 (must). Closed day.** Close the day (A65), then try to sell: **You should see:** a refusal "Today's till is closed". As an admin tick **Reopen this day to record this sale**, type a reason and sell again: it works, the day is open again (End of day says it was reopened) and **you must close it again**. Check **Admin activity** for `till.day_reopen`.
- [ ] **A93 (must). Till access for a volunteer.** **Accounts** > a volunteer > **Till access: off (give)**. Log in as that volunteer in another browser. **You should see:** you land on the Till; the menu has only Till and End of day; you can scan, sell, void a sale from today and look at End of day (no Close, no float form); a price lower than the asking price is refused with "Only an admin can change the price"; `/admin` and `/admin/members` say "Admins only". After 8 hours without using the till you are logged out. Remove the access: it stops at once. The Accounts list shows a **Till** pill.
- [ ] **A94 (must). The scanner while a payment screen is open.** Put a book on the sale, press **Cash**, then scan any label with the scanner. **You should see:** the note "Finish or cancel this payment first"; the amount received is unchanged; the sale is **not** confirmed and nothing new is added. Type `20.` with the keypad: it is accepted as 20.
- [ ] **A95 (must). Void a card sale.** Sell a book by Card, then **Void sale**. **You should see:** "This was a card payment: refund it on the SumUp reader or app yourself" and an **I refunded the card** box. Void without ticking: the Dashboard **Needs attention** and End of day list "voided card sale ... not marked as refunded"; refund in SumUp, tick **I refunded the card**: the warning goes away.
- [ ] **A96. Sales this month.** The Dashboard tile **Sales this month** shows a total with "Till, Online, Membership" below it. **You should see:** the same total as **Reports > Accounting export** for this month (to the euro).
- [ ] **A97. Backdating and limits.** As an admin, **Sale made earlier**: Yesterday, a time and no reason: refused. With a reason: recorded, and the activity log shows it. A basket above EUR 10,000 is refused with "Sale total too large". A price below the asking price asks for a reason. A book in an abandoned online cart (older than an hour) offers **Release this copy from the expired cart and add it**.

## Script 6. Edge and negative tests (everyone)

- [ ] **E1 (must). Expired session, then submit.** Open the contact form (`/contact`) or the login page. In your browser delete this site's cookies (Settings > Privacy > cookies for this site), then press the form's send button. **You should see:** a plain page "Your session expired or this form is out of date. Please go back and try again." (English only: **Known**, plain text page). Go back, reload the page, try again: it works.
- [ ] **E2 (must). Double-click on reserve.** Logged in as an account holder, in the cart double-click **Reserve (free, no commitment)** fast. **You should see:** one reservation page, and in **Admin > Reservations** only **one** new reservation (not two). No duplicate email later.
- [ ] **E3 (must). Back button after reserving.** After the "Reservation #N recorded" page press the browser back button three times, then forward. **You should see:** no error page; the cart is empty; no new reservation in admin; pressing **Reserve (free, no commitment)** again on an old page does not create a second reservation. Reload the reservation page: still the same, no second email.
- [ ] **E4.** Cancel a reservation (AC38), then open its old link (from the email or the browser history). **You should see:** "Reservation cancelled" with a link back to the books, nothing held, and the book is for sale again.
- [ ] **E5 (must). Mobile layout (375 px).** On a phone, or in the desktop browser with the window made narrow (Chrome: View > Developer > Developer Tools > the phone icon > width 375), open: the home page, a **book page** (the **Condition / Price / Add to Cart** table must be readable, with no sideways scrolling and the buttons large enough to tap), the **cart**, the **reserve form** (fields and the terms checkbox usable, **Reserve (free, no commitment)** reachable), the **menu**. **You should see:** nothing cut off, no text on top of other text, no horizontal scroll. Check in EN and FR (French words are longer).
- [ ] **E6.** Back in preview mode, mobile: the "Preview" banner does not cover the menu or the cart button.
- [ ] **E7.** Log in on two browsers at once, change the password in one. **You should see:** the other browser is logged out the next time you do something.
- [ ] **E8.** As a logged-in account holder (not an admin) open `/admin`. **You should see:** "Admins only." Not logged in: the login page.
- [ ] **E9.** Type a very long text (5000+ characters) in the contact form, and 300 characters in a book request title. **You should see:** a clear message (for the book request: "Something you typed is too long. Titles can have up to 200 characters and notes up to 500."), no crash.
- [ ] **E10.** Visit the site with the browser language set to French and no choice made. **You should see:** the site in French on the first visit.
- [ ] **E11 (must). Back button after a refused form.** Submit forms the wrong way, one after the other: log in with a wrong password; send the contact form with the e-mail field left as `abc` (switch off the browser's own check by removing the `required`/type in the developer tools, or use a different browser that lets it through); send a book request without a title; in the cart (logged in, empty) press **Reserve**; change the password with a wrong current password. After each, press the browser **back button**, then **forward**. **You should see:** never the browser's "Confirm form resubmission" box and never a re-sent form; the message is shown once under the form (a reload of that page shows the form without it), what you typed (but never a password) is still in the fields, and the page is in the language you chose (French: fully French). **Known:** the page that shows your **recovery codes** right after turning two-step on or asking for new codes is the one place that still answers the button press directly (the codes are shown only once and are never stored), so going back to it may ask to resubmit.

## Reset after testing

- **Test accounts and reservations:** delete throwaway accounts from **Accounts** > the person > **Erase Member**; cancel your own open book requests (**My book requests**).
- **Test books, reservations, forum posts, sample data:** run the clearing script: runbook section g, "Clearing the test data" (`npm run clear-test-data`: back up first, dry run first, then the real run). It removes the shop, all non-admin accounts and their data, and the audit log, and keeps admins, pricing rules and (unless told otherwise) content. Do not launch with test reservations or test accounts in the shop.
- **Preview mode:** put `PREVIEW_MODE` back on (runbook section g, "Turning it on again") whenever the site holds test data again, and at launch the runbook checklist says `HELLOASSO_API_BASE` must be unset or the production address, **not** the sandbox one, so switch it back (and the HelloAsso keys to the live ones) only when you are ready to launch.
- **Emails:** delete the test emails from the shop mailbox.

## Results

Copy this table for each full run.

| Date | Tester | Script (1 to 6) | Pass / fail | Failed step numbers and notes |
|---|---|---|---|---|
| | | 1 Guest | | |
| | | 2 Account holder | | |
| | | 3 Member | | |
| | | 4 Volunteer | | |
| | | 5 Admin | | |
| | | 6 Edge cases | | |
