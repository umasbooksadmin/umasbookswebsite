// One constant, every page: the shop street number, the opening hours and the
// membership price live in src/lib/legal.js and are read when a page or email
// is built (not when the file loads), so changing one changes everything that
// shows it. Also guards the French polish items of the second legal review.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const legal = require("../../src/lib/legal");
const legalText = require("../../src/lib/legalText");

const NB = " ";
const view = (f) => fs.readFileSync(path.join(__dirname, "../../views", f), "utf8");
const root = path.join(__dirname, "../..");

function withConstants(values, fn) {
  const saved = {};
  for (const k of Object.keys(values)) { saved[k] = legal[k]; legal[k] = values[k]; }
  try { return fn(); } finally { Object.assign(legal, saved); }
}

test("the street: 'Rue Peyrolière' until a number is given, then '12 rue Peyrolière' everywhere", () => {
  assert.equal(legal.SHOP_STREET_NUMBER, "", "empty by default");
  assert.equal(legal.shopStreet("en"), "Rue Peyrolière");
  assert.equal(legal.shopStreet("fr"), "Rue Peyrolière", "start of a line or field");
  assert.equal(legal.shopStreet("fr", false), "rue Peyrolière", "inside a French sentence it is lower case");
  assert.match(legalText.PICKUP.fr, /, rue Peyrolière, Albi\. Venez retirer/);
  withConstants({ SHOP_STREET_NUMBER: "12" }, () => {
    assert.equal(legal.shopStreet("en"), "12 rue Peyrolière");
    assert.equal(legal.shopStreet("fr", false), "12 rue Peyrolière");
    assert.match(legalText.PICKUP.en, /Rue Peyrolière|12 rue Peyrolière, Albi\./);
    assert.match(legalText.PICKUP.fr, /12 rue Peyrolière, Albi\./);
    assert.equal(legalText.legalFor("fr").shopStreet, "12 rue Peyrolière");
    const d = legalText.fillVat({ a: "Shop: {shopStreet}, 81000 Albi", b: "à la {shopStreetInline}" }, "fr");
    assert.equal(d.a, "Shop: 12 rue Peyrolière, 81000 Albi");
    assert.equal(d.b, "à la 12 rue Peyrolière");
  });
  withConstants({ SHOP_STREET_NUMBER: "  " }, () => assert.equal(legal.shopStreet("en"), "Rue Peyrolière", "blank counts as empty"));
});

test("the opening hours come from ONE constant: Wednesday to Saturday, 14:00–19:00 (14 h–19 h, no-break spaces, in French)", () => {
  assert.equal(legal.SHOP_HOURS_EN, "14:00–19:00");
  assert.equal(legal.SHOP_HOURS_FR, `14${NB}h–19${NB}h`);
  assert.equal(legal.shopHours("en"), legal.SHOP_HOURS_EN);
  assert.equal(legal.shopHours("fr"), legal.SHOP_HOURS_FR);
  assert.equal(legal.shopDays("en"), "Wednesday to Saturday");
  assert.equal(legal.shopDays("fr"), "du mercredi au samedi");
  assert.equal(legal.shopDaysShort("en"), "Wed – Sat");
  assert.equal(legal.shopDaysShort("fr"), "Mer – Sam");
  assert.equal(legalText.fillVat({ h: "{shopHours}" }, "fr").h, `14${NB}h–19${NB}h`);
  assert.equal(legalText.fillVat({ h: "{shopHours}" }).h, "14:00–19:00");
  assert.equal(legalText.fillVat({ h: "{shopDays}" }, "fr").h, "du mercredi au samedi");
  assert.match(legalText.PICKUP.fr, new RegExp(`de 14${NB}h à 19${NB}h`));
  assert.match(legalText.PICKUP.en, /14:00–19:00/);
  // Machine format for structured data.
  assert.deepEqual(legal.SHOP_OPEN_DAYS, ["Wednesday", "Thursday", "Friday", "Saturday"]);
  assert.equal(legal.SHOP_OPENS, "14:00");
  assert.equal(legal.SHOP_CLOSES, "19:00");
});

