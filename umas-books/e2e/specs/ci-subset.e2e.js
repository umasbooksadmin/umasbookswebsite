// The CI-sized subset of the guest steps: the Browse Books carousel (G91), the genre list's Show more (G93) and a collection page's Show more (G97a), on a throwaway
// app seeded by e2e/ci.js with 130 New In books (crossing the carousel's batch boundary of 60 twice) that are all Fiction.
// Run with `npm run e2e:ci` (CI does, in the smoke-crawl job, after the crawl). The full G91 (230 books, three widths, both
// languages, 150 clicks) takes about ten minutes; this variant keeps every kind of check (whole cards at rest, arrows, keys,
// swipes, the double click, batches arriving, the end state, the same books in the same order as the API) with fewer
// iterations, at 375 px (a phone, swipes) and 1280 px (arrows and keys), in English. A failure message says what was on
// screen: which width, which step, which card was cut and by how many pixels.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { carouselState, carouselSettled, allNewIn, assertAtRest, assertCarouselIsWholeNewestFirstList } = require("../helpers/carousel");
const cfg = require("../helpers/config");

const s = e2e.persona("guest");
const BATCH = 60; // public/page-books.js NEW_IN_BATCH

s.test("CI-G91 the New In carousel reaches every new book across the batch boundary of 60, whole cards at rest, arrows, keys, swipes and the true end (375 px and 1280 px)", { timeout: 240000 }, async (ctx) => {
  await ctx.page.setCookie({ name: "umasbooks_lang", value: "en", url: cfg.baseUrl() });
  const total = (await allNewIn()).total;
  if (total <= BATCH) ctx.skip(`data: needs more than ${BATCH} New In books to cross a batch boundary, the site has ${total}`);
  for (const [width, height, touch] of [[375, 812, true], [1280, 800, false]]) {
    await ctx.page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: touch, hasTouch: touch });
    await ctx.goto("/books.html", "networkidle2");
    await ctx.page.waitForSelector("#bk-new-track .bk-book", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 400));
    const where = `${width} px`;
    let st = await carouselState(ctx.page);
    assertAtRest(st, `${where} at the start`);
    assert.equal(st.prevDisabled, true, `${where}: Previous is disabled at the start`);
    assert.ok(st.count <= BATCH, `${where}: only the first batch (${BATCH}) is loaded at the start, not all ${total} (${st.count} cards)`);
    assert.equal(st.nextDisabled, false, `${where}: Next is not greyed out while more batches remain`);

    if (touch) {
      // a finger: swipe left across the track (about two cards wide), then fling to the end; each fling loads the next batch
      for (let n = 1; n <= 6; n++) {
        // instant, not smooth: with a published collection above New In the track starts below the fold, and a smooth scroll still under way would
        // leave the touch point off the screen
        const box = await ctx.page.$eval("#bk-new-track", (t) => { t.closest(".bk-new").scrollIntoView({ behavior: "instant", block: "start" }); const r = t.getBoundingClientRect(); return { x: r.left + r.width * 0.95, y: r.top + 60, w: r.width }; });
        const before = st.scrollLeft;
        await ctx.page.touchscreen.touchStart(box.x, box.y);
        for (let k = 1; k <= 8; k++) await ctx.page.touchscreen.touchMove(box.x - (box.w * 0.85 * k) / 8, box.y);
        await ctx.page.touchscreen.touchEnd();
        await carouselSettled(ctx.page);
        st = await carouselState(ctx.page);
        assertAtRest(st, `${where} after swipe ${n}`);
        assert.ok(st.scrollLeft > before, `${where}: swipe ${n} did not move the row (it is at ${st.scrollLeft}, was ${before})`);
      }
      for (let n = 0; n < 40 && !(await carouselState(ctx.page)).nextDisabled; n++) {
        await ctx.page.$eval("#bk-new-track", (t) => t.scrollTo({ left: t.scrollWidth }));
        await carouselSettled(ctx.page);
        st = await carouselState(ctx.page);
        assertAtRest(st, `${where} after fling ${n + 1} (${st.count} of ${total} cards)`);
        if (st.count < total) assert.equal(st.nextDisabled, false, `${where}: Next is greyed out with only ${st.count} of ${total} books loaded`);
      }
    } else {
      // the keyboard at the start: Right moves one card at a time and lands on a card edge
      await ctx.page.focus("#bk-new-track .bk-book > a");
      for (let n = 1; n <= 4; n++) {
        await ctx.page.keyboard.press("ArrowRight");
        await carouselSettled(ctx.page);
        assertAtRest(await carouselState(ctx.page), `${where} after ArrowRight ${n}`);
      }
      // the mouse: a click, or two quick clicks, all the way to the end (the batches arrive on the way)
      let crossed = false;
      for (let n = 1; n <= 80 && !(await carouselState(ctx.page)).nextDisabled; n++) {
        const before = (await carouselState(ctx.page)).scrollLeft;
        await ctx.page.click("#bk-new-next");
        if (n % 3 === 0) await ctx.page.click("#bk-new-next");
        await carouselSettled(ctx.page);
        st = await carouselState(ctx.page);
        assertAtRest(st, `${where} after click ${n}`);
        assert.ok(st.scrollLeft >= before - 1, `${where}: the row jumped back after click ${n} (${st.scrollLeft} < ${before})`);
        if (st.count > BATCH) crossed = true;
        if (st.count < total) assert.equal(st.nextDisabled, false, `${where}: Next is greyed out with only ${st.count} of ${total} books loaded (click ${n})`);
      }
      assert.ok(crossed, `${where}: clicking Next past the first ${BATCH} books loaded the next batch`);
    }

    // the true end: every new book is on the shelf, newest first, once each, and only now is Next disabled
    st = await carouselState(ctx.page);
    assert.equal(st.nextDisabled, true, `${where}: Next is disabled on the last page (${st.count} of ${total} cards loaded)`);
    assert.equal(st.count, total, `${where}: the carousel ended with ${st.count} of ${total} books`);
    await assertCarouselIsWholeNewestFirstList(ctx, where);
    assert.equal(await ctx.page.$$eval("#bk-new-track .bk-book", (c) => new Set(c.map((x) => x.querySelector("a").getAttribute("href"))).size), total, `${where}: no book twice`);

    if (!touch) {
      // back with Previous, a few pages, then the keyboard, and the arrow is tap-sized
      for (let n = 0; n < 6 && !(await carouselState(ctx.page)).prevDisabled; n++) {
        await ctx.page.click("#bk-new-prev");
        await carouselSettled(ctx.page);
        assertAtRest(await carouselState(ctx.page), `${where} after Previous ${n + 1}`);
      }
      const arrow = await ctx.page.$eval("#bk-new-next", (b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(arrow.w >= 44 && arrow.h >= 44, `${where}: the arrow is ${arrow.w}x${arrow.h}, under 44x44`);
    }
  }
  await ctx.page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
});

