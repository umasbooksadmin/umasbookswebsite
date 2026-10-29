# Processors checklist / Liste des sous-traitants

Under the GDPR (article 28), every company that handles personal data **for us** must be bound by a data processing agreement (DPA, "accord de traitement des données"). Most big providers offer a ready-made DPA that you accept online. This file lists each provider, what data it gets, and what to do.

Rules used here: a step is only written out when we are confident of it. Otherwise it says "look for the DPA on the provider's legal page", because websites and menus change. If a menu name below does not match what you see, search the provider's help for "data processing agreement" rather than guessing.

Keep a copy (PDF or screenshot with the date) of each accepted DPA in the association's shared drive.

## Status and where to accept each DPA / État d'avancement

Tick the box and write the date when the agreement is accepted (or, for HelloAsso and Anthropic, when the check is done). "Click path" is where the vendor offers its agreement as far as we know; vendors rename menus, so where it says **check on the vendor's site**, search the vendor's legal or privacy page for "data processing agreement" instead of trusting the path. Keep a dated PDF or screenshot in the shared drive.

| Vendor | What it is for | Click path to the DPA | Status |
|---|---|---|---|
| Google (Workspace / Gmail) | Mailbox: all site emails | Google Admin console (admin.google.com) > Account > Account settings > Legal and compliance > Data Processing Amendment. Needs a Workspace account (see the first item below). | [ ] accepted on ____ / ____ / ______ |
| Render | Hosting and database | Render dashboard > Account/Workspace Settings, then the Legal / DPA page (render.com, footer "Legal"). **Check on the vendor's site** for the exact menu. | [ ] accepted on ____ / ____ / ______ |
| Backblaze | Offsite backup (B2 bucket) | Backblaze account > Account > Legal (or backblaze.com footer "Legal" > Data Processing Addendum). **Check on the vendor's site.** | [ ] accepted on ____ / ____ / ______ |
| GitHub | Runs the nightly backup job; the dump passes through it briefly | GitHub > Settings > (the organisation `umasbooksadmin`, or the personal account that owns it) > Data Protection Addendum, or docs.github.com "Site policy" > "GitHub Data Protection Agreement". Also confirm the DPF/SCC wording. **Check on the vendor's site.** | [ ] accepted on ____ / ____ / ______ |
| Squarespace | Domain name and DNS (owner's details only) | squarespace.com footer "Legal" > Data Processing Addendum. **Check on the vendor's site.** | [ ] checked on ____ / ____ / ______ |
| HelloAsso | Payments and memberships (independent controller) | HelloAsso legal documents (helloasso.com, footer "Mentions légales" / "Politique de confidentialité", and the organisation terms): confirm it acts as controller; no DPA is usually signed. **Check on the vendor's site.** | [ ] checked on ____ / ____ / ______ |
| Anthropic | Book-cover and book-fact lookups (no personal data) | Anthropic privacy centre (privacy.anthropic.com) and anthropic.com/legal: DPA only needed if personal data is ever sent. **Check on the vendor's site.** | [ ] checked on ____ / ____ / ______ |
| Cloudflare (Render's edge network) | Sees visitors' IP addresses in front of Render | Nothing to sign on our side: it is a sub-processor of Render. In Render's DPA, check the sub-processor list names Cloudflare. Cloudflare's own DPA is at cloudflare.com/cloudflare-customer-dpa. | [ ] checked on ____ / ____ / ______ |

---

## FIRST ITEM: is the mailbox a Google Workspace account?

The website sends and receives email through the Gmail account named in the setting `GMAIL_USER` (a Render environment variable, see `umas-books/README.md`). Google's DPA only covers **Google Workspace** (paid or non-profit edition), **not** a personal `@gmail.com` account.

- [ ] Find the value of `GMAIL_USER` (Render dashboard > the `umas-books` service > Environment).
- [ ] If it ends in `@umasbooks.org` (or another association domain) and you can log in to **admin.google.com**: it is Workspace. Go to the Google section below.
- [ ] If it is a personal `@gmail.com` address: **no DPA exists for it.** Move the sending mailbox to a Workspace account (Google for Nonprofits offers Workspace free to eligible associations) and change `GMAIL_USER` and `GMAIL_APP_PASSWORD` in Render. Until then, note this risk in the register (`record-of-processing.md`, section 6).

Result: ______________________  Date: ____ / ____ / ______  Done by: ____________

---

## Google Workspace (Gmail)

- **What they get:** every email the site sends or receives: names, email addresses, phone numbers and message text from the contact, volunteer sign-up and pre-registration forms (including a child's name and year of birth, given by a parent or guardian), order and reservation confirmations, reminders, password-reset and verification emails, and error alerts. Also the content of the inbox itself.
- **Role:** processor (for Workspace).
- **Action for Sharon:** sign in to the Google Admin console (admin.google.com) as a super administrator and go to Account > Account settings > Legal and compliance, then accept the **Data Processing Amendment** (the exact wording of the menu may change slightly). Choose the option that applies to the association's contact for data protection (admin@umasbooks.org).
- 2-step verification: confirmed on 4 October 2026 (Sharon Bjeletich) to be on for every Google account that can open the admin inbox; only Sharon Bjeletich has access to admin@umasbooks.org. Re-check it in the console at the yearly review.

Date accepted: ____ / ____ / ______ / Done by: ____________

## Render (hosting and database)

- **What they get:** the whole website and its database: all accounts, orders, sign-ups, reservations, forum posts and so on; plus server logs. Region: Frankfurt (EU), per `render.yaml`. The workspace is on the Pro plan; platform logs are kept 14 days (confirmed by Sharon Bjeletich, 4 October 2026).
- **Role:** processor.
- **Action for Sharon:** look for the Data Processing Addendum (DPA) on Render's legal page (render.com, footer "Legal" or "Trust"/"Security" area). Follow the instructions there to accept or request it (some providers apply it automatically once you accept the Terms; the page says which). Keep a copy.

Date accepted: ____ / ____ / ______ / Done by: ____________

## GitHub (code, automatic checks and the backup job)

- **What they get:** the code (no personal data) and the automatic checks. **GitHub Actions also runs the nightly database backup job**: the job (GitHub Actions, United States) dumps the database, and that copy **passes through GitHub briefly (a transient copy on the runner) before it is uploaded to Backblaze**. It is not kept on GitHub: no backup is stored in the repository. The privacy policy names GitHub as a recipient for this reason.
- **Role:** processor (GitHub Actions, USA).
- **Action for Sharon:** accept the GitHub Data Protection Addendum (path in the status table above), and **confirm the transfer mechanism** (EU-US Data Privacy Framework certification and/or standard contractual clauses) in that document. Follow the page to accept it for the account or organisation that owns the repository `umasbooksadmin`. If the page says it is part of the terms already accepted, note that and keep a copy. Make the repository private before real members arrive.
- TODO(the association): consider **encrypting the dump before upload** (for example with `gpg` or `age` in the backup workflow), so that the transient copy on GitHub is unreadable there. The key must then be kept safely outside GitHub, or a restore becomes impossible.
- If the old `db-backups` branch is still there, delete it (GitHub > repository > Branches). Old backup commits may stay reachable on GitHub for a while after that; GitHub Support can purge them on request.

Date accepted: ____ / ____ / ______ / Done by: ____________

## Backblaze B2 (offsite backup)

- **What they get:** the same nightly database dump (all personal data), in a private, encrypted bucket.
- **Role:** processor.
- **Action for Sharon:** look for the Backblaze Data Processing Addendum (DPA) on Backblaze's legal page (backblaze.com, footer "Legal"). Follow the instructions there to sign or accept it for the account. Also confirm in the B2 console: bucket is **private**, default encryption is **on**, the bucket is in an **EU region**, and the lifecycle rules from `umas-books/README.md` (30 days / 730 days) exist.
- Confirmed by Sharon Bjeletich on 4 October 2026: bucket region `eu-central-003` (EU region); lifecycle set to delete nightly dumps after 30 days and monthly copies after 730 days. These are set in the Backblaze console and cannot be verified from the repository.

Date accepted: ____ / ____ / ______ / Done by: ____________

## Squarespace (domain registration and DNS)

- **What they get:** the domain owner's account details (confirmed 4 October 2026 by Sharon Bjeletich). **No member data.** Squarespace is the registrar and DNS host for `umasbooks.org` only (Squarespace Domains II LLC; nameservers `squarespacedns.com`). It does **not** host the website: Render does, and the DNS records point `umasbooks.org` to Render.
- **Role:** processor / service provider for the owner's account details only.
- **Action for Sharon:** look for the Data Processing Addendum on Squarespace's legal page (squarespace.com, footer "Legal"). Keep the 2-step verification on the account and keep the domain on auto-renew.

Date checked: ____ / ____ / ______ / Done by: ____________

## HelloAsso (memberships only)

- **What they get:** the membership only. Books and drop-in seats are reserved on the website and paid in the shop, so HelloAsso receives nothing about them, and the website no longer creates payment pages for orders. For a membership, HelloAsso receives only what the visitor types into HelloAsso's own form (name, email, card or bank details, which we never see). The website receives back: order number, payer email, amount and date.
- **Role:** HelloAsso is a French payment institution/platform for associations and acts as an **independent controller** for the payment data (our privacy policy says so). It collects the payment data for its own purposes (payment, its own legal duties). That is usually why a DPA is not signed with it.
- **Action for Sharon:** read HelloAsso's privacy / legal pages ("Politique de confidentialité" and its terms for organisations) and confirm they describe themselves as controller for payment data. If they say they act as a processor for the association's membership data, look for their DPA there. Write down what you found below.
- Make sure the HelloAsso account's own users (who can see member lists) are only people who need to.

What I found: ____________________________
Date checked: ____ / ____ / ______ / Done by: ____________

## Anthropic API (book cover scans, book descriptions and price lookups)

- **What they get (checked in `src/lib/coverVision.js`, `src/lib/bookDescription.js` and `src/lib/pricing/market.js`):**
  - Cover scan: the **photo of a book cover or barcode** an admin uploads in the inventory screen, plus a fixed instruction asking for ISBN, title and author.
  - Description: only book facts (title, author, publisher, year) and a fixed instruction (English only: book descriptions are no longer translated to French).
  - Pricing lookups (only when `PRICING_AI` is switched on, off by default): the book's **ISBN, title, author and binding** and a fixed instruction asking for current used prices of that edition, using the web search tool. Results are cached per ISBN.
  - **No member, buyer, email, name or order data is ever sent.** Only admins can trigger it, and the call is skipped if the key is missing.
- **Retention at Anthropic:** inputs and outputs are deleted from Anthropic's systems within 30 days (source: Anthropic privacy centre; confirmed 4 October 2026), except content flagged for usage-policy violations, which is kept longer. The site sends only book facts and cover photos, no personal data.
- **Role:** none for personal data, as long as the rule below is followed.
- **Rule for volunteers:** photograph only the book (cover or barcode), never people or documents. If a person's face or a written name ends up in a photo, retake it.
- **Action for Sharon:** none required for the DPA while no personal data is sent. If this ever changes, look for the DPA on Anthropic's legal page (anthropic.com/legal) before it does.

Date checked: ____ / ____ / ______ / Done by: ____________

## Wikidata (awards by ISBN)

- **What they get (`src/lib/awards/wikidata.js`):** a book's ISBN in a query to query.wikidata.org, sent by the server with the User-Agent `UmasBooks/1.0 (admin@umasbooks.org)`. **No personal data.** Their server sees the Render server's IP address.
- **Action for Sharon:** none (no personal data).

## New York Times Books API (best-seller lists, optional)

- **What they get (`src/lib/awards/nyt.js`):** a book's ISBN-13 and our API key, only when `NYT_API_KEY` is set. **No personal data.**
- **Action for Sharon:** none for the DPA. Keep to their terms (5 requests per minute, 500 per day; the code enforces both).

## Google Books, ISBNdb, BnF (book data by ISBN)

- **What they get (`src/lib/bookLookup.js`, `bookSources.js`):** an ISBN, or a title/author search, sent **by our server** when an admin adds a book (googleapis.com/books, api2.isbndb.com with our API key, catalogue.bnf.fr). **No personal data**: no visitor's browser contacts them. Named in the public privacy policy (section "Who receives your data") together with Wikidata/Wikimedia, the New York Times API and Have I Been Pwned, as services that receive only book or technical data.
- **Action for Sharon:** none (no personal data). Keep to their terms of use.

## Open Library / Internet Archive (book data and covers)

- **What they get:** an ISBN or a title/author search when an admin adds a book (`src/lib/bookLookup.js`), and a request for the cover image, both made **by our server** (`src/lib/coverStore.js`). No personal data: the request carries no visitor information. Their server sees the Render server's IP address, not a person's.
- **Visitors' browsers never contact them.** Covers are copied to our own database and served from our own address; the site's Content-Security-Policy lists no external image host. (Before October 2026 covers were loaded straight from their servers in each visitor's browser, which sent visitor IP addresses to a US operator; that is fixed.)
- **Action for Sharon:** none (no personal data). 

Date checked: ____ / ____ / ______ / Done by: ____________

## Cloudflare (network in front of Render)

- **What they get:** the website is served through Cloudflare, the content-delivery and security network that Render uses at its edge. Every request from a visitor passes through it: it sees the visitor's **IP address**, the pages requested and the traffic relayed to our server (including what people type in forms). It is a sub-processor of Render, not something we configure.
- **Action for Sharon:** nothing to sign separately if Render's own DPA (Render dashboard > Account/Workspace settings > look for the data processing addendum on Render's legal page) covers its sub-processors: check Render's sub-processor list names Cloudflare, and keep a copy of the DPA. The public privacy policy names Cloudflare as a recipient (US company; transfers under the standard contractual clauses or EU-US Data Privacy Framework).

Date checked: ____ / ____ / ______ / Done by: ____________

## Have I Been Pwned: Pwned Passwords range API (password check)

- **What they get (checked in `src/lib/passwordPolicy.js`):** only the **first 5 characters of the SHA-1 hash** of a new password, with the "Add-Padding" option. Never the email, never the full password. The site's server (not the person's browser) makes the request.
- **Action for Sharon:** none (no personal data is sent, so no DPA is needed). 

Date checked: ____ / ____ / ______ / Done by: ____________

---

## Also worth knowing (not processors in the list above)

- **Google Fonts:** not used by the website any more. Fonts are self-hosted (`assets/fonts/`, `public/style.css`) and the Content-Security-Policy allows fonts from the site only.
- (Squarespace is not in this list: it is a provider, see the section below.)
