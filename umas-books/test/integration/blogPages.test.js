// The server-rendered blog (src/routes/blogPages.js, views/marketing/blog*.ejs, lib/blogPosts.js) against the real app and a
// throwaway database: the list and each post are in the HTML with no JavaScript, only public posts are shown (an admin's
// ?preview=1 aside), the old ?post= address redirects, French text or the English fallback with its notice, canonical and
// hreflang rules, JSON-LD, the blog sitemap, the JSON feed in both languages, and hostile text. Ports 6531 (live) and 6532
// (PREVIEW_MODE) are reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const SITE = "https://books.example.test";
const PASSWORD = "BlogPages1!Test";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
let app, preview, pool, adminJar;
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const hour = 3600 * 1000;

before(async () => {
  app = await startTestApp({ port: 6531, isolated: true, env: { APP_BASE_URL: SITE } });
  preview = await startTestApp({ port: 6532, isolated: true, env: { APP_BASE_URL: SITE, PREVIEW_MODE: "true" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `blog-pages-${uniq()}@example.test`;
  await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now())", [email, await bcrypt.hash(PASSWORD, 10)]);
  adminJar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, adminJar);
  const res = await fetch(`${app.base}/login`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: adminJar.header() }, body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }) });
  adminJar.capture(res);
  assert.equal(res.status, 302, "admin logs in");
});

after(async () => {
  await pool.end();
  app.stop();
  preview.stop();
});

async function mk(slug, o = {}) {
  await pool.query(
    `INSERT INTO blog_posts (slug, title, excerpt, body, category, status, published_at, image_url, title_fr, excerpt_fr, body_fr, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now()))`,
    [slug, o.title || `Post ${slug}`, o.excerpt === undefined ? `Excerpt of ${slug}` : o.excerpt, o.body || `<p>Body of ${slug}</p>`, o.category || null,
      o.status || "published", o.at === undefined ? new Date(Date.now() - hour) : o.at, o.image || null, o.title_fr || null, o.excerpt_fr || null, o.body_fr || null, o.updated || null]
  );
  return slug;
}
const get = async (p, { fr = false, jar, cookie, base = app.base, manual = true } = {}) => {
  const headers = {};
  const c = [jar && jar.header(), fr && "umasbooks_lang=fr", cookie].filter(Boolean).join("; ");
  if (c) headers.cookie = c;
  const res = await fetch(`${base}${p}`, { redirect: manual ? "manual" : "follow", headers });
  return { res, text: await res.text() };
};
// The sitemap is cached for an hour; any admin POST to /admin/blog drops that copy (routes/admin/blog.js), which is also how
// the site notices a post saved from the editor. Posts written straight into the table by these tests need the same nudge.
async function dropSitemapCache() {
  const token = await fetchCsrfToken(app.base, adminJar);
  const res = await fetch(`${app.base}/admin/blog/bulk`, { method: "POST", redirect: "manual", headers: { ...FORM, cookie: adminJar.header() }, body: new URLSearchParams({ _csrf: token, bulkAction: "", ids: "0" }) });
  adminJar.capture(res);
  assert.equal(res.status, 302);
  await new Promise((r) => setTimeout(r, 50)); // the cache is dropped when the response has finished
}
const meta = (html, attr, key) => { const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html); return m ? m[1] : undefined; };
const canonical = (html) => (/<link rel="canonical" href="([^"]+)"/.exec(html) || [])[1];
const alternates = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
const jsonLd = (html) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
const mainOf = (html) => /<main[\s\S]*?<\/main>/.exec(html)[0];

// ---------------------------------------------------------------- list