s.test("CI-G93 a genre list pages with Show more until every book is shown, with no count line (genre click and direct load)", { timeout: 120000 }, async (ctx) => {
  const visible = (sel) => ctx.page.evaluate((q) => { const e = document.querySelector(q); return !!e && !e.hidden && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);
  const grid = () => ctx.page.$$eval("#bk-results-grid .bk-book > a", (as) => as.map((a) => Number((a.getAttribute("href").match(/books\/(\d+)/) || [])[1])));
  await ctx.page.setCookie({ name: "umasbooks_lang", value: "en", url: cfg.baseUrl() });
  const first = await e2e.getJson("/api/books/search?topic=fiction&paged=1&offset=0&limit=24");
  if (!first || first.total <= 24) ctx.skip(`data: needs more than 24 Fiction books to need a second page, the site has ${first && first.total}`);
  for (const direct of [false, true]) {
    await ctx.goto(direct ? "/books.html?genre=fiction" : "/books.html", "networkidle2");
    if (!direct) { await ctx.page.waitForSelector("#bk-genre-list .bk-genre"); await ctx.page.click("#bk-genre-list .bk-genre"); }
    await ctx.page.waitForFunction(() => document.querySelectorAll("#bk-results-grid .bk-book").length > 0);
    const where = direct ? "direct load" : "genre click";
    assert.equal((await grid()).length, 24, `${where}: the first page is 24 books`);
    assert.equal(await ctx.page.$$eval("#bk-results-count", (e) => e.length), 0, `${where}: no count line on a genre list`);
    assert.equal(await visible("#bk-more"), true, `${where}: Show more is there`);
    for (let i = 0; i < 60 && (await visible("#bk-more")); i++) {
      const before = (await grid()).length;
      await ctx.page.click("#bk-more");
      await ctx.page.waitForFunction((n) => document.querySelectorAll("#bk-results-grid .bk-book").length > n, { timeout: 8000 }, before);
      const focusedIsFirstNew = await ctx.page.evaluate((n) => document.activeElement === document.querySelectorAll("#bk-results-grid .bk-book > a")[n], before);
      assert.equal(focusedIsFirstNew, true, `${where}: focus moves to the first newly added book (after Show more ${i + 1})`);
    }
    const ids = await grid();
    assert.equal(ids.length, first.total, `${where}: every Fiction book is reachable (${first.total}), the grid has ${ids.length}`);
    assert.equal(new Set(ids).size, ids.length, `${where}: no book twice`);
    assert.equal(await visible("#bk-more"), false, `${where}: no Show more once everything is shown`);
  }
});

s.test("CI-G97a a collection page pages like the genre results: 24 books, Show more adds the rest (30), focus on the first new book, then no button", { timeout: 60000 }, async (ctx) => {
  await ctx.page.setCookie({ name: "umasbooks_lang", value: "en", url: cfg.baseUrl() });
  await ctx.goto("/books.html", "networkidle2");
  const href = await ctx.page.$eval("#bk-collections .col-btn", (a) => a.getAttribute("href"));
  await ctx.goto(href, "networkidle2");
  const count = () => ctx.page.$$eval("#bk-results-grid .bk-book", (e) => e.length);
  assert.equal(await count(), 24, "the first page is 24 books");
  assert.equal(await ctx.page.$eval("#bk-more", (b) => !b.hidden), true, "Show more is there");
  await ctx.page.click("#bk-more");
  await ctx.page.waitForFunction(() => document.querySelectorAll("#bk-results-grid .bk-book").length === 30, { timeout: 8000 });
  assert.equal(await ctx.page.evaluate(() => document.activeElement === document.querySelectorAll("#bk-results-grid .bk-book > a")[24]), true, "focus is on the first new book");
  assert.equal(await ctx.page.$eval("#bk-more", (b) => b.hidden), true, "no Show more after the last book");
  const ids = await ctx.page.$$eval("#bk-results-grid .bk-book > a", (a) => a.map((x) => x.getAttribute("href")));
  assert.equal(new Set(ids).size, 30, "each book once");
});

s.test("CI-G102 keyboard: few Tab stops through the New In row (arrows first, off-screen books skipped), a skip link on focus, and Next keeps focus at the end", { timeout: 120000 }, async (ctx) => {
  await ctx.page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await ctx.page.setCookie({ name: "umasbooks_lang", value: "en", url: cfg.baseUrl() });
  await ctx.goto("/books.html", "networkidle2");
  await ctx.page.waitForSelector("#bk-new-track .bk-book", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 400));
  await ctx.page.focus("#bk-new-all");
  const names = [];
  for (let i = 0; i < 40; i++) {
    await ctx.page.keyboard.press("Tab");
    const id = await ctx.page.evaluate(() => { const e = document.activeElement; return e && e.id ? e.id : e ? e.className || e.tagName : "none"; });
    names.push(id);
    if (id === "bk-genre-prev") break;
  }
  assert.equal(names[0], "bk-skip", `the skip link is the first stop after See All (${names.slice(0, 4).join(" ")})`);
  assert.deepEqual(names.slice(1, 3), ["bk-new-prev", "bk-new-next"], "the arrows come before the books");
  // Only the books in view are stops (public/carousel.js roving tabindex): each has its heart, its link and, when it can be bought
  // online, its cart icon (src/lib/cardCart.js), so at most 3 per book in view (6 at most at this width) plus the 5 stops around them.
  const booksStopped = names.filter((n) => n === "A").length;
  assert.ok(booksStopped >= 1 && booksStopped <= 6, `only the books in view are Tab stops (${booksStopped})`);
  assert.ok(names.includes("bk-genre-prev") && names.length <= 5 + 3 * booksStopped, `at most heart, link and cart icon per book in view (${names.length}: ${names.join(" ")})`);
  assert.ok(names.length < 25, `fewer than 25 Tab presses to pass the New In row (${names.length})`);
  await ctx.page.focus("#bk-new-next");
  for (let i = 0; i < 150; i++) {
    await ctx.page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 100));
    if (await ctx.page.$eval("#bk-new-next", (b) => b.getAttribute("aria-disabled") === "true")) break;
  }
  const end = await ctx.page.evaluate(() => ({ id: document.activeElement && document.activeElement.id, ad: document.getElementById("bk-new-next").getAttribute("aria-disabled"), dis: document.getElementById("bk-new-next").disabled }));
  assert.deepEqual(end, { id: "bk-new-next", ad: "true", dis: false }, "focus stays on Next at the end of the row");
});
