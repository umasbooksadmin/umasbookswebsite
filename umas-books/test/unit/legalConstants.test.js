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
  assert.match(legalText.PICKUP.fr, /, rue Peyrolière, Albi\.$/);
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

test("the opening hours come from ONE constant: 10:00–19:00 in English, 10 h–19 h (no-break spaces) in French", () => {
  assert.equal(legal.SHOP_HOURS_EN, "10:00–19:00");
  assert.equal(legal.SHOP_HOURS_FR, `10${NB}h–19${NB}h`);
  assert.equal(legal.shopHours("en"), legal.SHOP_HOURS_EN);
  assert.equal(legal.shopHours("fr"), legal.SHOP_HOURS_FR);
  assert.equal(legalText.fillVat({ h: "{shopHours}" }, "fr").h, `10${NB}h–19${NB}h`);
  assert.equal(legalText.fillVat({ h: "{shopHours}" }).h, "10:00–19:00");
  assert.match(legalText.PICKUP.fr, new RegExp(`10${NB}h–19${NB}h`));
  assert.match(legalText.PICKUP.en, /10:00–19:00/);
  // Machine format for structured data.
  assert.equal(legal.SHOP_OPENS, "10:00");
  assert.equal(legal.SHOP_CLOSES, "19:00");
});

test("no page or email we own keeps its own copy of the hours or the street", () => {
  const files = ["marketing/visit.ejs", "marketing/volunteer.ejs", "marketing/mentions-legales.ejs", "marketing/index.ejs", "cart_return.ejs"];
  for (const f of files) {
    const src = view(f);
    assert.doesNotMatch(src, /10:00|19:00|10h00|10 h à 19 h|de 10h à 19h/, `${f}: hours come from SHOP_HOURS_*`);
    assert.doesNotMatch(src.replace(/legalText\.shop\w+/g, ""), /Rue Peyrolière|Rue Peyroli&egrave;re|rue Peyrolière/, `${f}: street comes from shopStreet()`);
  }
  for (const f of ["src/lib/orderSweeps.js", "src/lib/bookRequests.js", "src/lib/legalText.js"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src.replace(/legal\.shop\w+\([^)]*\)/g, ""), /Rue Peyrolière|rue Peyrolière|10:00|19:00|10 h/, `${f}: no literal street or hours`);
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
  assert.match(view("marketing/books.ejs").split("const pageI18nFr")[1], /"g\.ya": "Jeunes adultes"/);
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
