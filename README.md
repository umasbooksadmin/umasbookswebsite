# Uma's Books and Adventures — website

Website for Uma's Books and Adventures, a non-profit secondhand
English-language bookshop (and children's English program) in Albi, France.

**This repository is one app.** The live site is a single Node.js/Express
application in [`umas-books/`](umas-books/) that serves both the public
marketing pages (home, about, books, events, English programs, …) and the
members area (accounts, forum, reservations, admin). It runs on Render. Squarespace
has been retired, and there are no standalone `.html` pages in this repo — the
pages are EJS templates under `umas-books/views/marketing/`.

Start here:

- **[`umas-books/README.md`](umas-books/README.md)** — what each feature does,
  how to run it locally, configuration, deploy, and how to restore a backup.
- **[`docs/architecture.md`](docs/architecture.md)** — the whole system in
  diagrams: how it fits together, request flow, data model, reservations and payment, deploy,
  backups and security.
- **[`docs/runbook.md`](docs/runbook.md)** — step-by-step: rolling back a deploy,
  rotating secrets, a locked-out admin, where alerts go, the yearly checklist.
- **[`umas-books/ARCHITECTURE.md`](umas-books/ARCHITECTURE.md)** — how it is put
  together: routes, views, data, environment variables, migrations, the
  deploy sequence, and operations.

**Privacy paperwork:** [`docs/privacy/`](docs/privacy/) holds the GDPR register of processing
([`record-of-processing.md`](docs/privacy/record-of-processing.md)), the provider DPA checklist
([`processors-checklist.md`](docs/privacy/processors-checklist.md)) and the breach log with the
72-hour procedure ([`breach-log.md`](docs/privacy/breach-log.md)).

## What lives at the repo root

Only the static files the marketing pages load, plus deployment and CI config:

| Path | What it is |
|---|---|
| `assets/` | Shared CSS/JS/images for the marketing pages, served at `/assets/*`. `site.css` is the shared header/footer/page styling; `site.js` is the EN/FR language toggle and the logged-in header state; each page has its own small stylesheet (`home.css`, `books.css`, `events.css`, `immersion.css`, …); `blog.js`, `blog-live.js` and `blog.css` render the blog; `img/` holds the artwork and photos. |
| `logo.png` | The shop's logo, served at `/logo.png`. |
| `render.yaml` | The Render Blueprint (web service + Postgres), both on paid plans matching the Render dashboard. |
| `.github/dependabot.yml` | Weekly update pull requests for GitHub Actions and npm packages (never auto-merged). |
| `.github/workflows/` | CI (six required checks on every pull request), the nightly database backup, the monthly backup-restore test, and the uptime check. |

The marketing static files are served before the session store, so images and
CSS never cost a database lookup (see `ARCHITECTURE.md`).

## Editing the site

- **A page's text and layout:** the matching file in
  `umas-books/views/marketing/<name>.ejs`. Adding a page means adding the view
  *and* its filename to the `MARKETING_PAGES` array in `umas-books/src/index.js`.
- **Styles and images:** `assets/`. Change a page's own stylesheet for
  page-specific looks, `site.css` for anything shared.
- **Languages:** every page has an EN | FR toggle. Shared strings (navigation,
  footer) live in the `COMMON` dictionary in `assets/site.js`; each page's own
  strings are the `pageI18nEn` / `pageI18nFr` objects at the bottom of its view.
  Add matching English and French entries — a key missing in one language has no
  fallback.
- **Blog posts, announcements, books, events and sessions:** managed in the
  admin area of the running site, not in files.
- **Forms:** the volunteer sign-up and the weekly-immersion pre-registration
  are server forms (`POST /volunteer-signup`, `POST /pre-registration`,
  `umas-books/src/routes/marketingForms.js`), like the contact form: CSRF token,
  honeypot, rate limit, server-side validation with an accessible error summary,
  then one email to `CONTACT_TO`; nothing is stored. They no longer open the
  visitor's email app (the old `data-mailto` handler is gone from
  `assets/site.js`). Book reservations (reserve online, pay at the shop), event and
  session sign-ups are server routes too; only the membership is paid online.

## Changing the code

`main` is protected: every change goes through a pull request, and all six CI
checks (`test`, `lint`, `migration-test`, `dependency-audit`, `secret-scan`,
`smoke-crawl`) must pass before it can merge. Merging to `main` deploys to
production on Render. See `umas-books/ARCHITECTURE.md` ("Deploy sequence") and
`umas-books/README.md` for the details and the local test commands.

## Leftovers from the Squarespace era

These are no longer used by the site and are safe to delete when you are ready
(they were left in place so nothing was removed without being asked):

- `SQUARESPACE.md`, `squarespace-code-block.html`,
  `squarespace-code-block.filled.html`, `squarespace-paste-payload.html`
- `tools/` (`build-squarespace.py`, `build_pages.py`, `gen_page.py`) — page
  generators for the old standalone HTML pages. Do not run them: they would not
  produce anything the app uses.
