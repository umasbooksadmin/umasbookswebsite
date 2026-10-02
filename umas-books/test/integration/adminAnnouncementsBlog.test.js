// Admin announcements and blog screens against the REAL routers + views
// (in-process). Covers the list filters, create/update (publish, draft,
// schedule), validation (missing title/body writes nothing), HTML
// sanitising of the body, image upload/removal, the status machine
// (archive / trash / restore / publish / draft), pin toggle, bulk actions
// (including garbage ids), permanent delete, blog slugs and pagination,
// backQuery redirects, <script> title escaping and the non-admin refusal.
//
// Every list assertion filters with `?q=<unique marker>` so the checks are
// independent of whatever other rows other test files leave in the shared
// CI database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("adminann", ["announcements", "blog"]);
before(h.start);
after(h.stop);

const location = (r) => r.res.headers.get("location");
const annByTitle = async (title) => (await h.q("SELECT * FROM announcements WHERE title = $1", [title]))[0];
const blogByTitle = async (title) => (await h.q("SELECT * FROM blog_posts WHERE title = $1", [title]))[0];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");

async function newAnn(overrides = {}) {
  const title = overrides.title || `Ann ${h.uniq()}`;
  const [{ id }] = await h.q(
    `INSERT INTO announcements (title, body, status, published_at, created_by)
     VALUES ($1, '<p>body</p>', $2, $3, $4) RETURNING id`,
    [title, overrides.status || "published", overrides.status === "draft" ? null : new Date(), h.admin.id]
  );
  return { id, title };
}
async function newPost(overrides = {}) {
  const title = overrides.title || `Post ${h.uniq()}`;
  const [{ id }] = await h.q(
    `INSERT INTO blog_posts (slug, title, body, status, published_at, tags, created_by)
     VALUES ($1, $2, '<p>body</p>', $3, $4, $5, $6) RETURNING id`,
    [`slug-${h.uniq()}`, title, overrides.status || "published", overrides.status === "draft" ? null : new Date(), overrides.tags || null, h.admin.id]
  );
  return { id, title };
}

// ---------- authorization ----------

test("a non-admin member is refused on every announcements and blog route; nothing is written", async () => {
  const ann = await newAnn();
  const post = await newPost();
  const title = `Blocked ${h.uniq()}`;
  const gets = ["/admin/announcements", "/admin/blog"];
  for (const p of gets) {
    assert.equal((await h.get(p, h.member)).res.status, 403, `GET ${p}`);
    const anon = await h.get(p, null);
    assert.equal(anon.res.status, 302);
    assert.equal(location(anon), "/login");
  }
  const attempts = [
    ["/admin/announcements", { title, body: "x" }],
    ["/admin/announcements/bulk", { ids: ann.id, bulkAction: "delete" }],
    [`/admin/announcements/${ann.id}`, { title: "Hacked", body: "x" }],
    [`/admin/announcements/${ann.id}/status`, { action: "trash" }],
    [`/admin/announcements/${ann.id}/pin`, {}],
    [`/admin/announcements/${ann.id}/delete`, {}],
    ["/admin/blog", { title, body: "x" }],
    ["/admin/blog/bulk", { ids: post.id, bulkAction: "delete" }],
    [`/admin/blog/${post.id}`, { title: "Hacked", body: "x" }],
    [`/admin/blog/${post.id}/delete`, {}],
  ];
  for (const [p, fields] of attempts) {
    assert.equal((await h.post(p, fields, { user: h.member })).res.status, 403, `POST ${p}`);
  }
  const a = await annByTitle(ann.title);
  assert.equal(a.status, "published");
  assert.equal(a.is_pinned, false);
  assert.ok(await blogByTitle(post.title));
  assert.equal((await h.q("SELECT 1 FROM announcements WHERE title = $1", [title])).length, 0);
  assert.equal((await h.q("SELECT 1 FROM blog_posts WHERE title = $1", [title])).length, 0);
});

// ---------- announcements: create ----------

