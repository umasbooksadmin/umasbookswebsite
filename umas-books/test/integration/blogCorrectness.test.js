// L7: blog correctness. backQuery is whitelisted, a publish date means PARIS time, bulk
// publish/draft are audited, and the public API sanitises stored HTML when it serves it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const { parisInstant, parisDateString } = require("../../src/lib/tz");

const h = adminHarness("blog_correctness", ["blog", "../blog"], { isolated: true });
before(h.start);
after(h.stop);

const BODY = "<p>Some content</p>";
const row = async (title) => (await h.q("SELECT * FROM blog_posts WHERE title = $1", [title]))[0];

test("parisInstant: the start of a Paris day (winter, summer, around the clock changes), an optional time, bad input is null", () => {
  assert.equal(parisInstant("2026-10-31").toISOString(), "2026-10-30T23:00:00.000Z", "winter: UTC+1");
  assert.equal(parisInstant("2026-07-15").toISOString(), "2026-07-14T22:00:00.000Z", "summer: UTC+2");
  assert.equal(parisInstant("2026-03-29").toISOString(), "2026-03-28T23:00:00.000Z", "day clocks go forward: midnight is still UTC+1");
  assert.equal(parisInstant("2026-10-25").toISOString(), "2026-10-24T22:00:00.000Z", "day clocks go back: midnight is still UTC+2");
  assert.equal(parisInstant("2026-07-15", "18:30").toISOString(), "2026-07-15T16:30:00.000Z");
  for (const bad of ["", "2026-13-01", "2026-02-30", "31/10/2026", "2026-10-31T00:00", null, undefined]) assert.equal(parisInstant(bad), null, String(bad));
  assert.equal(parisInstant("2026-10-31", "25:00"), null);
  assert.equal(parisDateString(new Date("2026-10-30T23:00:00Z")), "2026-10-31");
});

test("a post dated the 31st is published at the START of the 31st in Paris, not 01:00-02:00; editing it keeps the same day", async () => {
  const winter = `Winter ${h.uniq()}`;
  const summer = `Summer ${h.uniq()}`;
  await h.post("/admin/blog", { title: winter, body: BODY, status: "published", publishDate: "2026-12-31" });
  await h.post("/admin/blog", { title: summer, body: BODY, status: "scheduled", publishDate: "2027-07-15" });
  assert.equal((await row(winter)).published_at.toISOString(), "2026-12-30T23:00:00.000Z");
  assert.equal((await row(summer)).published_at.toISOString(), "2027-07-14T22:00:00.000Z");

  const p = await row(winter);
  const form = await h.get(`/admin/blog?edit=${p.id}`);
  assert.match(form.text, /name="publishDate" type="date"[^>]*value="2026-12-31"/, "the form shows the Paris day");
  await h.post(`/admin/blog/${p.id}`, { title: winter, body: BODY, status: "published", publishDate: "2026-12-31" });
  assert.equal((await row(winter)).published_at.toISOString(), "2026-12-30T23:00:00.000Z");
});

test("the public feed reports the Paris day of the publish date, and an invalid date is still refused", async () => {
  const title = `Feed day ${h.uniq()}`;
  const date = new Date(Date.now() - 3 * 86400000);
  const day = parisDateString(date);
  await h.post("/admin/blog", { title, body: BODY, status: "published", publishDate: day });
  const feed = await (await fetch(`${h.base}/api/blog/posts`)).json();
  const post = feed.find((p) => p.title === title);
  assert.ok(post, "published and already past");
  assert.equal(post.date, day);

  const bad = await h.post("/admin/blog", { title: `Bad date ${h.uniq()}`, body: BODY, status: "published", publishDate: "2026-02-30" });
  assert.match(bad.text, /not a valid date/);
});

