/* global document, getComputedStyle, innerWidth */
// Browse Books on a touch phone, in a REAL browser (headless Chrome through puppeteer, touch emulated) against the real app
// and a throwaway database:
//   - the New In, Browse by Genre and Browse by Collection carousels show their arrows (they used to be hidden on a touch
//     phone), as round buttons over the ends of the track that work with a tap, and swiping still moves the row,
//   - the arrows take no room from the cards: a New In card is exactly as wide as the track allows with no arrow columns
//     (two arrow columns squeezed it to about 90 px), and they sit on the middle of the covers, clear of the heart,
//   - the results grids (genre results, See All New In, a collection page) show two books per row from 320 px up,
//   - no sideways page scrolling at 320 and 375 px.
// Skipped (with a message) when no Chrome can be started on this computer.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 6494;
let app;
let pool;
let browser;
let skipReason = null;
let colSlug;

before(async () => {
  try {
    const puppeteer = require("puppeteer");
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
    return;
  }
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // Twelve new Fiction books in stock (New In needs more than one page; the genre grid needs more than one row), one with a
  // long price, all in every published collection.
  const { rows } = await pool.query(
    `INSERT INTO books (title, authors, categories, categories_fr)
     SELECT 'Phone Arrow Book ' || g, 'Author ' || g, 'Fiction', 'Fiction' FROM generate_series(1, 12) g RETURNING id`);
  for (const [i, b] of rows.entries()) {
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', $2, 'good')", [b.id, i === 0 ? 12.5 : 4]);
  }
  const { rows: cols } = await pool.query("SELECT id, slug FROM curated_collections ORDER BY sort_order, id LIMIT 8");
  colSlug = cols[0].slug;
  for (const c of cols) {
    for (const [i, b] of rows.entries()) {
      await pool.query("INSERT INTO curated_collection_books (collection_id, book_id, status, position) VALUES ($1, $2, 'approved', $3)", [c.id, b.id, i + 1]);
    }
  }
  await pool.query("UPDATE curated_collections SET published = TRUE WHERE id = ANY($1)", [cols.map((c) => c.id)]);
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
});