test("announcements: publish now stores a sanitised body, category, pin, truncated excerpt and creator", async () => {
  const title = `Publish ${h.uniq()}`;
  const r = await h.post("/admin/announcements", {
    title: `  ${title}  `, body: `<p>Hello <b>world</b></p><script>alert(1)</script><img src=x onerror=alert(2)>`,
    excerpt: "e".repeat(260), category: "Events", pinned: "on", statusAction: "publish",
  });
  assert.equal(r.res.status, 302);
  assert.equal(location(r), "/admin/announcements");
  const a = await annByTitle(title);
  assert.ok(a, "row created with trimmed title");
  assert.equal(a.status, "published");
  assert.ok(a.published_at, "published_at set");
  assert.equal(a.category, "Events");
  assert.equal(a.is_pinned, true);
  assert.equal(a.excerpt.length, 200, "excerpt capped at 200");
  assert.equal(a.created_by, h.admin.id);
  assert.ok(a.body.includes("<b>world</b>"), "allowed tags kept");
  assert.ok(!/script|onerror|<img/i.test(a.body), "script and event-handler markup stripped");
});

test("announcements: draft has no publish date; schedule needs a date or falls back to published; bad category/event ignored", async () => {
  const u = h.uniq();
  await h.post("/admin/announcements", { title: `Draft ${u}`, body: "<p>x</p>", statusAction: "draft", category: "Nonsense" });
  const draft = await annByTitle(`Draft ${u}`);
  assert.equal(draft.status, "draft");
  assert.equal(draft.published_at, null);
  assert.equal(draft.category, null, "unknown category dropped");

  await h.post("/admin/announcements", { title: `Sched ${u}`, body: "<p>x</p>", statusAction: "schedule", scheduledAt: "2031-06-01T09:00", expiresEnabled: "on", expiresAt: "2031-07-01" });
  const sched = await annByTitle(`Sched ${u}`);
  assert.equal(sched.status, "scheduled");
  assert.ok(sched.published_at > new Date(), "scheduled in the future");
  assert.ok(sched.expires_at, "expiry stored when enabled");

  await h.post("/admin/announcements", { title: `SchedNoDate ${u}`, body: "<p>x</p>", statusAction: "schedule" });
  assert.equal((await annByTitle(`SchedNoDate ${u}`)).status, "published", "schedule without a date publishes now");

  await h.post("/admin/announcements", { title: `ExpDisabled ${u}`, body: "<p>x</p>", expiresAt: "2031-07-01" });
  assert.equal((await annByTitle(`ExpDisabled ${u}`)).expires_at, null, "expiry ignored unless enabled");

  const [{ id: eventId }] = await h.q("INSERT INTO events (title, starts_at) VALUES ($1, '2031-06-01T10:00:00Z') RETURNING id", [`Linked ${u}`]);
  await h.post("/admin/announcements", { title: `WithEvent ${u}`, body: "<p>x</p>", eventId });
  assert.equal((await annByTitle(`WithEvent ${u}`)).event_id, eventId);
  const list = await h.get(`/admin/announcements?q=${encodeURIComponent(`WithEvent ${u}`)}`);
  assert.ok(list.text.includes(`Linked ${u}`), "list shows the linked event's title");
  await h.q("DELETE FROM events WHERE id = $1", [eventId]);
  assert.equal((await annByTitle(`WithEvent ${u}`)).event_id, null, "event deletion unlinks");
});

test("announcements: a missing title or body writes nothing and still redirects (keeping backQuery)", async () => {
  const u = h.uniq();
  for (const fields of [
    { title: "", body: "<p>x</p>" },
    { title: `NoBody ${u}`, body: "" },
    { title: `OnlyScript ${u}`, body: "<script>alert(1)</script>" },
    { title: "   ", body: "<p>x</p>" },
  ]) {
    const r = await h.post("/admin/announcements", { ...fields, backQuery: "status=draft" });
    assert.equal(r.res.status, 302);
    assert.equal(location(r), "/admin/announcements?status=draft");
  }
  assert.equal((await h.q("SELECT 1 FROM announcements WHERE title LIKE $1", [`%${u}`])).length, 0);
});

