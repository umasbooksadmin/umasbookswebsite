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
  currently a stub — will eventually link out to `members-app`)
- `members-app/` — the real Members Area: a separate Node.js + PostgreSQL
  app (accounts, forum, event RSVPs, charity vote) deployed on Render,
  independent of Squarespace. See `members-app/README.md`.
- `assets/site.css` — shared styles for every page
- `assets/site.js` — shared language toggle (EN/FR) + mailto-form wiring
- `logo.png` — the shop's logo, referenced by every page
- `tools/gen_page.py`, `tools/build_pages.py` — generator used to scaffold
  the sub-pages consistently (shared header/footer). Re-run
  `python3 tools/build_pages.py` after editing a page's content in that
  script to regenerate it; hand-edits to a generated `.html` file will be
  overwritten the next time it runs.

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

The site is also published as a Claude Artifact; edits made here are
mirrored there.

## Contact

admin@umasbooks.org
