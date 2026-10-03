# Processors checklist / Liste des sous-traitants

Under the GDPR (article 28), every company that handles personal data **for us** must be bound by a data processing agreement (DPA, "accord de traitement des données"). Most big providers offer a ready-made DPA that you accept online. This file lists each provider, what data it gets, and what to do.

Rules used here: a step is only written out when we are confident of it. Otherwise it says "look for the DPA on the provider's legal page", because websites and menus change. If a menu name below does not match what you see, search the provider's help for "data processing agreement" rather than guessing.

Keep a copy (PDF or screenshot with the date) of each accepted DPA in the association's shared drive.

---

## FIRST ITEM: is the mailbox a Google Workspace account?

The website sends and receives email through the Gmail account named in the setting `GMAIL_USER` (a Render environment variable, see `umas-books/README.md`). Google's DPA only covers **Google Workspace** (paid or non-profit edition), **not** a personal `@gmail.com` account.

- [ ] Find the value of `GMAIL_USER` (Render dashboard > the `umas-books` service > Environment).
- [ ] If it ends in `@umasbooks.org` (or another association domain) and you can log in to **admin.google.com**: it is Workspace. Go to the Google section below.
- [ ] If it is a personal `@gmail.com` address: **no DPA exists for it.** Move the sending mailbox to a Workspace account (Google for Nonprofits offers Workspace free to eligible associations) and change `GMAIL_USER` and `GMAIL_APP_PASSWORD` in Render. Until then, note this risk in the register (`record-of-processing.md`, section 6).

Result: ______________________  Date: ____ / ____ / ______  Done by: ____________

---

## Google Workspace (Gmail)

- **What they get:** every email the site sends or receives: names, email addresses, phone numbers and message text from the contact form, order and reservation confirmations, reminders, password-reset and verification emails, and error alerts. Also the content of the inbox itself.
- **Role:** processor (for Workspace).
- **Action for Sharon:** sign in to the Google Admin console (admin.google.com) as a super administrator and go to Account > Account settings > Legal and compliance, then accept the **Data Processing Amendment** (the exact wording of the menu may change slightly). Choose the option that applies to the association's contact for data protection (admin@umasbooks.org).
- Also check in the same console that 2-step verification is required for all users.

Date accepted: ____ / ____ / ______ / Done by: ____________

## Render (hosting and database)

- **What they get:** the whole website and its database: all accounts, orders, sign-ups, reservations, forum posts and so on; plus server logs. Region: Frankfurt (EU), per `render.yaml`.
- **Role:** processor.
- **Action for Sharon:** look for the Data Processing Addendum (DPA) on Render's legal page (render.com, footer "Legal" or "Trust"/"Security" area). Follow the instructions there to accept or request it (some providers apply it automatically once you accept the Terms; the page says which). Keep a copy.
- Also write the log retention shown in the dashboard into `record-of-processing.md` (section 8).

Date accepted: ____ / ____ / ______ / Done by: ____________

## GitHub (code and nightly database backup)

- **What they get:** the code (no personal data) and, in the private branch `db-backups`, a full database dump every night: all personal data. This is the most sensitive item here: the repository must stay **private**. (The backup job refuses to run on a public repository.)
- **Role:** processor.
- **Action for Sharon:** look for the GitHub Data Protection Agreement on GitHub's legal page (docs.github.com, "Site policy" > "GitHub Customer Agreement" and its Data Protection Agreement). Follow the page to accept it for the account or organisation that owns the repository `umasbooksadmin`. If the page says it is part of the terms already accepted, note that and keep a copy.
- Also decide whether to stop the GitHub copy of the backups once Backblaze is trusted, because old dumps stay in Git history (see `record-of-processing.md`, section 9).

Date accepted: ____ / ____ / ______ / Done by: ____________

## Backblaze B2 (offsite backup)

- **What they get:** the same nightly database dump (all personal data), in a private, encrypted bucket.
- **Role:** processor.
- **Action for Sharon:** look for the Backblaze Data Processing Addendum (DPA) on Backblaze's legal page (backblaze.com, footer "Legal"). Follow the instructions there to sign or accept it for the account. Also confirm in the B2 console: bucket is **private**, default encryption is **on**, the bucket is in an **EU region**, and the lifecycle rules from `umas-books/README.md` (30 days / 730 days) exist.

Date accepted: ____ / ____ / ______ / Done by: ____________

## HelloAsso (payments and memberships)

- **What they get:** for each online payment, the buyer's first name, last name and email (sent by the website when it creates the payment page), then card or bank details entered directly on HelloAsso's page (we never see these). For memberships, whatever the member types into HelloAsso's form. The website receives back: order number, payer email, amount and date.
- **Role:** HelloAsso is a French payment institution/platform for associations and acts as an **independent controller** for the payment data (our privacy policy says so). It collects the payment data for its own purposes (payment, its own legal duties). That is usually why a DPA is not signed with it.
- **Action for Sharon:** read HelloAsso's privacy / legal pages ("Politique de confidentialité" and its terms for organisations) and confirm they describe themselves as controller for payment data. If they say they act as a processor for the association's membership data, look for their DPA there. Write down what you found below.
- Make sure the HelloAsso account's own users (who can see member lists) are only people who need to.

What I found: ____________________________
Date checked: ____ / ____ / ______ / Done by: ____________

## Anthropic API (book cover scans and book descriptions)

- **What they get (checked in `src/lib/coverVision.js` and `src/lib/bookDescription.js`):**
  - Cover scan: the **photo of a book cover or barcode** an admin uploads in the inventory screen, plus a fixed instruction asking for ISBN, title and author.
  - Description: only book facts (title, author, publisher, year) and a fixed instruction; the French translation sends only the English description text.
  - **No member, buyer, email, name or order data is ever sent.** Only admins can trigger it, and the call is skipped if the key is missing.
- **Role:** none for personal data, as long as the rule below is followed.
- **Rule for volunteers:** photograph only the book (cover or barcode), never people or documents. If a person's face or a written name ends up in a photo, retake it.
- **Action for Sharon:** none required for the DPA while no personal data is sent. If this ever changes, look for the DPA on Anthropic's legal page (anthropic.com/legal) before it does.

Date checked: ____ / ____ / ______ / Done by: ____________

## Open Library (book data)

- **What they get:** an ISBN or a title/author search when an admin adds a book (`src/lib/bookLookup.js`), and the cover image is fetched from their server. No personal data. Their server will see the Render server's IP address, not a person's.
- **Action for Sharon:** none (no personal data). 

Date checked: ____ / ____ / ______ / Done by: ____________

## Have I Been Pwned: Pwned Passwords range API (password check)

- **What they get (checked in `src/lib/passwordPolicy.js`):** only the **first 5 characters of the SHA-1 hash** of a new password, with the "Add-Padding" option. Never the email, never the full password. The site's server (not the visitor's browser) makes the request.
- **Action for Sharon:** none (no personal data is sent, so no DPA is needed). 

Date checked: ____ / ____ / ______ / Done by: ____________

---

## Also worth knowing (not processors in the list above)

- **Google Fonts:** the website's pages load typefaces from Google, which receives the visitor's IP address. Disclosed in the privacy policy. Hosting the fonts ourselves would remove this.
- **Squarespace** was retired (see root `README.md`); if the old account still exists, close it or delete its personal data.