test("the two opening-hours texts (SHORT and FIRM), in English and French", () => {
  const IG = "https://www.instagram.com/umas_books_adventures/";
  assert.equal(legal.SHOP_EXTRA_HOURS_NOTE_URL, IG);
  assert.equal(legal.SOCIAL_LINKS.instagram, IG, "the same clean address, no tracking query string");
  assert.equal(legal.SOCIAL_LINKS.facebook, "", "no Facebook page given: stays hidden");
  assert.equal(legal.shopHoursShort("en"), "Open Wednesday to Saturday, 14:00–19:00. Extra opening hours when volunteers are available: see our Instagram.");
  assert.equal(legal.shopHoursShort("fr"), `Ouvert du mercredi au samedi, de 14${NB}h à 19${NB}h. Ouvertures supplémentaires selon la disponibilité des bénévoles${NB}: voir notre Instagram.`);
  assert.equal(legal.shopHoursShort("en", true), `Open Wednesday to Saturday, 14:00–19:00. Extra opening hours when volunteers are available: see our <a href="${IG}" target="_blank" rel="noopener noreferrer">Instagram</a>.`);
  assert.match(legal.shopHoursShort("fr", true), new RegExp(`${NB}: voir notre <a href="${IG}" target="_blank" rel="noopener noreferrer">Instagram</a>\\.$`));
  assert.equal(legal.shopHoursFirm("en"), "Collect your books during our regular hours, Wednesday to Saturday, 14:00–19:00. We are sometimes open at other times when volunteers are available, but only the regular hours are guaranteed.");
  assert.equal(legal.shopHoursFirm("fr"), `Venez retirer vos livres pendant nos horaires habituels, du mercredi au samedi, de 14${NB}h à 19${NB}h. Nous sommes parfois ouverts à d’autres moments selon la disponibilité des bénévoles, mais seuls les horaires habituels sont garantis.`);
  // Clearing the address drops the Instagram mention; the FIRM text never has a link.
  withConstants({ SHOP_EXTRA_HOURS_NOTE_URL: "" }, () => {
    assert.equal(legal.shopHoursShort("en", true), "Open Wednesday to Saturday, 14:00–19:00. Extra opening hours when volunteers are available.");
  });
  assert.doesNotMatch(legal.shopHoursFirm("en") + legal.shopHoursFirm("fr"), /Instagram|<a /);
  assert.equal(legalText.fillVat({ h: "{shopHoursShort}|{shopHoursFirm}" }, "en").h, `${legal.shopHoursShort("en", true)}|${legal.shopHoursFirm("en")}`);
  assert.equal(legalText.legalFor("fr").shopHoursFirm, legal.shopHoursFirm("fr"));
});

test("where each text is used: SHORT on the visit and volunteer pages, FIRM in the pickup clauses, emails, cart and terms", () => {
  for (const f of ["marketing/visit.ejs", "marketing/volunteer.ejs"]) assert.match(view(f), /legalText\.shopHoursShort/, `${f} shows the SHORT text`);
  assert.match(view("cart_return.ejs"), /legalText\.shopHoursFirm/);
  assert.match(view("marketing/terms-of-sale.ejs"), /\{shopHoursFirm\}/);
  const fs2 = (f) => fs.readFileSync(path.join(root, f), "utf8");
  assert.match(fs2("src/lib/orderEmail.js"), /legal\.shopHoursFirm/);
  assert.match(fs2("src/lib/orderSweeps.js"), /legal\.shopHoursFirm/);
  assert.match(fs2("src/lib/legalText.js"), /legal\.shopHoursFirm/, "PICKUP (cart, reservation page) uses it");
  assert.match(legalText.PICKUP.en, new RegExp(legal.shopHoursFirm("en").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(legalText.PICKUP.fr, /seuls les horaires habituels sont garantis\.$/);
});

test("structured data lists the REGULAR hours only: Wednesday to Saturday, opens 14:00, closes 19:00", () => {
  const home = view("marketing/index.ejs");
  assert.match(home, /dayOfWeek: legalText\.shopOpenDays/);
  assert.match(home, /opens: legalText\.shopOpens/);
  assert.match(home, /closes: legalText\.shopCloses/);
  const spec = { dayOfWeek: legalText.legalFor("en").shopOpenDays, opens: legalText.legalFor("en").shopOpens, closes: legalText.legalFor("en").shopCloses };
  assert.deepEqual(spec, { dayOfWeek: ["Wednesday", "Thursday", "Friday", "Saturday"], opens: "14:00", closes: "19:00" });
});

// Guard: the old hours (Tuesday to Saturday, 10:00–19:00) must not come back as a typed copy in any view, email or text we own.
test("no view or email types the shop days or hours by hand (old Tuesday / mardi / 10:00 / 10 h hours)", () => {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (/\.(ejs|js)$/.test(e.name)) files.push(f);
    }
  })(path.join(root, "views"));
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith(".js")) files.push(f);
    }
  })(path.join(root, "src"));
  // Allow-list: unrelated uses of the same words (calendar weekday headers, the class pre-registration day
  // choices, which are about class sessions and not the shop, and the legal constants file itself).
  const allowed = [/Tue['"]\s*,\s*['"]Mar/, /'Tue'/, /preg\.day\./, /DAYS = \{/, /^\s*\/\//];
  const bad = /Tuesday|\bmardi\b|Tue &ndash;|\b10:00\b|\b10(\u00a0|&nbsp;| )?h\b|10h00|10 ?am\b/i;
  const hits = [];
  for (const f of files) {
    if (f.endsWith(path.join("src", "lib", "legal.js"))) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (bad.test(line) && !allowed.some((a) => a.test(line))) hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], "shop days and hours come from lib/legal.js only");
});

