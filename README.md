# Uma's Books and Adventures — website

Multi-page website for Uma's Books and Adventures, a non-profit secondhand
English-language bookshop (and Éveil children's English program) in Albi,
France.

## Contents

- `index.html` — Home
- `books.html` — Books (the collection, + Order Online)
- `classes.html` — Éveil Classes (the Éveil English Immersion Program, + other classes)
- `events.html` — Adventures & Events
- `about.html` — About Uma's (our story, + Get Involved)
- `visit.html` — Visit Us
- `volunteer.html` — Volunteer sign-up & schedule (linked from About / footer)
- `wishlist.html` — Book wish list (linked from footer / header heart icon)
- `membership.html` — Membership (linked from header account icon / footer;
  currently a stub — will eventually link out to `umas-books`)
- `umas-books/` — the real Members Area backend: a separate Node.js +
  PostgreSQL app (accounts, forum, charity vote, volunteer/meeting
  scheduling, inventory) deployed on Render, independent of Squarespace.
  See `umas-books/README.md`.
- `assets/site.css` — shared styles for every page, including the shared
  header and footer. The site is light-only (no dark theme) because the
  botanical artwork is painted for a pale background.
- `assets/home.css` — Home-page-only styles (hero, feature cards, About band)
- `blog.html` + `assets/posts.js`, `assets/blog.js`, `assets/blog.css` — the
  blog. Posts are written in `assets/posts.js` (EN/FR title, excerpt,
  paragraphs, optional image); the home page shows the 3 newest under the
  four cards, `blog.html` lists all and shows one via `blog.html?post=<slug>`.
- `assets/books.css` — Books-page-only styles. To change the
  "Recommendation of the week", edit the `BOOK_OF_THE_WEEK` block near the
  bottom of `books.html` (title, author, ISBN, stars, EN/FR blurb).
- `assets/img/` — Home-page artwork (hero botanicals, card medallions,
  shop-interior photo, leaf sprig), cropped from the design mockup
- `assets/site.js` — shared language toggle (EN/FR) + mailto-form wiring;
  its `COMMON` dictionary holds the header/footer strings
- `logo.png` — the shop's logo, referenced by every page
- `tools/gen_page.py`, `tools/build_pages.py` — generator used to scaffold
  the sub-pages originally. **Outdated** — the pages have since been
  edited by hand (including the new header/footer), so don't re-run it or
  it will overwrite them. The header/footer markup is copied into each
  `.html` file; when changing it, change every page (and
  `umas-books/views/partials/header.ejs` / `footer.ejs`, whose styles live
  in `umas-books/public/site-header.css`).

No build step — every page is plain HTML/CSS/JS, open any `.html` file
directly in a browser.

## Photography

The site currently uses styled placeholder blocks (`.photo-block`) instead
of real photos of the shop, its garden, the Éveil room, and Albi — search
each page for `Photo placeholder` / `<!-- TODO -->` to find and replace
them once real images are available.

## Language

Every page has an EN | FR toggle (top right of the header), backed by
`assets/site.js`. Shared strings (nav, footer) live in that file's
`COMMON` dictionary; page-specific strings live in a `window.PAGE_I18N`
object at the bottom of each page. When you add or edit copy, add matching
`en` and `fr` entries — there is no fallback if a key is missing in one
language.

## Forms

Wish List, Volunteer, Membership interest, the Éveil interest form, and
the newsletter sign-up on Home are all `<form data-mailto="..."
data-subject="...">` elements handled by `assets/site.js`: submitting one
opens the visitor's own email client with the message pre-filled, since
the site has no backend of its own. Nothing is sent anywhere by this code
directly.

## Known gaps / TODOs

- **Shop / member login URLs** (`https://umasbooks.org/shop`,
  `https://umasbooks.org/member-login`) are best-guess Squarespace
  default slugs, not confirmed against the live site — verify and correct
  if wrong (marked with `<!-- TODO -->` at each link).
- **Social links** (Instagram/Facebook in the footer) are placeholders
  (`href="#"`) until real profile URLs are provided.
- **Photography** — see above.

## Deployment

This used to be a single Squarespace Code Block (see `SQUARESPACE.md`),
which only supports one page. Now that the site is multiple HTML files,
that deployment model no longer applies as-is — see `SQUARESPACE.md` for
the options.

Live at https://umas-books.onrender.com — the `umas-books` Render service
(see `umas-books/README.md`) serves these marketing pages directly from
the repo root alongside the Members Area app, so there's one link for
everything. Routes for this are in `umas-books/src/index.js`; if a page
here is renamed or a new one added, add/update its route there too.

The site is also published as a Claude Artifact; edits made here are
mirrored there. Note that client-side `fetch()` calls (e.g. the Latest
Arrivals carousel on `books.html`) don't work inside the Artifact's
sandboxed environment — they only work on the real Render deployment.

## Contact

admin@umasbooks.org