test("announcements: an uploaded image is resized and stored as an /img/ URL; update can replace or remove it", async () => {
  const title = `Image ${h.uniq()}`;
  await h.post("/admin/announcements", { title, body: "<p>x</p>" }, { image: true });
  const a = await annByTitle(title);
  assert.match(a.image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);

  // Updating without a new file and without removeImage keeps it.
  await h.post(`/admin/announcements/${a.id}`, { title, body: "<p>x</p>" });
  assert.equal((await annByTitle(title)).image_url, a.image_url);

  // A new file replaces it.
  await h.post(`/admin/announcements/${a.id}`, { title, body: "<p>y</p>", removeImage: "on" }, { image: true });
  assert.match((await annByTitle(title)).image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);

  await h.post(`/admin/announcements/${a.id}`, { title, body: "<p>x</p>", removeImage: "on" });
  assert.equal((await annByTitle(title)).image_url, null, "removeImage clears it");
});

// ---------- announcements: update / status / pin / delete ----------

test("announcements: update rewrites the fields, can switch to draft, and ignores a blank title/body", async () => {
  const { id, title } = await newAnn();
  const r = await h.post(`/admin/announcements/${id}`, {
    title: `${title} v2`, body: "<p>new</p>", category: "Programs", statusAction: "draft", backQuery: "sort=oldest",
  });
  assert.equal(location(r), "/admin/announcements?sort=oldest");
  let a = (await h.q("SELECT * FROM announcements WHERE id = $1", [id]))[0];
  assert.equal(a.title, `${title} v2`);
  assert.equal(a.category, "Programs");
  assert.equal(a.status, "draft");
  assert.equal(a.published_at, null);
  assert.equal(a.is_pinned, false);

  await h.post(`/admin/announcements/${id}`, { title: "", body: "<p>new</p>" });
  await h.post(`/admin/announcements/${id}`, { title: "Renamed", body: "" });
  a = (await h.q("SELECT * FROM announcements WHERE id = $1", [id]))[0];
  assert.equal(a.title, `${title} v2`, "invalid update leaves the row alone");
});

test("announcements: status machine draft/published/archived/trash/restore, unknown actions ignored", async () => {
  const { id } = await newAnn({ status: "draft" });
  const statusOf = async () => (await h.q("SELECT status, published_at FROM announcements WHERE id = $1", [id]))[0];
  const act = (action, extra = {}) => h.post(`/admin/announcements/${id}/status`, { action, ...extra });

  assert.equal((await statusOf()).published_at, null);
  const r = await act("publish", { backQuery: "status=draft" });
  assert.equal(location(r), "/admin/announcements?status=draft");
  let s = await statusOf();
  assert.equal(s.status, "published");
  assert.ok(s.published_at, "publish stamps published_at");

  const stamp = s.published_at.getTime();
  await act("archive");
  assert.equal((await statusOf()).status, "archived");
  await act("trash");
  assert.equal((await statusOf()).status, "trash");
  await act("restore");
  s = await statusOf();
  assert.equal(s.status, "published", "restore brings it back");
  assert.equal(s.published_at.getTime(), stamp, "restore keeps the original publish date");
  await act("draft");
  assert.equal((await statusOf()).status, "draft");
  await act("explode");
  assert.equal((await statusOf()).status, "draft", "unknown action does nothing");
  await act("");
  assert.equal((await statusOf()).status, "draft");
});

test("announcements: pin toggles; permanent delete removes the row", async () => {
  const { id } = await newAnn();
  const isPinned = async () => (await h.q("SELECT is_pinned FROM announcements WHERE id = $1", [id]))[0].is_pinned;
  const r = await h.post(`/admin/announcements/${id}/pin`, { backQuery: "pinnedOnly=1" });
  assert.equal(location(r), "/admin/announcements?pinnedOnly=1");
  assert.equal(await isPinned(), true);
  await h.post(`/admin/announcements/${id}/pin`);
  assert.equal(await isPinned(), false);

  const del = await h.post(`/admin/announcements/${id}/delete`);
  assert.equal(location(del), "/admin/announcements");
  assert.equal((await h.q("SELECT 1 FROM announcements WHERE id = $1", [id])).length, 0);
});