test("the list is in the HTML itself: titles, excerpts, dates and real links, newest first, no script needed", async () => {
  const older = await mk(`older-${uniq()}`, { title: "Older list post", at: new Date(Date.now() - 5 * hour) });
  const newer = await mk(`newer-${uniq()}`, { title: "Newer list post", category: "News" });
  const { res, text } = await get("/blog.html");
  assert.equal(res.status, 200);
  const main = mainOf(text);
  assert.ok(main.includes("Newer list post") && main.includes("Older list post"), "titles are in the markup");
  assert.ok(main.indexOf("Newer list post") < main.indexOf("Older list post"), "newest first");
  assert.ok(main.includes(`href="/blog/${newer}"`) && main.includes(`href="/blog/${older}"`), "each card is a real link to the post's own page");
  assert.ok(main.includes(`Excerpt of ${newer}`));
  assert.match(main, /<time datetime="\d{4}-\d{2}-\d{2}">\d{1,2} \w+ \d{4}<\/time>/);
  assert.equal((text.match(/<h1\b/g) || []).length, 1, "one h1");
  assert.ok(!/id="blog-root"><\/div>/.test(text), "not the empty client-rendered shell of before");
  assert.equal((text.match(/<script src="[^"]*blog-live\.js|assets\/blog\.js/g) || []).length, 0, "the old client renderer is not loaded");
  assert.equal(canonical(text), `${SITE}/blog.html`);
  assert.deepEqual(alternates(text), [["en", `${SITE}/blog.html`], ["fr", `${SITE}/fr/blog.html`], ["x-default", `${SITE}/blog.html`]]);
});

