// Helpers for the New In carousel steps (G91 in specs/guest.e2e.js, and its CI-sized variant in specs/ci-subset.e2e.js):
// where the carousel is at rest, when it has stopped moving, the whole New In list from the API, and the "never a cut-off
// card" assertions. They run inside the page (puppeteer) against the real Browse Books page.
const assert = require("node:assert/strict");
const e2e = require("./harness");

// Text inside a New In card that may be wider or taller than its box, with the reason. Empty on purpose: the titles, authors and
// prices all wrap (a very long word breaks), so nothing is clipped; add a line here only with a reason.
const CAROUSEL_TEXT_ALLOW = [];

// where the carousel is at rest: which cards are in view and whether any is cut by the edge of the box
async function carouselState(page) {
  return page.evaluate((allow) => {
    const tr = document.getElementById("bk-new-track");
    const T = tr.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(tr).paddingLeft) || 0;
    const left = T.left + pad - 1, right = T.right - pad + 1; // the box inside its padding (1px for rounding)
    const cards = [...tr.querySelectorAll(".bk-book")].map((c, i) => ({ i, r: c.getBoundingClientRect(), c }));
    const inView = cards.filter((x) => x.r.right > left + 1 && x.r.left < right - 1);
    const cut = inView.filter((x) => x.r.left < left - 0.5 || x.r.right > right + 0.5).map((x) => `card ${x.i} (${Math.round(x.r.left - T.left)}..${Math.round(x.r.right - T.left)} in a box of ${Math.round(T.width)})`);
    const clipped = [];
    for (const x of cards) for (const el of x.c.querySelectorAll(".t, .a, .p")) {
      if (allow.some((a) => el.matches(a.selector))) continue;
      if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) clipped.push(`card ${x.i} .${el.className}: "${el.textContent.slice(0, 30)}"`);
      const cs = getComputedStyle(el);
      if (cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none") clipped.push(`card ${x.i} .${el.className} is ellipsized or line-clamped`);
    }
    const first = inView[0];
    return {
      count: cards.length, scrollLeft: tr.scrollLeft, cut, clipped,
      firstOffset: first ? Math.round((first.r.left - T.left - pad) * 10) / 10 : null,
      // the arrows are aria-disabled (never `disabled`, so a focused arrow keeps focus at the end of the row)
      prevDisabled: document.getElementById("bk-new-prev").getAttribute("aria-disabled") === "true", nextDisabled: document.getElementById("bk-new-next").getAttribute("aria-disabled") === "true",
      docWider: document.documentElement.scrollWidth > innerWidth + 1,
    };
  }, CAROUSEL_TEXT_ALLOW);
}
// wait until the scrolling has stopped and no batch is being fetched (the Next arrow pulses while it is)
async function carouselSettled(page) {
  let last = -1, still = 0;
  for (let i = 0; i < 80 && still < 4; i++) {
    const now = await page.$eval("#bk-new-track", (t) => `${t.scrollLeft}/${t.querySelectorAll(".bk-book").length}/${document.getElementById("bk-new-next").classList.contains("is-loading")}`);
    still = now === last && !now.endsWith("true") ? still + 1 : 0;
    last = now;
    await new Promise((r) => setTimeout(r, 100));
  }
}
// the whole New In list from the API, the way the carousel gets it: batches (the API gives at most 100 at a time)
async function allNewIn() {
  const books = [];
  let total = null;
  for (let next = 0, guard = 0; next != null && guard < 400; guard++) {
    const page = await e2e.getJson(`/api/books/new-in?offset=${next}&limit=100`);
    if (!page) break;
    total = page.total;
    books.push(...page.books);
    next = page.nextOffset;
  }
  return { total: total || 0, books };
}
function assertAtRest(st, where) {
  assert.deepEqual(st.cut, [], `${where}: a card is cut by the edge of the carousel when it stops: ${st.cut.join("; ")}`);
  assert.ok(st.firstOffset != null && Math.abs(st.firstOffset) <= 2, `${where}: the first card in view starts ${st.firstOffset} px from the left edge (should be 0)`);
  assert.deepEqual(st.clipped, [], `${where}: clipped text: ${st.clipped.join("; ")}`);
  assert.equal(st.docWider, false, `${where}: the page scrolls sideways`);
}

// The carousel reaches EVERY New In book, newest first, loading them in batches of 60 as the guest nears the end: once the end is
// reached it holds the same books in the same order as the API, however many there are.
// On the local site the seed adds books at known times (E2E Sample New In <n> = 1..30 added in turn, then Bulk <k>, k minutes x 7 ago),
// so the time order can be checked from the titles too.
async function assertCarouselIsWholeNewestFirstList(ctx, where) {
  const api = await allNewIn();
  if (!api.total) ctx.skip("data: the site has no New In books");
  const cards = await ctx.page.$$eval("#bk-new-track .bk-book a", (as) => as.map((a) => ({ id: Number((a.getAttribute("href").match(/books\/(\d+)/) || [])[1]), t: a.querySelector(".t").textContent })));
  assert.equal(cards.length, api.total, `${where}: the carousel has a card for every new book (${api.total}), not just the first page`);
  assert.deepEqual(cards.map((c) => c.id), api.books.map((b) => b.id), `${where}: the carousel order is the API order (newest added first)`);
  const bulk = cards.map((c) => (c.t.match(/New In Bulk (\d+)/) || [])[1]).filter(Boolean).map(Number);
  if (bulk.length) {
    assert.deepEqual(bulk, [...bulk].sort((a, b) => a - b), `${where}: books added the same day are in time order (Bulk 1 is the newest)`);
    const firstBulk = cards.findIndex((c) => /New In Bulk /.test(c.t));
    const plain = cards.map((c, i) => ({ i, n: Number((c.t.match(/New In (\d+)/) || [])[1]) })).filter((x) => x.n > 0 && !/Bulk/.test(cards[x.i].t));
    assert.ok(plain.every((x) => x.i < firstBulk), `${where}: the books added a moment ago come before the older ones`);
    assert.deepEqual(plain.map((x) => x.n), plain.map((x) => x.n).sort((a, b) => b - a), `${where}: the most recently added is first`);
  }
}

module.exports = { CAROUSEL_TEXT_ALLOW, carouselState, carouselSettled, allNewIn, assertAtRest, assertCarouselIsWholeNewestFirstList };
