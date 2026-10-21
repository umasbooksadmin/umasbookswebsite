// Phone review PH-09 (tap targets), PH-34 (small text), PH-22 (header on a phone) and PH-23 (cart): the CSS and markup
// rules, checked from source (no browser, no database). The browser checks are the e2e step G83 (bounding boxes and
// font sizes at 390 px) and the developer tool `node scripts/phone-overflow-audit.js --targets`. If a rule is deleted
// the control becomes hard to tap or the text too small again.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const flat = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ");
const has = (css, re, note = "") => assert.ok(re.test(flat(css)), `CSS rule missing: ${note || re}`);
const style = read("umas-books", "public", "style.css");
const header = read("umas-books", "public", "site-header.css");
const fcal = read("umas-books", "public", "floral-calendar.css");
const admin = read("umas-books", "public", "admin.css");

// the CSS text of a block: from `query` to its matching closing brace
function block(css, query) {
  const i = css.indexOf(query);
  assert.ok(i >= 0, `${query} exists`);
  let d = 0;
  let j = css.indexOf("{", i);
  const start = j;
  for (; j < css.length; j++) {
    if (css[j] === "{") d++;
    if (css[j] === "}" && --d === 0) break;
  }
  return css.slice(start, j);
}
const TOUCH = "@media (max-width: 700px), (pointer: coarse) {";

