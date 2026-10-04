# Manual test scripts (before launch)

Plain-language checklists for testing the whole site by hand, one script per
type of user. Written for the maintainer (not a developer). No tools needed
beyond a browser and a mailbox you can read.

Written against the site as of 4 October 2026, including pull request #181
(accounts: no login until the email is confirmed). Things that are about to
change are marked **NOTE (changing)**; things I could not verify from the code
are marked **TODO**.

## How to use these scripts

- Work through one script at a time. Each script takes about 20 to 40 minutes.
- Tick `[ ]` as you go. Write any failure in the results table at the end,
  with the step number (for example `G7`) and what you saw instead.
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

## Before you start

### 1. Which site, and is it safe to test?

- Test on the real site only while it still holds sample and test data (preview
  mode on) or on a copy. Never run the buying scripts against real customers.
- **Preview mode** (Render environment variable `PREVIEW_MODE=true`, runbook
  section g): the site shows a "Preview" banner, and **payments are switched
  off** (cart checkout and the membership form). Scripts 1 and most of 3 work in
  preview mode. The payment steps in scripts 2 and 3 only work with preview
  mode **off**.
- **TODO (ask the developer before the first payment test):** which HelloAsso
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
  sandbox mode at the moment (see M13). **TODO** confirm with the developer.

### 2. Accounts you need

Use **throwaway** accounts. Never use a real member's account.

| Role | How to get it | Notes |
|---|---|---|
| Visitor | No account. Private window. | |
| Guest buyer | No account. Use an email you can read. | |
| New member | Sign up yourself in script 3 with an address you can read, for example `YOU+member1@gmail.com` (Gmail delivers `+anything` to your inbox). Use a different `+` for every test account. | Signing up does **not** make you a member. Membership comes from paying, or from an admin pressing **Mark as Member** (M13 and script 5). |
| Volunteer | A second throwaway account that an admin marks as volunteer (script 4). | |
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
Emails are sent in the language the site was in when you signed up, ordered, or
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
| 9780060935467 | To Kill a Mockingbird | Hardcover/paperback and awards test |
| 9780141439518 | Pride and Prejudice | Request-a-book test (do NOT add it to stock until you have asked for it, R3) |
| 9782070360024 | L'Etranger (Folio) | A French-language book |
| 9780439023481 | The Hunger Games | Spare |

Other test values: a name such as `Test Buyer`, a phone `0600000000` (optional
field), a throwaway password `Test-Password-2026!` (any password with 8+
characters, upper and lower case, a number and a symbol, which is not in a known
data breach; the site rejects leaked passwords, so if it complains, choose
another).

## Script 1. Visitor (not logged in)

Use a private window. Time: 30 to 40 minutes.

### 1A. Home, menu, footer