test("announcements: bulk publish/archive/trash/draft/delete act on exactly the chosen ids; garbage ids and unknown actions do nothing", async () => {
  const a = await newAnn({ status: "draft" });
  const b = await newAnn({ status: "draft" });
  const c = await newAnn({ status: "draft" });
  const status = async (x) => (await h.q("SELECT status FROM announcements WHERE id = $1", [x.id]))[0]?.status;
  const bulk = (bulkAction, ids) => h.post("/admin/announcements/bulk", { bulkAction, ids, backQuery: "status=all" });

  const r = await bulk("publish", [a.id, b.id]);
  assert.equal(location(r), "/admin/announcements?status=all");
  assert.deepEqual([await status(a), await status(b), await status(c)], ["published", "published", "draft"]);
  assert.ok((await h.q("SELECT published_at FROM announcements WHERE id = $1", [a.id]))[0].published_at);

  await bulk("archive", [a.id]);
  assert.equal(await status(a), "archived");
  await bulk("trash", [a.id, b.id]);
  assert.deepEqual([await status(a), await status(b)], ["trash", "trash"]);
  await bulk("draft", a.id); // a single id, not an array
  assert.equal(await status(a), "draft");

  await bulk("publish", ["abc", "-3", "0", "99999999999", ""]);
  await bulk("publish", []);
  await bulk("explode", [c.id]);
  assert.equal(await status(c), "draft", "garbage ids / unknown action leave rows alone");
  assert.equal(await status(b), "trash");

  await bulk("delete", [b.id, "junk"]);
  assert.equal(await status(b), undefined, "bulk delete removes the row");
  assert.equal(await status(a), "draft");
  assert.equal(await status(c), "draft");
});

// ---------- announcements: list ----------

test("announcements: list filters by status, category, search, pinned, date range and sort; trash is hidden from All", async () => {
  const u = h.uniq();
  const mk = async (suffix, cols) => {
    const title = `Filter ${suffix} ${u}`;
    await h.q(
      `INSERT INTO announcements (title, body, status, category, is_pinned, published_at, created_at, created_by)
       VALUES ($1, '<p>b</p>', $2, $3, $4, now(), $5, $6)`,
      [title, cols.status, cols.category || null, !!cols.pinned, cols.createdAt || new Date(), h.admin.id]
    );
    return title;
  };
  const pub = await mk("pub", { status: "published", category: "Events", pinned: true });
  const dra = await mk("dra", { status: "draft", category: "Programs" });
  const tra = await mk("tra", { status: "trash", category: "Events" });
  const old = await mk("old", { status: "published", createdAt: new Date(Date.now() - 400 * 86400000) });
  const q = encodeURIComponent(u);
  const view = async (qs) => (await h.get(`/admin/announcements?q=${q}${qs}`)).text;
  const has = (text, t) => text.includes(esc(t));

  let t = await view("");
  assert.ok(has(t, pub) && has(t, dra) && has(t, old));
  assert.ok(!has(t, tra), "trashed announcements are not in All");
  t = await view("&status=trash");
  assert.ok(has(t, tra) && !has(t, pub));
  t = await view("&status=draft");
  assert.ok(has(t, dra) && !has(t, pub));
  t = await view("&category=Events");
  assert.ok(has(t, pub) && !has(t, dra));
  t = await view("&category=Bogus");
  assert.ok(has(t, pub) && has(t, dra), "unknown category = no category filter");
  t = await view("&pinnedOnly=1");
  assert.ok(has(t, pub) && !has(t, dra));
  t = await view("&dateRange=7d");
  assert.ok(has(t, pub) && !has(t, old));
  t = await view("&dateRange=30d");
  assert.ok(has(t, pub) && !has(t, old));
  t = await view("&dateRange=year");
  assert.ok(has(t, pub));
  t = await view("&sort=oldest");
  assert.ok(has(t, pub));
  t = await view("&status=bogus");
  assert.ok(has(t, pub), "unknown status = all");
  const none = await h.get(`/admin/announcements?q=${encodeURIComponent(`nothing-${u}-zzz`)}`);
  assert.ok(none.text.includes("No announcements match these filters."));
});