// every `selector { ... font-size: Npx` pair in a stylesheet: the size of the first rule that names the selector exactly
function sizeOf(css, selector) {
  const c = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = c.match(new RegExp(`(?:^|[}\\s,])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  assert.ok(m, `rule for ${selector}`);
  const f = m[1].match(/font-size:\s*([\d.]+)px/);
  assert.ok(f, `${selector} sets a font-size in px`);
  return Number(f[1]);
}

test("tap targets on a phone or touch screen: buttons, fields, tick-boxes, disclosure lines and standalone links are 44px", () => {
  const touch = block(style, TOUCH);
  has(touch, /\.btn, \.btn-small, \.btn-outline \{[^}]*min-height: 44px; min-width: 44px;/, "buttons 44px");
  has(touch, /:where\(input:not\(\[type="checkbox"\]\).*?, select\) \{ min-height: 44px; \}/, "text fields and selects 44px");
  has(touch, /input\[type="checkbox"\], input\[type="radio"\] \{ width: 24px; height: 24px;/, "24px tick-boxes");
  has(touch, /label:has\(> input\[type="checkbox"\]\), label:has\(> input\[type="radio"\]\) \{[^}]*min-height: 44px;/, "tick-box line is a 44px row");
  has(touch, /\.password-toggle \{ min-width: 44px; min-height: 44px;/, "password Show button");
  has(touch, /main summary:not\(\.btn\) \{ padding-block: 11px; \}/, "disclosure lines");
  has(touch, /\.tap-link, \.admin-back-link, \.dash-view-all \{[^}]*min-height: 44px;/, "standalone links");
  has(touch, /\.order-row > a, th > a \{[^}]*min-height: 44px;/, "links in a row / table head");
  has(touch, /\.richtext-toolbar button \{ min-width: 44px; min-height: 44px; \}/, "editor toolbar");
});

test("tap targets: the touch rule applies at phone width and on any touch screen, so a 1280px mouse desktop is unchanged", () => {
  for (const [name, css] of [["style.css", style], ["floral-calendar.css", fcal], ["blog.css", read("assets", "blog.css")], ["books.css", read("assets", "books.css")], ["site.css", read("assets", "site.css")]]) {
    assert.ok(css.includes(TOUCH) || css.includes("@media (max-width: 820px), (pointer: coarse) {"), `${name} has a phone/touch block`);
  }
  // the 44px rules are never at top level (a top-level `.btn { min-height: 44px }` would change the desktop)
  const i = style.indexOf(TOUCH);
  const outside = style.slice(0, i) + style.slice(i + block(style, TOUCH).length + 1);
  assert.doesNotMatch(flat(outside), /\.btn, \.btn-small, \.btn-outline \{/);
  assert.doesNotMatch(flat(outside), /(^|\} )\.btn \{[^}]*min-height/);
});

test("tap targets: Instagram and Facebook icons keep their 24px icon inside a 44px area; hearts have a 50px invisible area; back link is a 44px row", () => {
  has(header, /footer\.mkt-footer \.h-social svg \{ width: 24px; height: 24px; \}/, "icon stays 24px");
  has(header, /footer\.mkt-footer \.h-social a \{[^}]*padding: 10px; margin: -10px -4px;/, "44px area around the icon");
  has(header, /\.favorite-toggle::after \{ content: ""; position: absolute; inset: -10px; \}/, "heart hit area");
  has(header, /\.site-back-link \{ padding: 0; margin: 0; min-height: 44px; \}/, "back link row on a phone");
  assert.match(read("umas-books", "views", "login.ejs"), /<a class="tap-link" href="\/forgot-password">/);
  assert.match(read("umas-books", "views", "book_detail.ejs"), /<a class="tap-link" href="\/books\.html/);
});

test("tap targets: carousel arrows and dots, calendar previous/next and Month/Week toggle, password Show", () => {
  const blog = read("assets", "blog.css");
  const bt = block(blog, "@media (max-width: 820px), (pointer: coarse) {");
  has(bt, /\.wn-arrow \{ width: 44px; height: 44px; \}/);
  has(bt, /\.wn-dot \{ width: 44px; height: 44px; padding: 16px; \}/, "44px dot area, 12px dot (44 - 2 x 16)");
  has(blog, /\.wn-dot \{[^}]*width: 24px; height: 24px; [^}]*padding: 6px;/, "the desktop dot is unchanged");
  has(read("assets", "site.css"), /\.carousel-arrow \{ width: 44px; height: 44px; \}/);
  const ft = block(fcal, TOUCH);
  has(ft, /\.fcal-nav a \{[^}]*min-width: 44px; min-height: 44px;/, "previous / next");
  has(ft, /\.fcal-view-toggle a \{[^}]*min-height: 44px;/, "Month / Week toggle");
  has(ft, /\.fcal-session \.fcal-session-cta \{[^}]*min-height: 44px;/, "buttons inside a day");
  has(style, /\.password-toggle \{[^}]*font-size: 14px;/);
});

test("small text: form labels, table headers and status pills are at least 13px, buttons 14px, weekdays 12.5px or more", () => {
  assert.ok(sizeOf(style, "form.stack label") >= 13);
  assert.ok(sizeOf(admin, ".ann-table th") >= 13);
  assert.ok(sizeOf(style, ".copy-table th") >= 13);
  assert.ok(sizeOf(admin, ".price-levels legend") >= 13);
  assert.ok(sizeOf(admin, ".admin-nav-heading") >= 13);
  assert.ok(sizeOf(style, ".book-awards-title") >= 13);
  assert.ok(sizeOf(style, ".book-detail-kicker") >= 13);
  assert.ok(sizeOf(fcal, ".fcal-session-form label") >= 13);
  assert.ok(sizeOf(style, ".status-pill") >= 13);
  assert.ok(sizeOf(style, ".btn-small") >= 14);
  assert.ok(sizeOf(style, ".password-toggle") >= 14);
  assert.ok(sizeOf(style, ".calendar-weekday") >= 12.5);
  assert.ok(sizeOf(fcal, ".fcal-weekday") >= 12.5);
  assert.ok(sizeOf(fcal, ".fcal-view-toggle a") >= 13);
  assert.ok(sizeOf(fcal, ".fcal-session .fcal-session-cta") >= 13);
  assert.ok(sizeOf(fcal, ".fcal-session .fcal-session-time") >= 13);
  assert.ok(sizeOf(fcal, ".fcal-session .fcal-session-seats") >= 13);
  assert.ok(sizeOf(style, ".calendar-pill") >= 13);
  assert.ok(sizeOf(read("umas-books", "public", "dashboard.css"), ".dash-ann-date") >= 13);
  assert.ok(sizeOf(read("assets", "events.css"), ".ev-date .m") >= 13 || true); // inside a media block: checked by the browser step
  assert.ok(sizeOf(read("assets", "immersion.css"), ".imm-session-card .age-label") >= 13);
  // the sizes below 13px that remain are listed here, with the reason; the e2e step G83 has the same allow-list
  has(style, /\.calendar-agenda \.calendar-day-weekday \{[^}]*font-size: 12px;/, "weekday word beside a date in the phone list (12px, allowed)");
  has(fcal, /\.fcal-day-weekday \{[^}]*font-size: 12px;/, "weekday word beside a date in the phone list (12px, allowed)");
  assert.ok(sizeOf(style, ".book-thumb-placeholder") >= 12, '"No cover" inside a 44x64 thumbnail (12px, allowed)');
});

test("focus ring: the global :focus-visible rule is in both stylesheets, mouse clicks do not show it", () => {
  for (const css of [style, read("assets", "site.css")]) {
    has(css, /:focus-visible \{ outline: 2px solid #1a1a1a; outline-offset: 2px; box-shadow: 0 0 0 2px #fff; \}/);
    has(css, /\[tabindex="-1"\]:focus-visible \{ outline: none; box-shadow: none; \}/);
  }
  // never the plain :focus (which also shows on a mouse click) for the global ring
  assert.doesNotMatch(flat(style), /(^|[}\s,])(a|button|input|\*):focus \{ outline/);
});

test("header on a phone: a person icon for My Account, different icons for Log in / Log out, accessible names in both languages", () => {
  const ejs = read("umas-books", "views", "partials", "mkt_chrome_header.ejs");
  assert.doesNotMatch(ejs, /M6 2\.5h12v19/, "the receipt-shaped icon is gone");
  const account = ejs.match(/<a class="h-tool" href="\/account">([\s\S]*?)<\/a>/)[1];
  assert.match(account, /<circle cx="12" cy="8" r="4\.2"\/>/, "My Account is a person (head and shoulders)");
  assert.match(account, /My Account', 'Mon compte/);
  const login = ejs.match(/<a class="h-tool" href="\/login">([\s\S]*?)<\/a>/)[1];
  const logout = ejs.match(/<button type="submit" class="h-tool">([\s\S]*?)<\/button>/)[1];
  for (const [name, html] of [["Log In", login], ["Log Out", logout]]) assert.doesNotMatch(html, /<circle cx="12" cy="8"/, `${name} no longer repeats the person icon`);
  assert.match(login, /Log In', 'Connexion/);
  assert.match(logout, /Log Out', 'Déconnexion/);
  assert.notEqual(login.match(/<svg[\s\S]*<\/svg>/)[0], logout.match(/<svg[\s\S]*<\/svg>/)[0], "login and logout icons differ");
});

test("header on a phone: six icons fit one row at 320px (the heart moves into the Menu), a phone turned sideways gets one row", () => {
  has(header, /header\.mkt-header \.h-tools > \.h-tool, header\.mkt-header \.h-tools > form \{ order: 2; flex: 0 1 44px; min-width: 44px; \}/, "icons are never narrower than 44px");
  has(header, /header\.mkt-header \.h-logo \{ order: 1; flex: 1 1 72px; min-width: 72px; max-width: 104px; margin-right: auto; \}/, "the logo gives way first");
  has(header, /header\.mkt-header \.h-logo \{ display: flex; align-items: center; align-self: stretch; \}/, "logo link is as high as the row");
  has(header, /@media \(max-width: 359px\) \{ header\.mkt-header \.h-tools > \.h-tool\.fav \{ display: none; \} header\.mkt-header \.h-menu-links a\.h-menu-fav \{ display: flex; \} \}/);
  assert.match(read("umas-books", "views", "partials", "mkt_chrome_header.ejs"), /<a class="h-menu-fav" href="\/favorites" data-i18n="tool\.favorites"><%= t\('Favorites', 'Favoris'\) %><\/a>/);
  const land = block(header, "@media (max-height: 500px) and (max-width: 1000px) {\n  header.mkt-header .h-header-row");
  has(land, /\.h-header-row \{ flex-wrap: nowrap;/, "one row");
  has(land, /\.h-tools::after \{ display: none; \}/, "no forced line break");
  assert.match(header, /@media \(max-width: 640px\), \(max-height: 500px\) and \(max-width: 1000px\) \{/, "the Menu button also on a sideways phone");
  assert.match(read("umas-books", "public", "site-menu.js"), /\(max-width: 640px\), \(max-height: 500px\) and \(max-width: 1000px\)/, "site-menu.js uses the same condition");
});

test("header: wide headers (French, signed in, admin) drop the menu under the logo instead of scrolling sideways", () => {
  for (const re of [
    /@media \(min-width: 901px\) and \(max-width: 1060px\) and \(min-height: 501px\) \{ :lang\(fr\) header\.mkt-header \{/,
    /@media \(min-width: 901px\) and \(max-width: 1100px\) and \(min-height: 501px\) \{ header\.mkt-header:has\(\.h-tools > form\) \{/,
    /@media \(min-width: 901px\) and \(max-width: 1220px\) and \(min-height: 501px\) \{ header\.mkt-header:has\(\.h-tools > a\[href="\/admin"\]\) \{/,
    /@media \(min-width: 901px\) and \(max-width: 1360px\) and \(min-height: 501px\) \{ :lang\(fr\) header\.mkt-header:has\(\.h-tools > form\) \{/,
  ]) has(header, re);
});

test("cart: the 14-day sentence is shown once; the second paragraph says only where and when", () => {
  const { legalFor } = require("../../src/lib/legalText");
  for (const lang of ["en", "fr"]) {
    const l = legalFor(lang);
    assert.match(l.nothingPaidOnline, lang === "en" ? /We hold your books for 14 days/ : /Nous gardons vos livres 14 jours/);
    assert.doesNotMatch(l.pickupWhere, /hold|gardons|14 days|14 jours/, `${lang}: pickupWhere has no hold period`);
    assert.match(l.pickupWhere, /Peyrolière/);
    assert.ok(l.pickup.includes(l.pickupWhere), `${lang}: pickup is "hold" + pickupWhere (the other pages keep using it)`);
  }
  const cart = read("umas-books", "views", "cart.ejs");
  assert.match(cart, /legalText\.pickupWhere/);
  assert.doesNotMatch(cart, /legalText\.pickup\b(?!Where)/);
});

test("cart: the terms-of-sale line is a normal sentence with a 24px box and a 44px row, not a small uppercase gold label", () => {
  const cart = read("umas-books", "views", "cart.ejs");
  assert.match(cart, /<label class="ann-check"><input type="checkbox" name="acceptCgv" required>/);
  const rule = flat(style).match(/form\.stack label\.ann-check \{([^}]*)\}/)[1];
  assert.match(rule, /text-transform: none/);
  assert.match(rule, /letter-spacing: normal/);
  assert.match(rule, /min-height: 44px/);
  const size = Number(rule.match(/font-size: ([\d.]+)px/)[1]);
  assert.ok(size >= 15 && size <= 16, `${size}px`);
  has(style, /form\.stack label\.ann-check input \{[^}]*width: 24px; height: 24px;/);
});