const phone = (width, height = 800) => ({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

async function withPhone(t, viewport, lang, fn) {
  if (skipReason) return t.skip(skipReason);
  const page = await browser.newPage();
  try {
    await page.setViewport(viewport);
    await page.setCookie({ name: "umasbooks_lang", value: lang, url: app.base });
    await fn(page);
  } finally {
    await page.close();
  }
}
const go = (page, p) => page.goto(`${app.base}${p}`, { waitUntil: "networkidle0" });
const settle = () => new Promise((r) => setTimeout(r, 700));

// What the arrows and the first New In card look like on screen.
function measure(trackSel, prevSel, nextSel) {
  const track = document.querySelector(trackSel), carousel = track.parentElement;
  const rect = (e) => e.getBoundingClientRect();
  const arrow = (sel) => {
    const b = document.querySelector(sel), r = rect(b), cs = getComputedStyle(b);
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      display: cs.display, visibility: cs.visibility, opacity: Number(cs.opacity), pointer: cs.pointerEvents,
      left: r.left, right: r.right, top: r.top, w: r.width, h: r.height, cy: r.top + r.height / 2,
      onTop: !!hit && (hit === b || b.contains(hit)), disabled: b.getAttribute("aria-disabled") === "true",
    };
  };
  return {
    prev: arrow(prevSel), next: arrow(nextSel),
    carouselW: carousel.clientWidth, trackW: rect(track).width, scrollLeft: track.scrollLeft,
    docW: document.documentElement.scrollWidth, vw: innerWidth,
  };
}
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const [width, lang] of [[375, "en"], [320, "fr"]]) {
  test(`${width} px touch phone (${lang}): the New In arrows show over the ends of the row, work with a tap, and the cards keep their width`, async (t) => {
    await withPhone(t, phone(width), lang, async (page) => {
      await go(page, "/books.html");
      await page.waitForSelector("#bk-new-track .bk-book");
      await page.$eval(".bk-new", (e) => e.scrollIntoView({ block: "start", behavior: "instant" }));
      await settle();
      const m = await page.evaluate(measure, "#bk-new-track", "#bk-new-prev", "#bk-new-next");
      // shown, tap-sized, inside the screen
      for (const [name, a] of [["Previous", m.prev], ["Next", m.next]]) {
        assert.notEqual(a.display, "none", `${name} is displayed on a touch phone`);
        assert.equal(a.visibility, "visible", `${name} is visible`);
        assert.ok(a.w >= 44 && a.h >= 44, `${name} is ${a.w}x${a.h}, under 44x44`);
        assert.ok(a.left >= 0 && a.right <= m.vw, `${name} is inside the screen (${a.left}-${a.right})`);
      }
      assert.equal(m.next.opacity, 1, "Next is fully shown at the start");
      assert.equal(m.next.onTop, true, "nothing covers Next: a tap reaches it");
      assert.equal(m.prev.disabled, true, "Previous is aria-disabled at the start");
      assert.equal(m.prev.opacity, 0, "Previous fades out at the start");
      assert.equal(m.prev.pointer, "none", "a tap at the faded Previous reaches the book under it");
      assert.equal(m.docW, m.vw, `no sideways page scrolling (${m.docW} px on a ${m.vw} px screen)`);

      // the arrows take no room: the track is the whole row and a card is (track - padding - gap) / 2, as with no arrows
      const card = await page.$eval("#bk-new-track .bk-book", (c) => {
        const t = c.parentElement, cs = getComputedStyle(t);
        const inner = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const cover = c.querySelector(".cover").getBoundingClientRect();
        const hearts = [...t.querySelectorAll(".favorite-toggle")].map((h) => { const r = h.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
        const carts = [...t.querySelectorAll(".bk-book .p > *")].map((h) => { const r = h.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
        return { w: c.getBoundingClientRect().width, inner, gap: parseFloat(cs.columnGap), coverCy: cover.top + cover.height / 2, hearts, carts };
      });
      assert.ok(Math.abs(m.trackW - m.carouselW) <= 1, `the track is the whole row (${m.trackW} of ${m.carouselW} px): the arrows take no column`);
      assert.ok(Math.abs(card.w - (card.inner - card.gap) / 2) <= 0.5, `a card is ${card.w} px, half the track (${(card.inner - card.gap) / 2} px)`);
      assert.ok(card.w >= 110, `a card is ${card.w} px wide, squeezed`);
      assert.ok(Math.abs(m.next.cy - card.coverCy) <= 1, `the arrows sit on the middle of the covers (${m.next.cy} vs ${card.coverCy})`);
      const next = { left: m.next.left, right: m.next.right, top: m.next.top, bottom: m.next.top + m.next.h };
      assert.ok(card.hearts.every((h) => !overlaps(next, h)), "Next does not cover a favorite heart");
      assert.ok(card.carts.every((h) => !overlaps(next, h)), "Next does not cover a price line or its cart icon");

      // a tap on Next moves the row a page on; Previous comes back and a tap on it returns to the start
      await page.tap("#bk-new-next");
      await settle();
      const after = await page.evaluate(measure, "#bk-new-track", "#bk-new-prev", "#bk-new-next");
      assert.ok(after.scrollLeft > 0, "a tap on Next moved the row");
      assert.equal(after.prev.disabled, false, "Previous is live once the row has moved");
      assert.equal(after.prev.opacity, 1, "Previous shows once the row has moved");
      assert.equal(after.prev.onTop, true, "nothing covers Previous");
      await page.tap("#bk-new-prev");
      await settle();
      assert.equal(await page.$eval("#bk-new-track", (e) => e.scrollLeft), 0, "a tap on Previous went back to the start");

      // a swipe still moves the row (from the middle of the second cover, away from the arrows)
      const box = await page.$eval("#bk-new-track", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + 60, w: r.width }; });
      await page.touchscreen.touchStart(box.x, box.y);
      for (let k = 1; k <= 8; k++) await page.touchscreen.touchMove(box.x - (box.w * 0.5 * k) / 8, box.y);
      await page.touchscreen.touchEnd();
      await settle();
      assert.ok(await page.$eval("#bk-new-track", (e) => e.scrollLeft) > 0, "a swipe moved the row");
    });
  });

  test(`${width} px touch phone (${lang}): the genre and collection arrows show on the round pictures and work with a tap`, async (t) => {
    await withPhone(t, phone(width), lang, async (page) => {
      await go(page, "/books.html");
      await page.waitForSelector("#bk-genre-list .bk-genre");
      for (const [track, prev, next, chip] of [["#bk-genre-list", "#bk-genre-prev", "#bk-genre-next", "#bk-genre-list .chip"], ["#bk-col-track", "#bk-col-prev", "#bk-col-next", "#bk-col-track .chip"]]) {
        await page.$eval(track, (e) => e.scrollIntoView({ block: "center", behavior: "instant" }));
        await settle();
        const m = await page.evaluate(measure, track, prev, next);
        assert.notEqual(m.next.display, "none", `${next} is displayed`);
        assert.equal(m.next.opacity, 1, `${next} is shown`);
        assert.ok(m.next.w >= 44 && m.next.h >= 44, `${next} is tap-sized`);
        assert.ok(m.next.left >= 0 && m.next.right <= m.vw, `${next} is inside the screen`);
        assert.ok(Math.abs(m.trackW - m.carouselW) <= 1, `${track}: the arrows take no column`);
        const cy = await page.$eval(chip, (c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; });
        assert.ok(Math.abs(m.next.cy - cy) <= 2, `${next} sits on the middle of the round pictures (${m.next.cy} vs ${cy})`);
        await page.tap(next);
        await settle();
        assert.ok(await page.$eval(track, (e) => e.scrollLeft) > 0, `a tap on ${next} moved the row`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways page scrolling");
    });
  });
}

for (const [width, lang] of [[320, "fr"], [360, "en"], [375, "fr"]]) {
  test(`${width} px phone (${lang}): the results grids show two books per row (genre results, See All New In, a collection page)`, async (t) => {
    await withPhone(t, phone(width), lang, async (page) => {
      for (const p of ["/books.html?genre=fiction", "/books.html?new=1", `/collections/${colSlug}`]) {
        await go(page, p);
        await page.waitForSelector("#bk-results-grid .bk-book");
        const g = await page.$eval("#bk-results-grid", (grid) => {
          const tops = [...grid.children].slice(0, 4).map((c) => Math.round(c.getBoundingClientRect().top));
          // every price line: the price, then the cart icon to its right on the same line (the 12.50 one is the longest)
          const clashes = [...grid.querySelectorAll(".bk-book .p")].filter((line) => {
            const range = document.createRange(); range.selectNodeContents(line.firstChild);
            const price = range.getBoundingClientRect(), icon = line.lastElementChild.getBoundingClientRect();
            return price.right > icon.left || icon.top >= price.bottom;
          }).map((line) => line.firstChild.textContent);
          const longest = [...grid.querySelectorAll(".bk-book .p")].some((line) => /12[.,]50/.test(line.firstChild.textContent));
          return { cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length, tops, clashes, longest, docW: document.documentElement.scrollWidth };
        });
        assert.equal(g.cols, 2, `${p}: ${g.cols} columns at ${width} px, want 2`);
        assert.equal(g.tops[0], g.tops[1], `${p}: the first two books share a row`);
        assert.ok(g.tops[2] > g.tops[1], `${p}: the third book starts the second row`);
        assert.equal(g.longest, true, `${p}: the 12.50 book is on the first page`);
        assert.deepEqual(g.clashes, [], `${p}: the cart icon overlaps or drops below these prices`);
        assert.equal(g.docW, width, `${p}: no sideways page scrolling`);
      }
    });
  });
}