test("announcements: ?edit=<id> loads the form for that row (and an unknown id just shows the create form); titles are escaped", async () => {
  const marker = `ann${Date.now()}`;
  const title = `<script>alert('${marker}')</script>`;
  await h.post("/admin/announcements", { title, body: "<p>fine</p>", category: "Donations" });
  const a = await annByTitle(title);

  const list = await h.get(`/admin/announcements?q=${marker}`);
  assert.equal(list.res.status, 200);
  assert.ok(!list.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear in the list");
  assert.ok(list.text.includes(esc(title)));

  const edit = await h.get(`/admin/announcements?edit=${a.id}`);
  assert.ok(edit.text.includes("Edit Announcement"));
  assert.ok(!edit.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear in the edit form");
  assert.ok(edit.text.includes(`value="${esc(title)}"`));

  const missing = await h.get("/admin/announcements?edit=99999999");
  assert.equal(missing.res.status, 200);
  assert.ok(missing.text.includes("Create New Announcement"));
  await h.post(`/admin/announcements/${a.id}/delete`);
});

// ---------- blog ----------

test("blog: create stores trimmed fields, a unique slug (accents stripped, collisions numbered) and the creator", async () => {
  const u = h.uniq();
  const title = `Éveil d'été ${u}`;
  const r = await h.post("/admin/blog", {
    title, body: "<p>Hello</p><script>x()</script>", excerpt: "  short  ", category: "News", tags: " a, b ", status: "published", backQuery: "page=2",
  });
  assert.equal(location(r), "/admin/blog?page=2");
  const p = await blogByTitle(title);
  assert.ok(p);
  assert.ok(p.slug.startsWith("eveil-dete-"), `slug was ${p.slug}`);
  assert.equal(p.excerpt, "short");
  assert.equal(p.tags, "a, b");
  assert.equal(p.category, "News");
  assert.equal(p.status, "published");
  assert.ok(p.published_at);
  assert.equal(p.created_by, h.admin.id);
  assert.ok(!/script/i.test(p.body));

  await h.post("/admin/blog", { title, body: "<p>Again</p>" });
  const slugs = (await h.q("SELECT slug FROM blog_posts WHERE title = $1 ORDER BY id", [title])).map((x) => x.slug);
  assert.equal(slugs.length, 2);
  assert.equal(slugs[1], `${slugs[0]}-2`, "second post with the same title gets -2");

  const bang = "!!!";
  await h.post("/admin/blog", { title: bang, body: "<p>x</p>" });
  const [bangRow] = await h.q("SELECT slug FROM blog_posts WHERE title = $1 ORDER BY id DESC LIMIT 1", [bang]);
  assert.match(bangRow.slug, /^post(-\d+)?$/, "all-punctuation title slugs to 'post'");
  await h.q("DELETE FROM blog_posts WHERE title IN ($1, $2)", [title, bang]);
});

test("blog: status handling — draft has no date, scheduled keeps its publish date, unknown status becomes published", async () => {
  const u = h.uniq();
  await h.post("/admin/blog", { title: `Draft ${u}`, body: "<p>x</p>", status: "draft", publishDate: "2031-01-01", category: "Nope" });
  const draft = await blogByTitle(`Draft ${u}`);
  assert.equal(draft.status, "draft");
  assert.equal(draft.published_at, null);
  assert.equal(draft.category, null);

  await h.post("/admin/blog", { title: `Sched ${u}`, body: "<p>x</p>", status: "scheduled", publishDate: "2031-06-01" });
  const sched = await blogByTitle(`Sched ${u}`);
  assert.equal(sched.status, "scheduled");
  assert.ok(sched.published_at > new Date());

  await h.post("/admin/blog", { title: `Bogus ${u}`, body: "<p>x</p>", status: "archived" });
  assert.equal((await blogByTitle(`Bogus ${u}`)).status, "published");
});

test("blog: missing title or body writes nothing", async () => {
  const u = h.uniq();
  for (const fields of [{ title: "", body: "<p>x</p>" }, { title: `NoBody ${u}`, body: "" }, { title: `Script ${u}`, body: "<script>1</script>" }]) {
    const r = await h.post("/admin/blog", fields);
    assert.equal(r.res.status, 302);
    assert.equal(location(r), "/admin/blog");
  }
  assert.equal((await h.q("SELECT 1 FROM blog_posts WHERE title LIKE $1", [`%${u}`])).length, 0);
});

test("blog: update changes fields and status, keeps the slug, handles images, and ignores blank title/body", async () => {
  const title = `Upd ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: "<p>x</p>" }, { image: true });
  const p = await blogByTitle(title);
  assert.match(p.image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);

  const r = await h.post(`/admin/blog/${p.id}`, { title: `${title} v2`, body: "<p>y</p>", status: "draft", tags: "t", backQuery: "status=draft" });
  assert.equal(location(r), "/admin/blog?status=draft");
  let row = (await h.q("SELECT * FROM blog_posts WHERE id = $1", [p.id]))[0];
  assert.equal(row.title, `${title} v2`);
  assert.equal(row.status, "draft");
  assert.equal(row.published_at, null);
  assert.equal(row.slug, p.slug, "slug is stable across edits");
  assert.equal(row.image_url, p.image_url, "image kept when neither replaced nor removed");

  await h.post(`/admin/blog/${p.id}`, { title: `${title} v2`, body: "<p>y</p>", removeImage: "on" });
  row = (await h.q("SELECT * FROM blog_posts WHERE id = $1", [p.id]))[0];
  assert.equal(row.image_url, null, "removeImage clears");
  assert.equal(row.status, "published", "no status in the form means published");

  await h.post(`/admin/blog/${p.id}`, { title: `${title} v3`, body: "<p>z</p>" }, { image: true });
  assert.match((await h.q("SELECT image_url FROM blog_posts WHERE id = $1", [p.id]))[0].image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);

  await h.post(`/admin/blog/${p.id}`, { title: "", body: "<p>z</p>" });
  await h.post(`/admin/blog/${p.id}`, { title: "Renamed", body: "" });
  assert.equal((await h.q("SELECT title FROM blog_posts WHERE id = $1", [p.id]))[0].title, `${title} v3`);

  const del = await h.post(`/admin/blog/${p.id}/delete`, { backQuery: "page=3" });
  assert.equal(location(del), "/admin/blog?page=3");
  assert.equal((await h.q("SELECT 1 FROM blog_posts WHERE id = $1", [p.id])).length, 0);
});

test("blog: bulk publish/draft/delete act on exactly the chosen ids; garbage ids and unknown actions do nothing", async () => {
  const a = await newPost({ status: "draft" });
  const b = await newPost({ status: "draft" });
  const c = await newPost({ status: "draft" });
  const status = async (x) => (await h.q("SELECT status FROM blog_posts WHERE id = $1", [x.id]))[0]?.status;
  const bulk = (bulkAction, ids) => h.post("/admin/blog/bulk", { bulkAction, ids, backQuery: "q=x" });

  const r = await bulk("publish", [a.id, b.id]);
  assert.equal(location(r), "/admin/blog?q=x");
  assert.deepEqual([await status(a), await status(b), await status(c)], ["published", "published", "draft"]);
  assert.ok((await h.q("SELECT published_at FROM blog_posts WHERE id = $1", [a.id]))[0].published_at);

  await bulk("draft", a.id);
  assert.equal(await status(a), "draft");
  await bulk("publish", ["abc", "-1", ""]);
  await bulk("explode", [c.id]);
  await bulk("publish", []);
  assert.equal(await status(c), "draft");

  await bulk("delete", [a.id, b.id, "junk"]);
  assert.deepEqual([await status(a), await status(b), await status(c)], [undefined, undefined, "draft"]);
  await h.post(`/admin/blog/${c.id}/delete`);
});

test("blog: list filters (status, category, search over title/tags, date range) and paginates 6 per page with clamping", async () => {
  const u = h.uniq();
  const tag = `tag-${u}`;
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const r = await h.q(
      `INSERT INTO blog_posts (slug, title, body, status, category, tags, published_at, created_at)
       VALUES ($1, $2, '<p>b</p>', $3, $4, $5, now() - ($6 || ' minutes')::interval, $7) RETURNING id`,
      [`pg-${u}-${i}`, `Paged ${i} ${u}`, i === 0 ? "draft" : "published", i === 1 ? "Books" : "News", tag, String(i),
        i === 7 ? new Date(Date.now() - 400 * 86400000) : new Date()]
    );
    ids.push(r[0].id);
  }
  const view = async (qs) => (await h.get(`/admin/blog?q=${tag}${qs}`)).text;
  const countOn = (text) => (text.match(new RegExp(`Paged \\d ${u}`, "g")) || []).length;

  const p1 = await view("");
  assert.ok(p1.includes("Posts (8)"));
  assert.equal(countOn(p1) >= 6, true);
  assert.ok(p1.includes("of 8 posts"), "pagination summary shown");
  const p2 = await view("&page=2");
  assert.ok(p2.includes("Posts (8)"));
  assert.ok(p2.includes("Showing 7"), "page 2 starts at the 7th post");
  const clamped = await view("&page=99");
  assert.ok(clamped.includes("Showing 7"), "page past the end clamps to the last page");
  const negative = await view("&page=-4");
  assert.ok(negative.includes("Showing 1&ndash;6"), "non-positive page clamps to 1");

  assert.ok((await view("&status=draft")).includes("Posts (1)"));
  assert.ok((await view("&status=published")).includes("Posts (7)"));
  assert.ok((await view("&status=bogus")).includes("Posts (8)"), "unknown status = all");
  assert.ok((await view("&category=Books")).includes("Posts (1)"));
  assert.ok((await view("&category=Bogus")).includes("Posts (8)"));
  assert.ok((await view("&dateRange=7d")).includes("Posts (7)"));
  assert.ok((await view("&dateRange=30d")).includes("Posts (7)"));
  assert.ok((await view("&dateRange=year")).includes("Posts ("));
  assert.ok((await h.get(`/admin/blog?q=${encodeURIComponent(`Paged 3 ${u}`)}`)).text.includes("Posts (1)"), "title search");

  await h.q("DELETE FROM blog_posts WHERE id = ANY($1)", [ids]);
});

test("blog: ?edit=<id> loads the edit form; a <script> title is escaped in list and form", async () => {
  const marker = `blg${Date.now()}`;
  const title = `<script>alert('${marker}')</script>`;
  await h.post("/admin/blog", { title, body: "<p>fine</p>", tags: marker });
  const p = await blogByTitle(title);

  const list = await h.get(`/admin/blog?q=${marker}`);
  assert.equal(list.res.status, 200);
  assert.ok(!list.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear in the list");
  assert.ok(list.text.includes(esc(title)));

  const edit = await h.get(`/admin/blog?edit=${p.id}`);
  assert.equal(edit.res.status, 200);
  assert.ok(!edit.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear in the edit form");
  assert.ok(edit.text.includes(esc(title)));

  const missing = await h.get("/admin/blog?edit=99999999");
  assert.equal(missing.res.status, 200);
  await h.post(`/admin/blog/${p.id}/delete`);
});

test("announcement and blog routes: garbage ids get the 404 page, not a 500", async () => {
  assert.equal((await h.post("/admin/announcements/abc/status", { action: "trash" })).res.status, 404);
  assert.equal((await h.post("/admin/announcements/abc/delete")).res.status, 404);
  assert.equal((await h.post("/admin/blog/abc", { title: "t", body: "b" })).res.status, 404);
  assert.equal((await h.post("/admin/blog/abc/delete")).res.status, 404);
});