test("backQuery keeps only the known list filters and rebuilds the query string", async () => {
  const mk = async (backQuery) => {
    const r = await h.post("/admin/blog/bulk", { bulkAction: "", ids: "0", backQuery });
    return r.res.headers.get("location");
  };
  assert.equal(await mk("status=draft&category=News&page=2&q=hello&dateRange=7d"), "/admin/blog?status=draft&category=News&q=hello&dateRange=7d&page=2");
  assert.equal(await mk("status=bogus&category=Nope&page=abc"), "/admin/blog", "unknown values are dropped");
  assert.equal(await mk("evil=1&redirect=//evil.example&status=draft"), "/admin/blog?status=draft", "unknown parameters are dropped");
  assert.equal(await mk("status=draft#frag\r\nX-Injected: 1"), "/admin/blog", "a value with a fragment or header injection is not a known status");
  assert.equal(await mk("status=draft&q=a%0d%0aX-Injected%3A+1"), "/admin/blog?status=draft&q=a%0D%0AX-Injected%3A+1");
  assert.equal(await mk("page=0"), "/admin/blog");
  assert.equal(await mk(""), "/admin/blog");
  assert.equal(await mk("q=" + encodeURIComponent("a&b=c")), "/admin/blog?q=a%26b%3Dc", "a typed search with & stays ONE parameter");
  assert.equal(await mk("q=" + "x".repeat(300)), `/admin/blog?q=${"x".repeat(100)}`);
});

test("bulk publish and bulk draft are audited with the ids; unknown actions are not", async () => {
  const a = `Bulk A ${h.uniq()}`;
  const b = `Bulk B ${h.uniq()}`;
  await h.post("/admin/blog", { title: a, body: BODY, status: "draft" });
  await h.post("/admin/blog", { title: b, body: BODY, status: "draft" });
  const [pa, pb] = [await row(a), await row(b)];
  await h.q("DELETE FROM admin_audit_log");

  await h.post("/admin/blog/bulk", { bulkAction: "publish", ids: [pa.id, pb.id] });
  assert.equal((await row(a)).status, "published");
  let log = await h.q("SELECT * FROM admin_audit_log WHERE action = 'blog.bulk_publish'");
  assert.equal(log.length, 1);
  assert.equal(log[0].detail, `ids ${pa.id},${pb.id}`);
  assert.equal(log[0].actor_user_id, h.admin.id);

  await h.post("/admin/blog/bulk", { bulkAction: "draft", ids: [pa.id] });
  assert.equal((await row(a)).status, "draft");
  log = await h.q("SELECT * FROM admin_audit_log WHERE action = 'blog.bulk_draft'");
  assert.equal(log.length, 1);
  assert.equal(log[0].detail, `ids ${pa.id}`);

  await h.q("DELETE FROM admin_audit_log");
  await h.post("/admin/blog/bulk", { bulkAction: "explode", ids: [pa.id] });
  await h.post("/admin/blog/bulk", { bulkAction: "publish", ids: [] });
  assert.equal((await h.q("SELECT * FROM admin_audit_log")).length, 0);
});

test("the public feed sanitises stored HTML when it serves it (a row written by SQL, not by the form)", async () => {
  const evil = '<p onclick="steal()">Hi<script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">link</a> <b>bold</b></p>';
  const slug = `evil-${h.uniq()}`;
  await h.q(
    `INSERT INTO blog_posts (slug, title, body, status, published_at, created_by) VALUES ($1, 'Evil stored', $2, 'published', now() - interval '1 day', $3)`,
    [slug, evil, h.admin.id]
  );
  const feed = await (await fetch(`${h.base}/api/blog/posts`)).json();
  const post = feed.find((p) => p.slug === slug);
  assert.ok(post);
  assert.doesNotMatch(post.body, /<script|onerror|onclick|javascript:|<img/i);
  assert.match(post.body, /<b>bold<\/b>/, "allowed formatting survives");
  // and the admin preview feed too
  const prev = await (await fetch(`${h.base}/api/blog/posts?preview=1`, { headers: { "x-test-user": JSON.stringify(h.admin) } })).json();
  assert.doesNotMatch(prev.find((p) => p.slug === slug).body, /<script|onerror|javascript:/i);
});

test("sanitising on read does not change a body that was already sanitised on write", async () => {
  const title = `Clean ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: '<p>Hello <b>bold</b> <a href="https://example.org/x">link</a></p><ul><li>one</li></ul>', status: "published", publishDate: parisDateString(new Date(Date.now() - 86400000)) });
  const stored = (await row(title)).body;
  const feed = await (await fetch(`${h.base}/api/blog/posts`)).json();
  assert.equal(feed.find((p) => p.title === title).body, stored);
});