test("no page or email we own keeps its own copy of the hours or the street", () => {
  const files = ["marketing/visit.ejs", "marketing/volunteer.ejs", "marketing/mentions-legales.ejs", "marketing/index.ejs", "cart_return.ejs"];
  for (const f of files) {
    const src = view(f);
    assert.doesNotMatch(src, /14:00|19:00|10:00|10h00|10 h à 19 h|de 10h à 19h|Tuesday|mardi/, `${f}: hours come from SHOP_HOURS_*`);
    assert.doesNotMatch(src.replace(/legalText\.shop\w+/g, ""), /Rue Peyrolière|Rue Peyroli&egrave;re|rue Peyrolière/, `${f}: street comes from shopStreet()`);
  }
  for (const f of ["src/lib/orderSweeps.js", "src/lib/bookRequests.js", "src/lib/legalText.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src.replace(/legal\.shop\w+\([^)]*\)/g, ""), /Rue Peyrolière|rue Peyrolière|10:00|14:00|19:00|10 h|14 h/, `${f}: no literal street or hours`);
  }
});

test("the membership price: empty by default (nothing shown), formatted for each language once set", () => {
  assert.equal(legal.MEMBERSHIP_PRICE_EUR, "");
  assert.equal(legal.membershipPrice("en"), "");
  assert.equal(legalText.legalFor("en").membershipPrice, "");
  withConstants({ MEMBERSHIP_PRICE_EUR: "20" }, () => {
    assert.equal(legal.membershipPrice("en"), "€20.00");
    assert.equal(legal.membershipPrice("fr"), `20,00${NB}€`);
    assert.equal(legalText.fillVat({ p: "Cotisation {membershipPrice}" }, "fr").p, `Cotisation 20,00${NB}€`);
  });
  withConstants({ MEMBERSHIP_PRICE_EUR: 15 }, () => assert.equal(legal.membershipPrice("en"), "€15.00"));
  const page = view("marketing/membership.ejs");
  assert.match(page, /legalText\.membershipPrice/, "the page reads the constant");
  assert.match(page, /"mem\.price": "Membership fee: <strong>\{membershipPrice\}<\/strong>/);
});

test("legal-todos.md lists the constants that still need a real value", () => {
  const todos = fs.readFileSync(path.join(root, "..", "docs/legal-todos.md"), "utf8");
  assert.match(todos, /give the shop street number/i);
  assert.match(todos, /SHOP_STREET_NUMBER/);
  assert.match(todos, /set the membership price constant/i);
  assert.match(todos, /MEMBERSHIP_PRICE_EUR/);
  assert.match(todos, /courts|juridictions compétentes en vertu du droit de la consommation/);
  assert.match(todos, /CM2C/);
});

test("French polish: second-hand, 'Young Adult' translated, favorites text, CGV wording", () => {
  assert.doesNotMatch(view("marketing/privacy-policy.ejs"), /secondhand/);
  assert.doesNotMatch(view("marketing/books.ejs").split("const pageI18nFr")[1], /"g\.ya": "Young Adult"/);
  assert.match(view("marketing/books.ejs").split("const pageI18nFr")[1], /"g\.ya": "Jeune adulte"/);
  const fav = fs.readFileSync(path.join(root, "public/favorites-page.js"), "utf8");
  assert.match(fav, /pour l’instant\\u00a0: parcourez/);
  assert.match(fav, /pour le moment\\u00a0: essayez/);
  assert.doesNotMatch(fav, /pour l’instant : |pour le moment : /);
  assert.match(fav, /frApos\(b\.title\)/, "the French aria-label uses a curly apostrophe");
  assert.match(fs.readFileSync(path.join(root, "src/lib/orderSweeps.js"), "utf8"), /Nos conditions générales de vente \(CGV\) vous/);
});

test("favorites page: the French aria-label turns a straight apostrophe in the title into a curly one", () => {
  const src = fs.readFileSync(path.join(root, "public/favorites-page.js"), "utf8");
  const vm = require("node:vm");
  const listEl = { innerHTML: "", querySelectorAll: () => [], addEventListener() {} };
  const ctx = {
    document: { getElementById: () => listEl, documentElement: { lang: "fr" }, addEventListener() {} },
    window: { UmasFavorites: { get: () => [], sync() {} } },
    fetch: () => new Promise(() => {}),
    Intl, Number, String,
  };
  vm.runInNewContext(src, ctx);
  // The page renders the list through render(); call it by listening to the favoritechange path is
  // overkill: re-run with a fetch that returns one book.
  const ctx2 = { ...ctx, window: { UmasFavorites: { get: () => [1], sync() {} } }, fetch: () => Promise.resolve({ json: () => Promise.resolve([{ id: 1, title: "L'Étranger", url: "/books/1", price: 5, inStockCount: 1 }]) }) };
  vm.runInNewContext(src, ctx2);
  return new Promise((resolve) => setTimeout(() => {
    assert.match(listEl.innerHTML, /aria-label="Ajouter L’Étranger aux favoris"/);
    resolve();
  }, 20));
});