- [ ] **V1 (must).** Open the home page `/`. **You should see:** the Uma's Books & Adventures page, a menu (Home, Browse Books, English Programs, Events), icons at the top right (heart, receipt/account, cart with a number, key, person, **EN | FR**), and a footer with **Contact Us**, **Albi, France**, **Privacy Policy**, **Terms of Sale**, **Legal Notice**.
- [ ] **V2.** Click each footer link. **You should see:** each page opens, no error page. (The Instagram and Facebook icons say "coming soon" and do nothing: that is intended.)
- [ ] **V3.** Click the key icon (Member's Access) while logged out. **You should see:** the membership page (not a login form).
- [ ] **V4.** Click the person icon. **You should see:** the Log in page with "Forgot your password?" and "Create an account" links.

### 1B. Preview banner and payments off (only while `PREVIEW_MODE` is on)

- [ ] **V5 (must).** Look at the top of any page. **You should see:** a banner "Preview — Uma's Books is opening soon. You're looking at a test version with sample books: nothing here is real yet and no payment is taken." with a link **Tell us what you think!**
- [ ] **V6.** Click **Tell us what you think!** **You should see:** the contact form with the topic already set to "Feedback on the preview".
- [ ] **V7 (must).** Add any book to the cart, open the cart. **You should see:** the cart, the total, and the message "Online ordering opens when we launch. This is a preview, so you can fill a cart to see how it works, but nothing can be ordered yet." and **no** Name/Email/Pay form.
- [ ] **V8 (must).** Open the membership page `/membership.html`. **You should see:** "Membership opens at launch" and **no** payment form.
- [ ] **V9.** Open `/robots.txt`. **You should see:** a line `Disallow: /` (search engines told to stay away). After launch (preview off) this line must be gone: re-check at launch.
- [ ] **FR check.** Switch to FR on steps V5, V7, V8. **You should see:** the banner, the cart notice and the membership notice in French ("Aperçu — Uma's Books ouvre bientôt...", "La commande en ligne ouvrira au lancement...", "L'adhésion ouvrira au lancement").
- [ ] **V10.** (Preview **off** only.) None of the above appears; the cart shows the checkout form (script 2).

### 1C. Books: search, filters, book page

- [ ] **V11 (must).** Open **Browse Books** (`/books.html`). **You should see:** a search box ("Search by title, author, keyword, or genre…"), genre buttons, a "New In" carousel with arrows and **See All New In**, and a book recommendation.
- [ ] **V12.** Type part of a title you know (for example `Gatsby`) and press **Search**. **You should see:** a results grid with covers, titles, prices, condition labels. A search with no match should show a "no results" message, never an error or a blank page (report it if blank). (At most 60 books are listed.)
- [ ] **V13.** Click a genre button. **You should see:** only books of that genre. Click another genre; the list changes.
- [ ] **V14.** Click the arrows on "New In" and **See All New In**. **You should see:** the carousel moves; the full new-arrivals list opens.
- [ ] **V15 (must).** Open a book with stock (click a card). **You should see:** cover (or "No cover"), title, "by <author>", **Binding** (Hardcover / Paperback / Mass Market) when known, the lowest price as `€x.xx`, "Available in Shop", "N copies on our shelves.", a table **Condition / Price** with an **Add to Cart** button per copy, a note that cover images may not show the real condition of the copy, and "More by <author>" if there are others.
- [ ] **V16 (must).** Open **What the grades mean**. **You should see:** four grades with descriptions: New, Like New, Very Good, Acceptable.
- [ ] **V17.** Find a book with a clearance copy. **You should see:** a **Clearance** badge next to the price (on the book page and in the results).
- [ ] **V18.** Find a book with awards. **You should see:** a line "Awards & lists: ..." (more than 8: **Show all (N)**). Nothing appears for a book with no verified or approved award.
- [ ] **V19.** Open a book with no copy in stock. **You should see:** "Currently unavailable" and "All copies of this title are spoken for right now — check back soon."
- [ ] **V20.** Click the heart on a book, then open the heart icon at the top (`/favorites`). **You should see:** the book listed. **Known:** favorites are saved in this browser only ("Books you've hearted on this device"), not in an account.
- [ ] **V21 (must). Copy with no price.** Find a book that has a copy with no price (in admin, add a used copy and leave Price empty, A11). **You should see:** that copy shows **Ask in the shop** (French: **Se renseigner en boutique**) instead of a price, with **no Add to Cart** button, and the headline price ignores it. **NOTE (changing):** this comes from pull request #187 (prices and cart safety). Until it is merged, such a copy may show an empty price with an **Add to Cart** button and would be charged as 0 euros: do not buy it, and report it.
- [ ] **FR check (books).** Switch to FR on the search page, a book page, the grade legend. **You should see:** "Parcourez les livres" menu, "Disponible en boutique", "Ajouter au panier", conditions "Neuf / Comme neuf / Très bon état / État acceptable", "Déstockage" badge, "Reliure : Relié / Broché / Poche", "Prix et classements :", "Actuellement indisponible". **Known:** prices show as `€12.50` in both languages on the book page, cart and order email. The French style `12,50 €` is only used in book-request emails. Decide whether you want it everywhere and tell the developer; this is not a tester error.

### 1D. Events, English programs, blog

- [ ] **V22 (must).** Open **Events** (`/events`). **You should see:** a calendar with **Month / Week**, **Previous / Next**, upcoming events, "Everyone's welcome — browse what's coming up and sign up below, no account needed."
- [ ] **V23.** Sign up for an event with a name and email (use `YOU+event1@gmail.com`). **You should see:** back on the calendar; the event shows one more "going". Signing up again with the same email does not add a second place. **Known:** no confirmation email is sent for events. A full event shows **Full** and no sign-up form.
- [ ] **V24.** Click **Add to My Calendar**. **You should see:** a calendar file (.ics) downloads and opens in your calendar app.
- [ ] **V25.** Open **English Programs** (`/immersion.html`), then `/programs.html` and `/pre-registration.html`. **You should see:** the English Immersion pages, with links **Preregister**, **Check upcoming sessions**. **Known:** the pre-registration form and the volunteer form on `/volunteer.html` open your email app with the message ready to send (a "mailto" form); nothing is stored on the site.
- [ ] **V26.** Open the sessions calendar (`/sessions`). **You should see:** "Upcoming Sessions" with filters **All Sessions, Drop-ins Only, Little Explorers, Adventurers, Readers, Teens, Café / Adults**, and **Month / Week**. Each session shows "N places left" or **Full**; a drop-in session with a price shows **Add to Cart**.
- [ ] **V27.** Open the blog (`/blog.html`) and one post. **You should see:** published posts only (not drafts); a post opens with a back link; an unknown post address shows a "not found" message.
- [ ] **FR check.** Switch to FR on events, sessions and blog. **You should see:** "Événements", "Mois / Semaine", "Précédent / Suivant", "Complet", "Ajouter au panier", "Place drop-in".

### 1E. Contact form

- [ ] **V28 (must).** Open **Contact Us**. Fill in name, email, topic, message and press **Send message**. **You should see:** "Thank you! Your message has been sent". Topics are General question, Books & orders, English programs, Events, Donating books, Membership, Other (plus "Feedback on the preview" in preview mode).
- [ ] **V29 (must).** Check the shop mailbox `admin@umasbooks.org`. **You should see:** your message (within 2 minutes). Reply-to is the address you typed.
- [ ] **V30.** Send 6 messages in a row. **You should see:** after the 5th in 15 minutes: "Too many messages from this connection — please try again in a little while, or email admin@umasbooks.org." Do not repeat this more than once.
- [ ] **FR check.** In French, submit the form with a message. **You should see:** "Merci ! Votre message a été envoyé" (and the rate-limit message in French).

### 1F. Request a book (no account)

- [ ] **V31 (must).** Open `/request-a-book` ("Can't find a book? Ask us"; also linked from Browse Books). Enter **Title** `Pride and Prejudice`, ISBN `9780141439518`, your email, name, and **Send request**. **You should see:** "Check your inbox" and the line that the request only counts once you have confirmed.
- [ ] **V32.** Leave the title empty and send. **You should see:** "Please tell us the title of the book." An ISBN of 5 digits gives "The ISBN should have 10 or 13 digits (or leave it empty)."
- [ ] **V33 (must).** Open the email "Please confirm your book request at Uma's Books". Click its link. **You should see:** "Confirm your book request" with the book, a **Confirm my request** button; press it: "Thank you, your request is confirmed. We'll email you if a copy arrives." The link works for 7 days and once only; clicking it again shows "This link is not valid any more..." with **Make a new request**.
- [ ] **V34.** Do not press the confirm button at all for a second request (use another title). **You should see:** in admin (script 5, A15) the request appears under "Waiting for email confirmation", not in "Active".
- [ ] **V35 (must). Manage link and find-my-requests.** Open `/my-requests`. Enter the same email, press **Send me the link**. **You should see:** "If requests exist for that address, we have sent you a link. It works for 30 days." Open the email "Your book requests at Uma's Books"; click the link. **You should see:** "My book requests" with your requests and **Cancel** / **Cancel all**. Press **Cancel** on one: "Done. Cancelled requests no longer hold your email address." (The request's name and email are deleted.)
- [ ] **V36.** Use the "Cancel this request" link from the confirmation or "good news" email. **You should see:** the "My book request" page; after cancelling, "This request is cancelled and your contact details have been deleted."
- [ ] **V37.** Try a made-up link `/my-requests/abc`. **You should see:** "This link is not valid. Use the most recent email we sent you, or find your requests with your email address."
- [ ] **FR check.** Do V31 to V35 in French. **You should see:** the pages and **both emails** in French (subjects "Merci de confirmer votre demande de livre chez Uma's Books" and "Vos demandes de livres chez Uma's Books").
- [ ] **V38 (continues in A15).** An admin adds a copy of the requested book and presses **Notify**: **You should see** the email "Good news: "Pride and Prejudice" is now at Uma's Books" (French: "Bonne nouvelle : ... est arrivé chez Uma's Books") with price, a link to the book, and, if the admin pressed **Notify and hold 7 days**, a line that the copy is held for 7 days.

### 1G. Legal pages and language toggle on every page type

- [ ] **V39 (must).** Open each legal page from the footer: **Terms of Sale** (`/terms-of-sale.html`), **Privacy Policy**, **Legal Notice** (`/mentions-legales.html`) and **Membership Terms** (`/membership-terms.html`, linked from the membership page). **You should see:** each opens with full text, the seller's identity (Uma's Books, association loi 1901, address in Albi, RNA and SIRET numbers), email `admin@umasbooks.org`. The Terms of Sale have sections on collecting your order (14 days), the 14-day withdrawal right and the model withdrawal form, and the consumer mediator.
- [ ] **V40 (must).** Switch each legal page to FR. **You should see:** "Conditions générales de vente", "Politique de confidentialité", "Mentions légales", "Conditions d'adhésion" and the full French text (no English paragraphs left).
- [ ] **V41 (must).** On each page type in the table below, click **FR**, check the page is French, then click **EN** and check it returns to English. Reload after switching: the language stays. Then click through to a different type of page: the language stays.

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
| Legal pages (4) | see V39 | [ ] | [ ] |
| 404 page | `/no-such-page` | [ ] | [ ] |

### 1H. Cookies, language memory, 404

- [ ] **V42 (must).** Visit any page in a fresh private window. **You should see:** **no** cookie-consent banner. (The privacy policy says the site uses one session cookie that is strictly necessary, plus your language choice in the browser, so no banner is required.)
- [ ] **V43.** Choose FR, add a book to the cart, close the private window completely, open a new one. **You should see:** back to the browser's default language and an empty cart (private windows forget everything). In a normal window the language and the cart are still there next day.
- [ ] **V44 (must).** Open `/no-such-page`. **You should see:** "Page not found" / "This page doesn't exist or has moved. If the problem continues, email us at admin@umasbooks.org." and a **Go home** button; the menu still works. FR: the same in French.
- [ ] **V45.** Open `/books/99999999` and `/books/abc`. **You should see:** the same 404 page (not a crash).
- [ ] **V46.** Open `/admin` and `/account` while logged out. **You should see:** the Log in page.

## Script 2. Guest buyer (no account)

Needs preview mode **off** and HelloAsso in test mode (see "Before you start").
If the cart shows the preview notice, steps G4 onward cannot be run: only G1
to G3 apply. Time: 30 to 40 minutes. Use an email you can read.

- [ ] **G1 (must).** On a book page press **Add to Cart** for one copy. **You should see:** the cart page with that book (cover or "No cover", title, author, condition label, `€price`, **Remove**) and **Total**. **Known:** adding to the cart does **not** reserve the copy; it is only held once you start paying (G6).
- [ ] **G2.** Add a second book, then press **Remove** on it. **You should see:** it disappears and the total updates. (A cart holds at most 20 lines.)
- [ ] **G3.** Open the cart header icon from another page. **You should see:** the number on the cart icon matches the lines in the cart.
- [ ] **G4 (must).** In the cart, check the checkout form: **Name**, **Email**, **Phone (optional)**, a checkbox "I have read and accept the terms of sale (including the right of withdrawal...)" with a link that opens the Terms of Sale in a new tab, a privacy note, and the button **Pay & Buy**. **You should see:** all of these.
- [ ] **G5 (must).** Try to pay without ticking the terms checkbox. **You should see:** the browser refuses and points at the checkbox (you cannot submit). Try an email without `@`: the browser refuses.
- [ ] **FR check (cart).** Switch to FR. **You should see:** "Votre panier", "Retirer", "Total :", "Paiement", "Nom", "E-mail", "Téléphone (facultatif)", "J'ai lu et j'accepte les conditions de vente", **Commander et payer**, and the message "Vous paierez en toute sécurité via HelloAsso, puis vous passerez à Uma's Books pour retirer votre commande."

### 2A. Pay with HelloAsso (test mode)

- [ ] **G6 (must).** Fill Name `Test Buyer`, your email, tick the terms box, press **Pay & Buy** once. **You should see:** you land on a HelloAsso payment page (sandbox if in test mode) showing the total and the book titles as the item name.
- [ ] **G7 (must). Hold.** Do **not** pay yet. In another browser (someone else), open the same book. **You should see:** the held copy is no longer for sale (that copy is gone from the table, or "Currently unavailable" if it was the only one). **Known:** the hold lasts 60 minutes; a background job frees expired holds every 10 minutes, so it can take up to about 70 minutes.
- [ ] **G8 (must).** On the HelloAsso page pay with the test card (**TODO:** card and steps from the HelloAsso sandbox help, see "Before you start"). **You should see:** you are sent back to the site on a page "Thank you!" "Your payment went through — here's what you ordered:" with your items and the total, and "A confirmation email is on its way to <your email>."
- [ ] **G9 (must). Confirmation email (English).** Open the email "Your order at Uma's Books is confirmed". **You should see:** "Order #<number>" with the date, "Paid online via HelloAsso", each item with `€price`, the total, where to collect (Rue Peyrolière, 81000 Albi, during opening hours), and then, in this order:
  - [ ] a link to the Terms of Sale and "your 14-day right of withdrawal for books";
  - [ ] **NOTE (changing):** after pull request #183 is live: "Terms of sale accepted on <date> (version <version>)." (before #183 this line does not exist);
  - [ ] the right of withdrawal (14 days from collecting a book; tell us by email) and the **model withdrawal form** (cancel form);
  - [ ] the **seller identity**: Uma's Books, association loi 1901, RNA, SIRET, address in Albi, phone, `admin@umasbooks.org`, "TVA non applicable";
  - [ ] the **free consumer mediator** (CM2C, Paris address and web address) for complaints.
- [ ] **G10 (must). Confirmation email (French).** Repeat G1 to G9 with the site switched to **FR** before pressing **Pay & Buy**. **You should see:** subject "Votre commande chez Uma's Books est confirmée", the body in French ("Merci pour votre commande — paiement reçu", "Commande n° ...", "Payée en ligne via HelloAsso", "Total : €..."), the terms line "Conditions générales de vente acceptées le ... (version ...)" after #183, and the legal blocks (withdrawal, form, seller, mediator). **Known:** the legal blocks are written in both French and English in every email (required by law), and prices in the email read `€12.50`.
- [ ] **G11.** Refresh the "Thank you!" page, and open the address from a second browser. **You should see:** still "Thank you!" (no second email, no error). Only people with the unguessable link can see it.
- [ ] **G12 (must). Admin sees the order.** In admin open **Books & Orders** > orders (`/admin/orders`). **You should see:** the order, paid, with your name, items and total; the books are no longer in stock on the site.
- [ ] **G13 (must). Pickup.** Pretend to be the buyer at the shop: show the confirmation email; a volunteer finds the order in `/admin/orders` and hands over the books. **Known:** there is no "collected" button; an order stays "paid" and the staff hands over the books by hand. **TODO:** decide whether you want a "collected" status; none exists in the code today.
- [ ] **G14. 14-day rule.** Read the Terms of Sale, "Collecting your order": **You should see:** "Please collect within 14 days of payment; if you need longer, write to us." (and the French equivalent). **Known:** nothing in the software cancels a paid order after 14 days; it is a shop rule. What is automatic is a **held** book (request hold, exactly 7 days) which returns to the shelf by itself.

### 2B. Drop-in class seat (with waiver)

- [ ] **G15 (must).** Open `/sessions`, choose **Drop-ins Only**, press **Add to Cart** on a session with a price. **You should see:** the cart shows "Session" with "Drop-in seat · <date and time>" and the price.
- [ ] **G16 (must).** In the cart, look at the checkout form. **You should see:** an extra checkbox "I ask for the session(s) to take place on the date booked. I understand that once a session has taken place I can no longer withdraw from the purchase." The form will not submit until it is ticked.
- [ ] **G17.** Pay as in G6 to G8. **You should see:** "Thank you!" with the session line; the confirmation email says drop-in sessions need no pickup, "just come along at the session time".
- [ ] **G18.** Back on `/sessions`. **You should see:** one place fewer ("N places left"); a session with no places shows **Full**.
- [ ] **G19.** Admin: `/admin/sessions`, open the session. **You should see:** under "Paid drop-in" the buyer, no longer counted as free.
- [ ] **FR check.** The waiver reads "Je demande que la ou les séances aient lieu à la date réservée...".

### 2C. Abandoning a cart, hold expiry, retries

- [ ] **G20 (must). Abandon at payment.** Add a book, press **Pay & Buy**, then on the HelloAsso page use the back/cancel link (or close the tab). **You should see:** back on the cart (empty: the cart is cleared once payment starts) or the page "Payment not completed — Your payment didn't go through, so nothing was charged — any books are back in stock and any drop-in seats are open again for anyone else to buy."
- [ ] **G21.** Straight away try to buy again with the same email. **You should see:** either you can (the first order was cancelled), or "You already have unpaid orders waiting for payment. Please finish or wait for them to expire (about an hour) before starting another." The second message is the protection against hoarding.
- [ ] **G22 (must).** Wait for the hold to expire (about 70 minutes after G20 or G6 at the latest), then open the book page. **You should see:** the copy is for sale again and the order in admin shows expired/cancelled, not paid.
- [ ] **G23.** Someone else takes your book: add a book to the cart (do not pay), in the other browser buy that same copy, then in your cart press **Pay & Buy**. **You should see:** "Sorry, something in your cart was just taken by someone else. Please review your cart and try again." and the cart refreshed without that book.
- [ ] **G24.** Pay, then use the browser's back button until you reach the shop (see also E3). **You should see:** no error page and no duplicate order.

## Script 3. New member

Time: 35 to 45 minutes. Needs a mailbox. Preview mode does not matter except M13.

### 3A. Sign up, confirm, choose a password, log in

**NOTE (changing):** at the moment (after pull request #181) the sign-up form
still has a Password field, and the confirmation email link makes you choose
your real password. A follow-up change will remove the Password field from the
sign-up form. Where the two differ the step says so. The rest is the same.

- [ ] **M1 (must).** Open **Create an account** (`/signup`). **You should see:** a form with **Name**, **Email** (and, until the follow-up change, **Password** with a **Show** button and the rule "At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol.").
- [ ] **M2.** Enter a weak password (`abc`), submit. (Until the follow-up change only.) **You should see:** the browser or the site refuses: "Password must be at least 8 characters." or "Password must include ...". A known-breached password (for example `Password123!`) gives "That password has appeared in a known data breach. Please choose a different one."
- [ ] **M3 (must).** Enter name `Test Member One`, `YOU+member1@gmail.com` and (until the change) the test password `Test-Password-2026!`, press **Create account**. **You should see:** the same page with the message "Thanks! Check your inbox for an email with next steps: open its link to confirm your address and choose your password, then log in. If you already have an account, try logging in or resetting your password." You are **not** logged in.
- [ ] **M4 (must).** Before opening the email, try to log in with the address and the password from M3. **You should see:** "Please confirm your email first: open the link we sent you. You can request a new one below." and a button **Send me a new confirmation link**. Press it: "If that account is waiting for confirmation, we've sent a new link. Check your inbox." (at most one new link every 5 minutes).
- [ ] **M5 (must).** Open the email "Confirm your email for Uma's Books" and click the link. **You should see:** a page "Email confirmed: now choose your password": "Thank you! To keep your account safe, please pick your password now. It replaces the one entered when the account was created." **Known:** the link is good for 24 hours and works once; reopening it shows the login page with "That confirmation link is invalid or has expired."
- [ ] **M6 (must).** Choose a password (twice if asked) and press **Set password**. **You should see:** the Log in page with "Password saved — your email is confirmed. Log in to get started."
- [ ] **M7 (must).** Log in with the new password. **You should see:** you land on the home page (a plain account that is not yet a member) and the person icon at the top right is now the **Log Out** button. **Known:** a logged-in account that is not a member cannot open the Member's Access area; the key icon sends you to the home page.
- [ ] **M8 (must). Same address again.** Log out; sign up again with the same email. **You should see:** exactly the same "Thanks! Check your inbox" message (the site never reveals whether an address is registered), and the real owner receives "Someone tried to sign up with your email at Uma's Books" with links to log in or reset.
- [ ] **FR check (sign-up).** Switch to **FR** before M1 and redo with `YOU+member2@gmail.com`. **You should see:** "Créer votre compte", "Nom", "E-mail", "Mot de passe", **Créer mon compte**, the notice "Merci ! Consultez votre boîte de réception...", and the email "Confirmez votre adresse e-mail pour Uma's Books" in French. After setting the password: "Mot de passe enregistré : votre adresse e-mail est confirmée. Connectez-vous pour commencer."

### 3B. Wrong password, lockout, forgot and reset

- [ ] **M9 (must).** Log in with the right email and a wrong password. **You should see:** "Incorrect email or password." (same message for an unknown email).
- [ ] **M10 (must).** Do it 5 times in a row. Then log in with the **right** password. **You should see:** still "Incorrect email or password." (the account is locked for 15 minutes and the site does not say so). After 15 minutes the right password works. Use a throwaway account only, and note the time.
- [ ] **M11 (must). Forgot password.** Press **Forgot your password?** Enter the address, press **Send reset link**. **You should see:** "If an account exists for that email, we've sent a password reset link." (also for an address that has no account). Open "Reset your Uma's Books members password" (FR: "Réinitialisez votre mot de passe membre Uma's Books"), click the link (valid 1 hour, once): "Set a new password"; set one; **You should see:** "Password updated — log in with your new password." The old password no longer works.
- [ ] **M12.** Click the same reset link again. **You should see:** the page says the link is not valid with a **Request a new reset link** button.

### 3C. Membership (payment)

- [ ] **M13 (must). Pay for membership.** Preview **off**, HelloAsso in test mode: open `/membership.html` while logged in, fill the HelloAsso form in the page with **the same email as your account**, and pay. **TODO:** this form belongs to HelloAsso and points at the real organisation page, so a test payment would be real, and the sandbox form is unknown (see "Before you start"). Until confirmed, test everything below by having an admin press **Mark as Member** on the account (script 5, A24) and do the real payment test once at launch with a small amount, refunding it afterwards. If a payment is made: **You should see:** within a few minutes the key icon opens **Member's Access** ("Welcome back, <name>") and in admin **Members** the account shows with its membership dates (one year from the payment). **Known:** the account's email must be confirmed first, or the payment is not matched.
- [ ] **M14.** Read **Membership Terms** from the membership page. **You should see:** the terms (see V39/V40).
- [ ] **M15 (must).** With the account now a member, open the key icon. **You should see:** "Member's Access" with Announcements, "Charity We Support", Community Forum, Meetings Calendar, Volunteer Sign Up (that one only works for volunteers) and "Change Password".

### 3D. Account, orders, favorites

- [ ] **M16 (must).** Open the receipt icon (`/account`). **You should see:** "My Account", an Orders list (after the guest purchase in script 2 with the same email, and a confirmed email: that order, with status Paid), links "Two-step verification" and "Privacy: download or delete my data", and "My book requests". Before the email is confirmed you see "Confirm your email address to see your orders here".
- [ ] **M17.** In "My book requests" press **Cancel this request** on one, and **Ask for another book**. **You should see:** the request disappears (contact details deleted); the request form opens.
- [ ] **M18.** Member's Access > **Change Password**: enter the current and a new password. **You should see:** a confirmation; log in again with the new one. A wrong current password is refused, and 5 wrong attempts in 15 minutes block more tries.
- [ ] **M19.** Heart a book; log out and in again; open `/favorites`. **Known:** favorites are saved in this browser, not on the account; they are still there in the same browser and absent in another.

### 3E. Forum, charity vote, meetings

These need the account to be a member (see M13).

- [ ] **M20 (must). Forum post.** Open **Go to Forum** (`/forum`), **Start a thread**, give a Title and Message, **Post**. **You should see:** the thread, your first name or "Member", the date. The list shows "1 reply" / "N replies".
- [ ] **M21.** Open a thread, write a reply in "Add a reply", press **Reply**. **You should see:** the reply under "Replies".
- [ ] **M22 (must). Report.** Press **Report** on a post, pick a reason (Illegal content, Harassment, Spam, Other), add a comment, **Send report**. **You should see:** "Thanks, we will review it." and the shop mailbox (the contact address, normally `admin@umasbooks.org`) gets "Forum report: <reason> (thread/reply <id>)".
- [ ] **M23.** Log out and open `/forum`. **You should see:** the Log in page. A logged-in non-member is sent to the home page.
- [ ] **M24 (must). Charity vote.** Open **Vote Now** (`/charity`). **You should see:** the open vote question, the charities with votes, "You can select multiple charities." if allowed, and **Submit My Votes**. Vote; **You should see:** your vote counted ("1 vote"). Voting twice for the same option is not possible. When no vote is open: "No vote is open right now."
- [ ] **M25.** In "Suggest a Charity" send an idea (name, category, why, website) with **Submit Idea**. **You should see:** it appears under "Your submitted ideas" as "Pending review"; after admin approval "Approved" (or "Not selected").
- [ ] **M26. RSVP.** Open **View Calendar** (`/meetings`). Press **I'll be there** on a meeting. **You should see:** "N going" goes up and the button becomes **Cancel RSVP**; press it: the count goes back. "Past meetings & minutes" lists old ones, with "Minutes not posted yet." when empty.
- [ ] **M27.** Open the Events page logged in and sign up for an event. **You should see:** the same as V23.
- [ ] **FR check (member area).** Switch to FR on the dashboard, forum, charity page, meetings and account. **You should see:** "Espace membres", "Bienvenue" (welcome), "Annonces", "Signaler", "Envoyer le signalement", "Voter", "Je serai là" (or similar). Note any English left over.

### 3F. Privacy page: download, delete

- [ ] **M28 (must). Download my data.** Open "Privacy: download or delete my data" (`/account/privacy`). If the email is not confirmed you see "Confirm your email address first" and **Resend the confirmation email**. Otherwise press **Download my data**. **You should see:** a file `umasbooks-my-data.json` downloads, and opening it shows your name, email, orders, requests, forum posts.
- [ ] **M29 (must). Delete my account.** **Use a throwaway account only (not the one needed for later steps).** Enter your **Current password**, type `DELETE` (in French `SUPPRIMER`) in the confirmation box, press **Delete my account for good**. **You should see:** the page "Account deleted" / "Your account has been deleted" with **Go home**, you are logged out, the old password no longer works, and an email "Your Uma's Books account has been deleted" (French: "Votre compte Uma's Books a été supprimé") arrives. A wrong password gives "Current password is incorrect."; anything other than the word gives "Type DELETE in the confirmation box to delete your account."
- [ ] **M30.** Admin: `/admin/members` search for that address. **You should see:** no account. **Known:** an admin cannot delete their own account here ("Administrators can't delete their own account here: ask another administrator."), and the last admin cannot be deleted.

### 3G. Language saved, emails in chosen language

- [ ] **M31 (must).** Log in with the site in **FR**, log out, switch to **EN**, log in again, switch to **FR**, log out. Then use **Forgot your password?** with the site in **FR**. **You should see:** the reset email in French. Repeat in EN: English. **Known:** the account's saved language is updated at each login if you chose a language on the site.
- [ ] **M32.** Place an order (script 2) or request a book while logged in with the site in French. **You should see:** the emails in French.

## Script 4. Volunteer

An admin marks a throwaway **confirmed** account as volunteer (script 5, A24).
Time: 15 to 20 minutes.

- [ ] **VO1 (must).** As a plain member (not volunteer) open `/volunteer`. **You should see:** you are sent to the home page (the shifts calendar is for volunteers and admins only).
- [ ] **VO2.** Log in as the volunteer, open Member's Access > **Sign Up to Volunteer** (`/volunteer`). **You should see:** "Volunteer Shifts" with the intro "Sign up for a shift below...", a Month/Week calendar with **Prev / Next**, shifts showing "0/1 filled" (or "N/max filled"), **Sign up**; a shift already taken shows **Full**.
- [ ] **VO3 (must).** Press **Sign up** on a shift. **You should see:** the shift under **My upcoming shifts**, and "1/1 filled".
- [ ] **VO4.** Someone else (another volunteer account) opens the same shift. **You should see:** **Full**; no sign-up button.
- [ ] **VO5 (must).** Press **Cancel** on your shift. **You should see:** it leaves "My upcoming shifts" and the shift is free again for the other volunteer.
- [ ] **VO6.** Volunteers can also use the forum, charity vote and meetings (script 3E). **You should see:** all of them open.
- [ ] **VO7.** Admin: `/admin/volunteer-shifts`. **You should see:** the shift with "1 / 1 filled" while signed up, and the volunteer's name when you click it.
- [ ] **FR check.** Switch to FR. **You should see:** "Créneaux de bénévolat" (or similar), "S'inscrire", "Annuler", "Complet", "Mes prochains créneaux".

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

- [ ] **A6.** Open the **Dashboard**. **You should see:** figures (Orders Today, This Month, Total Sales, In-Stock Books, Added This Month, Total Accounts, Members) and tiles: Books & Orders, English Programs, Bookstore Events, Account Section, Members, Volunteer Shifts, Meetings, Announcements, Charities, Blog; in preview mode a red strip "PREVIEW MODE is ON".
- [ ] **A7.** Open every item of the left menu once: Dashboard, Books & Orders, Awards to review, Book Requests, English Programs, Events, Volunteer Shifts, Meetings, Announcements, Accounts, Members, Charities, Blog, Reports, Pricing rules, Admin activity. **You should see:** each opens in English, no error.
- [ ] **A8.** Press **FR** (public pages) then return to an admin page. **You should see:** admin stays English; the public site is French.

### 5C. Add books: scan, manual, photo

- [ ] **A9 (must). ISBN entry.** **Books & Orders** > **Scan a book**. Set **Current location** (for example `Shelf A`) and **Source of these books** (Donation). Type `9780141036144` in **ISBN**, press **Look up**. **You should see:** a form already filled with the title, author, cover, publisher, year, binding, genres and a description (written automatically, English and French, when the AI key is set; otherwise empty), and the **This copy** section.
- [ ] **A10 (must). Condition, binding, price.** Choose **Condition** (New / Like New / Very Good / Acceptable) and **Binding** (Hardcover / Paperback / Mass Market), look at the **Price** choice: radio buttons **Clearance EUR 1.00**, **EUR 3.00**, **EUR 5.00**, **EUR 8.00**, **EUR 10.00**, **Custom...**, with **Suggested** tag on one and a **Suggest price** button and **Why this price?**. Press **Save book**. **You should see:** "Book saved — ready for the next one." and the book in the list with its copy.
- [ ] **A11 (must). Price suggestion rules** (default rules; check **Pricing rules** if someone changed them). Add `9780451524935` (mass market): **You should see:** suggested EUR 5.00 and the reason in **Why this price?**. Add a hardcover: never suggested under EUR 10.00. Add a book with no ISBN: **no price suggested** ("a person looks it up"). Add three copies of `9780743273565` one after the other: the **third** copy is suggested **Clearance EUR 1.00** (clearance starts when 2 copies are already in stock or reserved, for the "A" rule and mass-market books only), and if the shop is set to "All its copies" a box offers "Also reprice the other N copies". **Known:** the condition of the copy never changes the price.
- [ ] **A12 (must). New book at publisher's price (loi Lang, 5%).** Add `9780747532743` with condition **New**. **You should see:** a field **Publisher's price (prix éditeur) (€)**, required only for New. Leave it empty and save: "New books need the publisher's price (prix éditeur): French law requires them to be sold at that price." Enter 12.00, leave Price empty: the price becomes 12.00. Enter Price 11.00 (more than 5% off): **You should see:** "A new book must be sold at the publisher's price (€12.00), with at most 5% off: the price must be between €11.40 and €12.00." Enter 11.40 (exactly 5% off): saved. A New book is never put on clearance.
- [ ] **A13. Photo scan.** On **Scan a book** use **Take or Choose Photo** with a photo of a cover or barcode. **You should see:** the book looked up and the form filled in. If you see "Photo scanning isn't set up yet (needs an ANTHROPIC_API_KEY)", the key is missing: use ISBN or **Add manually**. **TODO:** confirm with the developer whether the key is set on the live service.
- [ ] **A14. Add manually.** **Add manually** (`/admin/inventory/new`): fill Title, Author, ISBN (optional), Genres, Description, **Generate description**, upload a cover photo ("A photo overrides the URL above"). **You should see:** the book saved; no cover found shows "No cover found — Take or Upload a Photo". An empty title: "Title is required."
- [ ] **A14a. Bad numbers are refused.** In a copy's price, acquisition cost, or a book's published year type `-5`, `abc`, `12.345`, `99999`. **You should see:** a clear English error each time, nothing saved, and what you typed still in the form. In a session, a drop-in price of 0 or a capacity of 0 or 5000 is refused (**NOTE (changing):** these checks come from pull request #187).
- [ ] **A14b. Edit and delete.** Open a book: **Edit details** > change author > **Save changes**; per copy **Save copy**, **Delete 1 copy**; **Delete this book** (ask first, it cannot be undone). **You should see:** each change saved; the public page updates.

### 5D. Awards, locations, sources, selling in shop

- [ ] **A15 (must). Awards.** Open a book > **Awards & lists**: type `Booker Prize (2019)` in **Add awards (comma separated)** and press **Add**. **You should see:** it shows on the public book page at once under "Awards & lists:". **Remove** it: gone. **Re-check now** looks again online. In **Awards to review** (menu) each suggestion has **Open source**, **Approve**, **Reject**; **Approve selected** does several at once. Only verified or approved lines appear to customers. **You should see:** an entry in **Admin activity** for each action.
- [ ] **A16 (must). Locations and Move books.** Open **Move books** (`/admin/inventory/move`): choose or type a new place ("Move books to"), scan or type an ISBN, press **Move**. **You should see:** "N moved so far" and the new place offered in lists. On **Books & Orders** use the **Location** filter and see the copy there.
- [ ] **A17. Copy source.** Check a copy's **Source** (Donation / Purchase / Job lot / Other / Unknown) on the book page and in the **Inventory on hand** report. **You should see:** it saved.
- [ ] **A18 (must). Sell in shop.** **Sell in shop** (`/admin/inventory/sell`): type an ISBN, **Find the book**, check the price, choose **Paid by**, press **Record sale**. **You should see:** "Last sales in the shop" lists it; the copy is sold and disappears from the public site. A New book below 95% of the publisher's price is refused. **Known:** online orders are not recorded here; they are in `/admin/orders`.

### 5E. Reports and CSV

- [ ] **A19 (must). Reports.** Open **Reports**. **You should see:** six: **Inventory on hand**, **Aging stock**, **Sales over time**, **Sell-through by genre**, **Membership**, **Intake log**. Open each: it shows tables; with **From / To / Group by** and **Show** where available ("Paris days. Without dates, the last 12 months are shown.").
- [ ] **A20 (must). CSV.** On each report press **Download CSV** for at least one table. **You should see:** a file `umas-books-<report>-<table>.csv` that opens in a spreadsheet with the same numbers, and **no buyer names**. Each download is logged in **Admin activity** ("report.csv").
- [ ] **A21.** Sales report after G8, G17 and A18. **You should see:** the online sale, the shop sale, and the drop-in seat counted separately.

### 5F. Book requests

- [ ] **A22 (must). Matching on intake.** Make sure a confirmed request for `9780141439518` exists (V31 to V33). **Add** that book to stock (A9). **You should see:** on the scan page "1 customer asked for this book" (or on the book page), and under **Book Requests** the request moved to **Matched (a copy is in the shop)**.
- [ ] **A23 (must). Notify and hold.** In **Book Requests** (`/admin/requests`; filters Active, Open, Matched, Notified, Waiting for email confirmation, Fulfilled, Cancelled, Expired, All) press **Notify**: "Email sent." The requester receives the "Good news" email (V38). Press **Notify and hold 7 days**: "Email sent and the copy is held for 7 days." and the copy shows as Reserved on the book page ("Cancel reservation & return to stock" frees it). Then **Mark fulfilled**: "Marked as fulfilled." Also try **Match to a book** with a book id or ISBN, **Save note**, **Cancel** ("Request cancelled and the requester's contact details removed.") and **Delete**.
- [ ] **A23b.** A hold ends by itself after its time (7 days for a request hold) and the copy goes back on sale. **Known:** not practical to wait for it in a test; check on a real hold during the first weeks. **TODO:** the public "reserve a book" button is being removed (pull request #183); after it is merged there is no way for a customer to reserve without an admin.

### 5G. Orders

- [ ] **A24a (must).** `/admin/orders` after script 2. **You should see:** each order with name, email, items, total, status (pending, paid, cancelled, expired). A pending order for an abandoned payment becomes expired/cancelled after the hold (G22).

### 5H. Members and roles

- [ ] **A24 (must). Create, roles.** **Accounts** > **+ Add Member** (Name, Email, optional **Mark as a member**, **Mark as a volunteer**, **Make an admin**) > **Add & Send Invite**. Open an account (**View**): **Mark as Member** / **Remove Member Status**, **Mark as Volunteer**, **Make Admin** / **Remove Admin**. **You should see:** the status changes at once; the person's open session loses or gains access soon after.
- [ ] **A25 (must). Disable.** **Deactivate Account** on a throwaway account. **You should see:** that person (with the right password) sees "This account has been deactivated. Contact us if you think this is a mistake."; **Reactivate Account** restores it.
- [ ] **A26.** Demote the second admin (**Remove Admin**). **You should see:** they lose admin pages. You cannot demote yourself, and the last admin cannot be demoted or erased.
- [ ] **A27.** **Edit** tab: change the Name and Email of a throwaway account. **You should see:** saved; an email already used is refused ("That email is already used by another account — nothing was changed."); a changed email needs a new confirmation.
- [ ] **A28.** **Download data (JSON)** on an account. **You should see:** a JSON file. **Erase Member** on a throwaway account (cannot be undone). **You should see:** the account is gone (like M29).
- [ ] **A29.** **Members** menu (`/admin/members?role=member`) and filters (All Roles, Admin, Member; All Statuses; date ranges; sort). **You should see:** only paying members; **Clear Filters** resets.

### 5I. Events, English programs, meetings, shifts

- [ ] **A30 (must). Events.** **Events** (`/admin/events`): click a day or **+ Add event**: Title, Start time, End time, Location, Capacity, Price. **You should see:** it appears on the public `/events` page. Sign up as a visitor (V23): admin sees the person under "Signed up" with **Remove**. **Edit** changes the event; **Delete event** removes it. A full event (capacity reached) shows **Full** publicly.
- [ ] **A31 (must). English Programs / sessions.** **English Programs** (`/admin/sessions`): **+ Add session**: Title, Program type, Start time, End time, Location, Capacity, **Drop-in price**. **You should see:** it appears on `/sessions` (with a price it can be bought as a drop-in, G15). Paid drop-in buyers show under "Paid drop-in"; free legacy sign-ups under "Signed up (free, legacy)".
- [ ] **A32. Meetings.** **Meetings**: **+ Add meeting**: Title, Time, Location, Agenda; after the meeting add **Minutes** > **Save minutes**; **Delete meeting**. **You should see:** members see it on `/meetings` with "N going" (M26) and the minutes under "Past meetings & minutes".
- [ ] **A33. Volunteer Shifts.** **Volunteer Shifts**: **+ Add shift**: Role, Start time, End time, **Repeat weekly, this many times (including this one)**, Notes. **You should see:** one shift per week; "N / 1 filled"; **Delete** removes it.

### 5J. Announcements, blog, charity

- [ ] **A34 (must). Announcements.** **Announcements**: create with Title, Excerpt, Content, category, status (Publish Now, Draft, Scheduled), **Pin**. Filter tabs All / Published / Scheduled / Drafts / Archived / Trash; bulk **Publish / Archive / Move to Trash**; **Restore**; **Delete Permanently** (ask first). **You should see:** a published announcement on the members' dashboard ("View All Announcements"), a draft or scheduled one not; pinned ones first.
- [ ] **A35 (must). Blog.** **Blog**: Title, Content, Excerpt, Publish Date, Status (Draft / Scheduled / Published), Featured Image (JPG or PNG, max 5 MB), Category, Tags, **Preview**. **You should see:** a published post on `/blog.html`, a draft not; bulk **Publish / Move to Draft / Delete**.
- [ ] **A36 (must). Charity.** **Charities** > **Start a New Vote**: Question, Label, Voting ends, **Allow multiple selections**, **Show results while voting is open**, **Visible to** (Members Only / Everyone), **Start Vote**. Add charities (**From the library** or **Or create a new charity** > **Add & Include in Vote**). **You should see:** members can vote (M24); results show votes and percent; **Edit Vote Settings**, **Remove from Vote**, **Close Vote** (it moves to "Past Votes"). **Submitted Ideas** tab: approve or reject (M25).

### 5K. Forum moderation

- [ ] **A37 (must). Hide with a statement of reasons.** As admin on a forum thread or reply press **Hide this post**: pick a **Reason (sent to the author)** (Illegal content, Harassment, Spam, Other), add a **Note to the author**, confirm. **You should see:** the post now says "This post was removed by the moderators." to members and the admin sees "Hidden:" with **Restore**. The author receives "A post of yours was removed from the Uma's Books forum" with the reason (and the way to contest). Hiding it twice does not send a second email. **Restore** puts it back.

### 5L. Audit log, pricing settings, price stickers

- [ ] **A38 (must). Admin activity.** **Admin activity** (`/admin/audit`). **You should see:** a table When / Admin / Action / Target / Detail with recent actions (logins, book changes, sales, CSV downloads, hides, role changes). Nothing sensitive (no post text, no passwords).
- [ ] **A39 (must). Pricing rules.** **Pricing rules** (`/admin/pricing`): read the rules; change **Clearance price (EUR)** to 2, **Save pricing rules**; add a copy; **You should see:** the new clearance price offered. Set it back to 1. **Try it** (calculator) shows the price that would be suggested for an online value, a binding and a number of copies already in stock. **Price check** (`/admin/pricing/review`): "Needs review", "Priced differently from the suggestion" with **Use suggested**, and "Clearance candidates" with **Apply clearance to these copies** (preview: nothing changes until you confirm).
- [ ] **A40. Price sticker colors.** **Coming.** The page for price sticker colors is not on the site yet. When it is merged, add steps here: open the page from the admin menu, change a colour, check that the price labels follow it.
- [ ] **A41. Online price check (optional).** If `PRICING_AI` is on, adding a book also fetches an online market value ("Why this price?" lists "Listings found"). It is off by default (runbook section h): then suggestions use the built-in rules only and that is normal.

## Script 6. Edge and negative tests (everyone)

- [ ] **E1 (must). Expired session, then submit.** Open the contact form (`/contact`) or the login page. In your browser delete this site's cookies (Settings > Privacy > cookies for this site), then press the form's send button. **You should see:** a plain page "Your session expired or this form is out of date. Please go back and try again." (English only: **Known**, plain text page). Go back, reload the page, try again: it works.
- [ ] **E2 (must). Double-click on pay.** In the cart double-click **Pay & Buy** fast. **You should see:** one HelloAsso page, and in **Admin > orders** only **one** new pending order (not two). No duplicate email later.
- [ ] **E3 (must). Back button after payment.** After the "Thank you!" page press the browser back button three times, then forward. **You should see:** no error page; the cart is empty; no new order in admin; pressing **Pay & Buy** again on an old page does not create a second charge. Reload the "Thank you!" page: still the same, no second email.
- [ ] **E4.** Press the HelloAsso page's back link before paying. **You should see:** you return to the cart (empty) and the books are held until the hold expires (G7, G22).
- [ ] **E5 (must). Mobile layout (375 px).** On a phone, or in the desktop browser with the window made narrow (Chrome: View > Developer > Developer Tools > the phone icon > width 375), open: the home page, a **book page** (the **Condition / Price / Add to Cart** table must be readable, with no sideways scrolling and the buttons large enough to tap), the **cart**, the **checkout form** (fields and the terms checkbox usable, **Pay & Buy** reachable), the **menu**. **You should see:** nothing cut off, no text on top of other text, no horizontal scroll. Check in EN and FR (French words are longer).
- [ ] **E6.** Back in preview mode, mobile: the "Preview" banner does not cover the menu or the cart button.
- [ ] **E7.** Log in on two browsers at once, change the password in one. **You should see:** the other browser is logged out the next time you do something.
- [ ] **E8.** As a normal logged-in member open `/admin`. **You should see:** "Admins only." Not logged in: the login page.
- [ ] **E9.** Type a very long text (5000+ characters) in the contact form, and 300 characters in a book request title. **You should see:** a clear message (for the book request: "Something you typed is too long. Titles can have up to 200 characters and notes up to 500."), no crash.
- [ ] **E10.** Visit the site with the browser language set to French and no choice made. **You should see:** the site in French on the first visit.

## Reset after testing

- **Test accounts and orders:** delete throwaway accounts from **Accounts** > the person > **Erase Member**; cancel your own open book requests (**My book requests**).
- **Test books, orders, forum posts, sample data:** **TODO.** There is no clearing script or written procedure yet. The runbook launch checklist (section g, item "Sample and test data removed") says so itself: "a placeholder to agree on a procedure before launch". Until it exists, ask the developer to clear test data before launch, and do not launch with test orders or test accounts in the shop.
- **Preview mode:** put `PREVIEW_MODE` back on (runbook section g, "Turning it on again") whenever the site holds test data again, and at launch the runbook checklist says `HELLOASSO_API_BASE` must be unset or the production address, **not** the sandbox one, so switch it back (and the HelloAsso keys to the live ones) only when you are ready to launch.
- **Emails:** delete the test emails from the shop mailbox.

## Results

Copy this table for each full run.

| Date | Tester | Script (1 to 6) | Pass / fail | Failed step numbers and notes |
|---|---|---|---|---|
| | | 1 Visitor | | |
| | | 2 Guest buyer | | |
| | | 3 New member | | |
| | | 4 Volunteer | | |
| | | 5 Admin | | |
| | | 6 Edge cases | | |
