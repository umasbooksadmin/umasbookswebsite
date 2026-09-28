# Site map, generated from the real code

Three scripts that produce an accurate map of every page in the app and how
they link together — nothing in the output is typed by hand, so it can't
drift the way a hand-drawn diagram does. Rerun this after any route or
template change.

## What each script does

1. **`route-inventory.js`** — parses every `router.get`/`router.post` call in
   `src/routes/*.js` (plus the static marketing pages and top-level routes in
   `src/index.js`) and lists every URL the app registers, with whatever auth
   middleware gates it (`requireAuth`, `requireMember`, `requireAdmin`,
   `requireVolunteer`, or none). Pure static analysis — no server needed.

2. **`crawler.js`** — starts from those URLs, logs in as five real accounts
   (anonymous, a plain account holder, a paying member, a volunteer, an
   admin) against an actually-running server, and records the real HTTP
   status each persona gets back. For any page that loads, it also extracts
   every `<a href>` and GET `<form action>` actually present in the
   rendered HTML (POST form actions are recorded separately as "submits to,"
   not crawled as pages — GETting a POST-only endpoint just produces a
   meaningless 404/500).

3. **`build-report.js`** — merges the two into one `report.json`: for every
   page, its gate, its status under each persona, and who links to/from it.

`route-map.html` is a static viewer for that JSON — a searchable, filterable
table, one row per page, expandable to see the link detail.

`flowchart.html` is a second viewer for the same JSON — one flowchart per
persona, laid out by BFS over that persona's real links starting from their
actual landing page (`/` for a guest or plain account, `/dashboard` for a
member or volunteer, `/admin` for an admin). Any page that persona can
genuinely open (a real 200) but that has no path back to their landing page
is listed separately as orphaned for them, rather than silently dropped.

## Prerequisites

- The app running locally against a database you're fine crawling (this
  logs in and clicks around as five accounts — don't point it at
  production).
- Five test accounts, all with the same password, so the crawler can log
  in as each persona:

  ```sql
  -- Replace the hash with your own: node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 12))"
  INSERT INTO users (email, password_hash, display_name, is_admin, is_member, is_volunteer) VALUES
    ('crawl-account@example.test',   '<hash>', 'Crawl Account',   false, false, false),
    ('crawl-member@example.test',    '<hash>', 'Crawl Member',    false, true,  false),
    ('crawl-volunteer@example.test', '<hash>', 'Crawl Volunteer', false, false, true),
    ('crawl-admin@example.test',     '<hash>', 'Crawl Admin',     true,  true,  false)
  ON CONFLICT (email) DO NOTHING;
  ```

  Delete these when you're done — they're just crawler credentials, not
  real accounts.

## Running it

```bash
# from umas-books/
node scripts/sitemap/route-inventory.js . > scripts/sitemap/routes.json
node scripts/sitemap/crawler.js http://localhost:3099 scripts/sitemap/routes.json > scripts/sitemap/crawl.json
node scripts/sitemap/build-report.js scripts/sitemap/routes.json scripts/sitemap/crawl.json > scripts/sitemap/report.json
```

If `crawler.js`'s hardcoded password doesn't match what you used for the
test accounts, edit the `PASSWORD` constant at the top of the file.

## Viewing the result

Both viewers expect the report JSON inlined in place of their
`window.REPORT = __REPORT_JSON__;` placeholder. Generate a viewable copy of
either (or both):

```bash
node -e "
const fs = require('fs');
['route-map', 'flowchart'].forEach(name => {
  const html = fs.readFileSync('scripts/sitemap/' + name + '.html', 'utf8');
  const report = fs.readFileSync('scripts/sitemap/report.json', 'utf8');
  fs.writeFileSync('scripts/sitemap/' + name + '-filled.html', html.replace('__REPORT_JSON__', report));
});
"
open scripts/sitemap/route-map-filled.html scripts/sitemap/flowchart-filled.html
```

`routes.json`, `crawl.json`, `report.json`, and the `-filled.html` files are
all generated output — regenerate them rather than editing by hand, and
don't commit them (they contain a snapshot of your data, e.g. real IDs
picked up from the crawl).