test("24 posts a page with real ?page=N links; a later page is its own canonical; a page past the end goes to the last one", async () => {
  const tag = uniq();
  // 26 more posts, so the whole list (with those of the other tests) has at least two pages
  for (let i = 0; i < 26; i++) await mk(`pg-${tag}-${i}`, { title: `Paged ${tag} ${String(i).padStart(2, "0")}`, at: new Date(Date.now() - (100 + i) * hour) });
  const p1 = await get("/blog.html");
  assert.equal((p1.text.match(/<article class="blog-card"/g) || []).length, 24, "24 cards on page 1");
  assert.match(p1.text, /<nav class="blog-pager"/);
  const next = /<a [^>]*rel="next" href="([^"]+)"/.exec(p1.text);
  assert.ok(next && next[1] === "/blog.html?page=2", "a real link to page 2");
  assert.ok(!/rel="prev"/.test(p1.text));
  const p2 = await get("/blog.html?page=2");
  assert.equal(p2.res.status, 200);
  assert.ok((p2.text.match(/<article class="blog-card"/g) || []).length >= 1);
  assert.equal(canonical(p2.text), `${SITE}/blog.html?page=2`, "page 2 is its own canonical, not page 1");
  assert.deepEqual(alternates(p2.text).map((a) => a[1]), [`${SITE}/blog.html?page=2`, `${SITE}/fr/blog.html?page=2`, `${SITE}/blog.html?page=2`]);
  assert.match(p2.text, /rel="prev" href="\/blog\.html"/);
  assert.match(p2.text, /<title[^>]*>Blog — Uma(&#39;|')s Books and Adventures — Page 2<\/title>/);
  const seen = new Set([...p1.text.matchAll(/class="blog-card-link" href="([^"]+)"/g)].map((m) => m[1]));
  for (const m of p2.text.matchAll(/class="blog-card-link" href="([^"]+)"/g)) assert.ok(!seen.has(m[1]), "no post on both pages");
  const far = await get("/blog.html?page=99");
  assert.equal(far.res.status, 302);
  assert.match(far.res.headers.get("location"), /^\/blog\.html\?page=\d+$/);
  for (const junk of ["abc", "0", "-3", "1.5"]) assert.equal((await get(`/blog.html?page=${junk}`)).res.status, 200, `page=${junk} is page 1`);
  const fr2 = await get("/fr/blog.html?page=2");
  assert.ok(fr2.text.includes('rel="prev" href="/fr/blog.html"'), "French pager links stay under /fr/");
});

// ---------------------------------------------------------------- one post

test("a post page has its text in the HTML, its own title, description, canonical, Open Graph, JSON-LD and previous / next links", async () => {
  const tag = uniq();
  const middle = `mid-${tag}`;
  await mk(`before-${tag}`, { title: "Post before", at: new Date(Date.now() - 30 * hour) });
  await mk(middle, {
    title: `Middle ${tag} & friends`, excerpt: "A short summary of the middle post.", category: "Events",
    body: "<p>First <strong>bold</strong> paragraph.</p><ul><li>One</li></ul><p><a href=\"https://example.org/x\">link</a></p>",
    at: new Date(Date.now() - 20 * hour), updated: new Date(Date.now() - 2 * hour),
  });
  await mk(`after-${tag}`, { title: "Post after", at: new Date(Date.now() - 10 * hour) });
  const { res, text } = await get(`/blog/${middle}`);
  assert.equal(res.status, 200);
  const main = mainOf(text);
  assert.ok(main.includes("<strong>bold</strong> paragraph.") && main.includes("<li>One</li>"), "the whole sanitised body is in the HTML");
  assert.equal((text.match(/<h1\b/g) || []).length, 1);
  assert.ok(main.includes(`Middle ${tag} &amp; friends`));
  assert.match(text, new RegExp(`<title[^>]*>Middle ${tag} &amp; friends — Uma(&#39;|')s Books and Adventures</title>`));
  assert.equal(meta(text, "name", "description"), "A short summary of the middle post.");
  assert.equal(canonical(text), `${SITE}/blog/${middle}`);
  assert.equal(meta(text, "property", "og:type"), "article");
  assert.equal(meta(text, "property", "og:url"), `${SITE}/blog/${middle}`);
  assert.equal(meta(text, "name", "twitter:card"), "summary_large_image");
  assert.match(meta(text, "property", "article:published_time"), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(meta(text, "property", "article:section"), "Events");
  assert.match(meta(text, "property", "og:image"), new RegExp(`^${SITE}/`), "an absolute image URL (the default one: this post has no picture)");
  assert.ok(!/<meta name="robots"/.test(text), "a public post is indexable");
  assert.match(main, new RegExp(`rel="prev" href="/blog/before-${tag}"[\\s\\S]*Post before`));
  assert.match(main, new RegExp(`rel="next" href="/blog/after-${tag}"[\\s\\S]*Post after`));

  const ld = jsonLd(text);
  assert.equal(ld["@context"], "https://schema.org");
  const [post, crumbs] = ld["@graph"];
  assert.equal(post["@type"], "BlogPosting");
  assert.equal(post.headline, `Middle ${tag} & friends`);
  assert.equal(post.description, "A short summary of the middle post.");
  assert.equal(post.mainEntityOfPage["@id"], `${SITE}/blog/${middle}`);
  assert.ok(!Number.isNaN(Date.parse(post.datePublished)) && !Number.isNaN(Date.parse(post.dateModified)));
  assert.ok(Date.parse(post.dateModified) >= Date.parse(post.datePublished));
  assert.equal(post.author["@type"], "Organization");
  assert.equal(post.author.name, "Uma's Books and Adventures");
  assert.equal(post.publisher.name, "Uma's Books and Adventures");
  assert.match(post.publisher.logo.url, new RegExp(`^${SITE}/`));
  assert.deepEqual(post.image, [`${SITE}/assets/img/logo-stamp-1280x720.png`], "no picture of its own: the default share image");
  assert.equal(crumbs["@type"], "BreadcrumbList");
  assert.deepEqual(crumbs.itemListElement.map((e) => [e.position, e.name]), [[1, "Home"], [2, "Blog"], [3, `Middle ${tag} & friends`]]);
  assert.equal(crumbs.itemListElement[2].item, `${SITE}/blog/${middle}`);
});

test("a post with a stored picture gets an absolute og:image, a responsive <img> with its size, and no copy of the default share image dimensions", async () => {
  const hash = "a".repeat(64);
  const slug = await mk(`pic-${uniq()}`, { image: `/img/${hash}.jpg` });
  const { text } = await get(`/blog/${slug}`);
  assert.equal(meta(text, "property", "og:image"), `${SITE}/img/${hash}.jpg`);
  assert.ok(!text.includes('og:image:width'), "the default image's 1280x720 is not claimed for this picture");
  assert.match(mainOf(text), new RegExp(`<img src="/img/${hash}\\.jpg" srcset="[^"]*-w300\\.jpg 300w[^"]*" sizes="[^"]+" alt="" width="800" height="500"`));
  const list = await get("/blog.html");
  assert.match(list.text, new RegExp(`<img src="/img/${hash}\\.jpg"[^>]*width="800" height="500"[^>]*loading="lazy"|<img src="/img/${hash}\\.jpg"[^>]*fetchpriority="high"`));
});

test("an old image path (assets/img/...) works and the post without a picture has no <img> in the article", async () => {
  const withOld = await mk(`old-${uniq()}`, { image: "assets/img/shop-interior.jpg" });
  assert.match(mainOf((await get(`/blog/${withOld}`)).text), /<img src="\/assets\/img\/shop-interior\.jpg" alt=""/);
  const none = await mk(`none-${uniq()}`);
  assert.ok(!/<img\b/.test(/<article class="blog-post">[\s\S]*<\/article>/.exec((await get(`/blog/${none}`)).text)[0]));
});

test("an unknown, badly written or hidden slug is a 404 page, never a 500", async () => {
  for (const p of ["/blog/no-such-post", "/blog/Bad_Slug", `/blog/${"a".repeat(300)}`, "/blog/a/b", "/blog/%3Cscript%3E"]) {
    const { res } = await get(p);
    assert.equal(res.status, 404, p);
  }
  assert.ok((await get("/blog/%E0%A4%A")).res.status < 500, "a malformed escape is refused by Express (400), not a 500");
});

// ---------------------------------------------------------------- who can see what

test("drafts, scheduled posts and future-dated posts are never public: not in the list, the post page, the API or the sitemap", async () => {
  const tag = uniq();
  // a draft keeps its old date when an admin moves a published post back to Draft (bulk action): the date has passed, it must still be hidden
  const draft = await mk(`draft-${tag}`, { title: `Hidden draft ${tag}`, status: "draft", at: new Date(Date.now() - 48 * hour) });
  const sched = await mk(`sched-${tag}`, { title: `Hidden scheduled ${tag}`, status: "scheduled", at: new Date(Date.now() + 24 * hour) });
  const future = await mk(`future-${tag}`, { title: `Hidden future ${tag}`, status: "published", at: new Date(Date.now() + 24 * hour) });
  for (const s of [draft, sched, future]) {
    assert.equal((await get(`/blog/${s}`)).res.status, 404, `${s} page`);
    assert.equal((await get(`/fr/blog/${s}`)).res.status, 404, `${s} French page`);
    assert.equal((await fetch(`${app.base}/api/blog/posts/${s}`)).status, 404, `${s} API`);
    assert.equal((await get(`/blog/${s}?preview=1`)).res.status, 404, `${s} ?preview=1 as a visitor`);
    assert.equal((await get(`/blog.html?post=${s}`)).res.status, 301, "the old address redirects, then the page is a 404");
  }
  const list = (await get("/blog.html")).text;
  await dropSitemapCache();
  const sitemap = (await get("/sitemap-blog.xml")).text;
  for (const t of [tag]) {
    assert.ok(!list.includes(t), "not in the list");
    assert.ok(!sitemap.includes(t), "not in the blog sitemap");
  }
  assert.ok(!(await (await fetch(`${app.base}/api/blog/posts?limit=100`)).text()).includes(tag));
});

test("an admin's ?preview=1 shows a draft with a note, noindex, no cache; the list shows it too; a post that is live is unchanged", async () => {
  const tag = uniq();
  const draft = await mk(`pvdraft-${tag}`, { title: `Preview draft ${tag}`, status: "draft", at: null });
  const live = await mk(`pvlive-${tag}`, { title: `Preview live ${tag}` });
  const page = await get(`/blog/${draft}?preview=1`, { jar: adminJar });
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes("Admin preview:") && page.text.includes(`Preview draft ${tag}`));
  assert.equal(meta(page.text, "name", "robots"), "noindex, nofollow");
  assert.equal(page.res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(page.res.headers.get("cache-control"), "no-store");
  assert.ok(!/rel="prev"|rel="next"/.test(page.text), "no previous / next for a post that is not public");
  assert.equal((await get(`/blog/${draft}`, { jar: adminJar })).res.status, 404, "without ?preview=1 even an admin gets the public rule");
  const list = await get("/blog.html?preview=1", { jar: adminJar });
  assert.ok(list.text.includes(`Preview draft ${tag}`) && list.text.includes("Admin preview:"));
  assert.equal(meta(list.text, "name", "robots"), "noindex, nofollow");
  const publicList = await get("/blog.html", { jar: adminJar });
  assert.ok(!publicList.text.includes(`Preview draft ${tag}`), "the plain list is the public list");
  assert.ok((await get(`/blog/${live}?preview=1`, { jar: adminJar })).text.includes(`Preview live ${tag}`));
  const member = await get(`/blog/${draft}?preview=1`);
  assert.equal(member.res.status, 404);
});

// ---------------------------------------------------------------- the old address

test("/blog.html?post=<slug> is a permanent redirect to /blog/<slug> (and /fr/blog/<slug>), keeping ?preview=1", async () => {
  const a = await get("/blog.html?post=welcome");
  assert.equal(a.res.status, 301);
  assert.equal(a.res.headers.get("location"), "/blog/welcome");
  const b = await get("/fr/blog.html?post=welcome");
  assert.equal(b.res.status, 301);
  assert.equal(b.res.headers.get("location"), "/fr/blog/welcome");
  const c = await get("/blog.html?post=Welcome&preview=1");
  assert.equal(c.res.headers.get("location"), "/blog/welcome?preview=1", "case is folded; preview is kept");
  assert.equal((await get("/blog.html?post=bad%20slug")).res.status, 404);
  const d = await get("/blog.html?post=welcome", { fr: true });
  assert.equal(d.res.headers.get("location"), "/blog/welcome", "a permanent redirect does not depend on the language cookie");
  const followed = await get("/blog.html?post=welcome", { manual: false });
  assert.equal(followed.res.status, 200);
  assert.ok(followed.text.includes("Welcome to"));
});

// ---------------------------------------------------------------- French

test("a post with a READY French text: /fr/ shows it, canonical is the French address, hreflang pairs en / fr / x-default; /fr/ list shows French", async () => {
  const slug = await mk(`fr-${uniq()}`, {
    title: "English title of the pair", excerpt: "English excerpt.", body: "<p>English body.</p>",
    title_fr: "Titre français de la paire", excerpt_fr: "Résumé en français.", body_fr: "<p>Corps en français.</p>",
  });
  const fr = await get(`/fr/blog/${slug}`);
  assert.equal(fr.res.status, 200);
  assert.match(fr.text, /<html lang="fr"/);
  const main = mainOf(fr.text);
  assert.ok(main.includes("Titre français de la paire") && main.includes("Corps en français."));
  assert.ok(!main.includes("English body.") && !main.includes("English title of the pair"));
  assert.ok(!main.includes("n’est disponible qu’en anglais"), "no fallback notice");
  assert.ok(!/<h1 lang="en"|class="blog-post-body" lang="en"/.test(main));
  assert.equal(canonical(fr.text), `${SITE}/fr/blog/${slug}`);
  assert.deepEqual(alternates(fr.text), [["en", `${SITE}/blog/${slug}`], ["fr", `${SITE}/fr/blog/${slug}`], ["x-default", `${SITE}/blog/${slug}`]]);
  assert.equal(meta(fr.text, "name", "description"), "Résumé en français.");
  assert.equal(meta(fr.text, "property", "og:locale"), "fr_FR");
  assert.match(fr.text, /<title[^>]*>Titre français de la paire — /);
  const ld = jsonLd(fr.text)["@graph"];
  assert.equal(ld[0].inLanguage, "fr");
  assert.equal(ld[0].headline, "Titre français de la paire");
  assert.equal(ld[0].mainEntityOfPage["@id"], `${SITE}/fr/blog/${slug}`);
  assert.equal(ld[1].itemListElement[2].item, `${SITE}/fr/blog/${slug}`);
  assert.ok(ld[1].itemListElement[0].item.endsWith("/fr/"));
  // the English address of the same post is still English, canonical to itself, same pair
  const en = await get(`/blog/${slug}`);
  assert.ok(mainOf(en.text).includes("English body."));
  assert.equal(canonical(en.text), `${SITE}/blog/${slug}`);
  assert.deepEqual(alternates(en.text), alternates(fr.text));
  // the French list shows the French title with no English marker
  const list = await get("/fr/blog.html");
  assert.ok(list.text.includes("Titre français de la paire"));
  const card = new RegExp(`<article class="blog-card">\\s*<a class="blog-card-link" href="/fr/blog/${slug}">`);
  assert.match(list.text, card, "a French card is not marked lang=en");
});

test("a post with NO French text: the French address shows the English text, a notice, lang=\"en\", canonical to the English page, hreflang only for what exists", async () => {
  const slug = await mk(`fallback-${uniq()}`, { title: "Only in English", excerpt: "Plain English summary.", body: "<p>Only the English body exists.</p>" });
  const fr = await get(`/fr/blog/${slug}`);
  assert.equal(fr.res.status, 200);
  const main = mainOf(fr.text);
  assert.match(main, /<p class="blog-notice" role="note">Cet article n’est disponible qu’en anglais\.<\/p>/);
  assert.ok(main.includes("Only the English body exists."));
  assert.match(main, /<h1 lang="en">Only in English<\/h1>/);
  assert.match(main, /<div class="blog-post-body" lang="en">/);
  assert.equal(canonical(fr.text), `${SITE}/blog/${slug}`, "canonical points at the English page");
  assert.deepEqual(alternates(fr.text), [["en", `${SITE}/blog/${slug}`], ["x-default", `${SITE}/blog/${slug}`]], "no fr alternate: that version does not exist");
  assert.equal(meta(fr.text, "property", "og:locale"), "en_GB");
  assert.equal(jsonLd(fr.text)["@graph"][0].inLanguage, "en");
  assert.match(fr.text, /<html lang="fr"/, "the page around it is French");
  // the English address has no notice and the same links
  const en = await get(`/blog/${slug}`);
  assert.ok(!en.text.includes("Cet article n’est disponible"));
  assert.deepEqual(alternates(en.text), alternates(fr.text));
  // the French list marks the card: lang="en" on the link and a small EN tag with a spoken explanation
  const list = await get("/fr/blog.html");
  assert.match(list.text, new RegExp(`<a class="blog-card-link" href="/fr/blog/${slug}" lang="en">`));
  assert.match(list.text, /<span class="blog-lang"><span aria-hidden="true">EN<\/span><span class="blog-sr" lang="fr"> Article disponible uniquement en anglais<\/span><\/span>/);
  const enList = await get("/blog.html");
  assert.ok(!enList.text.includes("blog-lang"), "no marker on the English list");
});

test("an unfinished French text (title but no content) is not shown: it is a draft, and the page falls back to English", async () => {
  const slug = await mk(`halffr-${uniq()}`, { title: "Half done", body: "<p>English body.</p>", title_fr: "Moitié faite", body_fr: "<p><br></p>" });
  const fr = await get(`/fr/blog/${slug}`);
  assert.ok(fr.text.includes("Cet article n’est disponible qu’en anglais"));
  assert.ok(!mainOf(fr.text).includes("Moitié faite"));
  assert.equal(canonical(fr.text), `${SITE}/blog/${slug}`);
  const noExcerptFr = await mk(`noexfr-${uniq()}`, { title: "T", excerpt: "Has an English excerpt", title_fr: "Titre", body_fr: "<p>Corps</p>" });
  assert.ok((await get(`/fr/blog/${noExcerptFr}`)).text.includes("Cet article n’est disponible"), "an English excerpt needs a French one before French is shown");
  const noExcerptEn = await mk(`noexen-${uniq()}`, { title: "T2", excerpt: null, title_fr: "Titre2", body_fr: "<p>Corps2</p>" });
  const ok = await get(`/fr/blog/${noExcerptEn}`);
  assert.ok(!ok.text.includes("Cet article n’est disponible"), "no English excerpt: none is needed in French");
  assert.ok(mainOf(ok.text).includes("Corps2"));
});

test("the language cookie picks the language on the unprefixed address too; the canonical follows the text actually shown", async () => {
  const slug = await mk(`cookie-${uniq()}`, { title: "EN cookie post", body: "<p>EN</p>", title_fr: "FR cookie post", excerpt_fr: "x", body_fr: "<p>FR corps</p>" });
  const { text } = await get(`/blog/${slug}`, { fr: true });
  assert.ok(mainOf(text).includes("FR corps"));
  assert.equal(canonical(text), `${SITE}/fr/blog/${slug}`);
  const noFr = await mk(`cookie2-${uniq()}`);
  assert.equal(canonical((await get(`/blog/${noFr}`, { fr: true })).text), `${SITE}/blog/${noFr}`);
});

test("the language switch on a post page points at the same post in the other language", async () => {
  const slug = await mk(`switch-${uniq()}`);
  const en = (await get(`/blog/${slug}`)).text;
  assert.match(en, new RegExp(`<a href="/fr/blog/${slug}" data-lang="fr"`));
  const fr = (await get(`/fr/blog/${slug}`)).text;
  assert.match(fr, new RegExp(`<a href="/blog/${slug}" data-lang="en"`));
});

// ---------------------------------------------------------------- JSON feed

test("the JSON feed and the post endpoint take ?lang=fr: French where ready, English with lang=\"en\" otherwise; the default is unchanged", async () => {
  const ready = await mk(`api-r-${uniq()}`, { title: "API English", excerpt: "API excerpt", body: "<p>API body</p>", title_fr: "API français", excerpt_fr: "API résumé", body_fr: "<p>API corps</p>" });
  const miss = await mk(`api-m-${uniq()}`, { title: "API only EN" });
  const feed = async (q) => (await (await fetch(`${app.base}/api/blog/posts?limit=100${q}`)).json());
  const en = (await feed("")).find((p) => p.slug === ready);
  assert.equal(en.title, "API English");
  assert.equal(en.lang, "en");
  assert.ok(!("body" in en));
  const fr = await feed("&lang=fr");
  const f = fr.find((p) => p.slug === ready);
  assert.deepEqual([f.title, f.excerpt, f.lang], ["API français", "API résumé", "fr"]);
  const m = fr.find((p) => p.slug === miss);
  assert.deepEqual([m.title, m.lang], ["API only EN", "en"], "no French: English, marked en");
  const one = await (await fetch(`${app.base}/api/blog/posts/${ready}?lang=fr`)).json();
  assert.deepEqual([one.title, one.body, one.lang], ["API français", "<p>API corps</p>", "fr"]);
  const oneEn = await (await fetch(`${app.base}/api/blog/posts/${ready}`)).json();
  assert.deepEqual([oneEn.title, oneEn.body, oneEn.lang], ["API English", "<p>API body</p>", "en"]);
  const bogus = (await feed("&lang=de")).find((p) => p.slug === ready);
  assert.equal(bogus.title, "API English", "an unknown language is English");
});

// ---------------------------------------------------------------- sitemap

test("/sitemap-blog.xml lists published posts only: both addresses (with hreflang) when French is ready, the English one alone otherwise; lastmod = updated_at", async () => {
  const tag = uniq();
  const withFr = await mk(`sm-fr-${tag}`, { title_fr: "Titre", excerpt_fr: "Résumé", body_fr: "<p>Corps</p>", updated: new Date("2026-03-04T05:06:07Z") });
  const enOnly = await mk(`sm-en-${tag}`, { updated: new Date("2026-04-05T06:07:08Z") });
  const hidden = await mk(`sm-draft-${tag}`, { status: "draft", at: null });
  await dropSitemapCache();
  const { res, text } = await get("/sitemap-blog.xml");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/xml/);
  const urls = [...text.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const entry = (loc) => urls.find((u) => u.startsWith(`<loc>${loc}</loc>`));
  const frEntry = entry(`${SITE}/blog/${withFr}`);
  assert.ok(frEntry && entry(`${SITE}/fr/blog/${withFr}`), "English and French addresses");
  assert.ok(frEntry.includes("<lastmod>2026-03-04T05:06:07.000Z</lastmod>"));
  for (const [h, href] of [["en", `${SITE}/blog/${withFr}`], ["fr", `${SITE}/fr/blog/${withFr}`], ["x-default", `${SITE}/blog/${withFr}`]]) {
    assert.ok(frEntry.includes(`<xhtml:link rel="alternate" hreflang="${h}" href="${href}"/>`), h);
  }
  const enEntry = entry(`${SITE}/blog/${enOnly}`);
  assert.ok(enEntry.includes("<lastmod>2026-04-05T06:07:08.000Z</lastmod>"));
  assert.ok(!entry(`${SITE}/fr/blog/${enOnly}`), "no French address for a post with no French text");
  assert.ok(!enEntry.includes('hreflang="fr"'), "and no fr alternate");
  assert.ok(enEntry.includes('hreflang="en"') && enEntry.includes('hreflang="x-default"'));
  assert.ok(!text.includes(hidden));
  const index = (await get("/sitemap.xml")).text;
  assert.ok(index.includes(`<loc>${SITE}/sitemap-blog.xml</loc>`));
});

test("PREVIEW_MODE (site before launch): robots Disallow /, empty sitemaps, noindex on the blog; posts are still readable", async () => {
  const slug = `pv-${uniq()}`;
  await pool.query("INSERT INTO blog_posts (slug, title, body, status, published_at) VALUES ($1, 'Preview mode post', '<p>Readable</p>', 'published', now() - interval '1 hour')", [slug]);
  // the preview app has its own database: write the same post there
  const { Client } = require("pg");
  const c = new Client({ connectionString: preview.databaseUrl });
  await c.connect();
  await c.query("INSERT INTO blog_posts (slug, title, body, status, published_at) VALUES ($1, 'Preview mode post', '<p>Readable</p>', 'published', now() - interval '1 hour')", [slug]);
  await c.end();
  const robots = await get("/robots.txt", { base: preview.base });
  assert.equal(robots.text, "User-agent: *\nDisallow: /\n");
  for (const f of ["/sitemap.xml", "/sitemap-pages.xml", "/sitemap-blog.xml"]) {
    const { text } = await get(f, { base: preview.base });
    assert.match(text, /<urlset[^>]*>\s*<\/urlset>/, f);
    assert.ok(!text.includes("<url>") && !text.includes(slug), f);
  }
  const page = await get(`/blog/${slug}`, { base: preview.base });
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes("Readable"));
  assert.equal(page.res.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal((page.text.match(/<meta name="robots" content="noindex, nofollow">/g) || []).length, 1, "exactly one robots tag");
  assert.equal((await get("/blog.html", { base: preview.base })).res.headers.get("x-robots-tag"), "noindex, nofollow");
});

// ---------------------------------------------------------------- hostile text

test("script in a title, excerpt or body is never executed or reflected: escaped in the markup, stripped from the body, \\u003c in JSON-LD", async () => {
  const evil = '<script>alert(1)</script>';
  const slug = await mk(`xss-${uniq()}`, {
    title: `T ${evil} "q" <img src=x onerror=alert(2)>`,
    excerpt: `E ${evil} </script><script>alert(3)</script>`,
    body: `<p onclick="alert(4)">B ${evil}</p><img src=x onerror=alert(5)><a href="javascript:alert(6)">x</a><iframe src="//evil"></iframe><script>alert(7)</script>`,
    title_fr: `FT ${evil}`, excerpt_fr: `FE ${evil}`, body_fr: `<p>FB ${evil}</p><img src=x onerror=alert(8)>`,
  });
  for (const p of [`/blog/${slug}`, `/fr/blog/${slug}`, "/blog.html", "/fr/blog.html"]) {
    const { text } = await get(p);
    assert.ok(!/<script>\s*alert/i.test(text), `${p}: no script element from stored text`);
    // Look at the markup only: scripts removed and quoted attribute values blanked (an escaped title in a <meta> may contain the word onerror= as text).
    const markup = text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/"[^"]*"/g, '""');
    assert.ok(!/<[^>]*\son(error|click|load)\s*=/i.test(markup), `${p}: no event-handler attribute on any element`);
    assert.ok(!/<iframe|<img[^>]*\ssrc=x/i.test(markup), `${p}: no iframe or injected image`);
    assert.ok(!/(href|src)="javascript:/i.test(text), `${p}: no javascript: link`);
    assert.ok(!text.includes("</script><script>alert"), p);
    // every script element left is ours: src=, JSON data, or JSON-LD
    for (const m of text.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /src=|type="application\/(ld\+)?json"/, `${p}: ${m[0]}`);
  }
  const page = (await get(`/blog/${slug}`)).text;
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the title is shown as text");
  assert.ok(!/<meta [^>]*content="[^"]*<script/.test(page), "meta values are attribute-escaped");
  const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(page)[1];
  assert.ok(!raw.includes("<"), "no < inside the JSON-LD");
  assert.equal(JSON.parse(raw)["@graph"][0].headline.includes("<script>"), true, "and it still parses back to the real text");
  const frPage = (await get(`/fr/blog/${slug}`)).text;
  assert.ok(mainOf(frPage).includes("FB "), "the French text is shown, sanitised");
  const api = await (await fetch(`${app.base}/api/blog/posts/${slug}`)).json();
  assert.ok(!/<script|onerror|onclick|javascript:|<iframe/i.test(api.body), "the API body is sanitised on the way out");
});
