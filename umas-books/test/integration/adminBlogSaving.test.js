// Saving a blog post: every way it can be refused shows the admin a sentence
// (and keeps what they typed), and the form markup cannot block its own submit.
//
// The bug this guards: the editor's hidden <textarea name="body"> was
// `required`. A required control that is display:none cannot be focused, so
// Chrome and Safari refuse to submit and show NOTHING ("An invalid form control
// with name='body' is not focusable"): a title-only post, or any new post
// typed in the editor (the textarea is only filled at submit), never saved.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("adminblogsave", ["blog"], { isolated: true });
before(h.start);
after(h.stop);

const blogByTitle = async (title) => (await h.q("SELECT * FROM blog_posts WHERE title = $1", [title]))[0];
const decode = (t) => t.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, "&");

test("no admin form has a `required` hidden/editor-backing control (it would block Save silently)", () => {
  const dir = path.join(__dirname, "..", "..", "views");
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ejs")) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/<(input|textarea|select)\b[^>]*>/g)) {
          const tag = m[0];
          if (!/\brequired\b/.test(tag)) continue;
          const hidden = /type=["']hidden["']/.test(tag) || /richtext-hidden/.test(tag) || /display:\s*none/.test(tag) || /\shidden(\s|>|=)/.test(tag);
          if (hidden) offenders.push(`${path.relative(dir, p)}: ${tag.slice(0, 90)}`);
        }
      }
    }
  };
  walk(dir);
  assert.deepEqual(offenders, []);
});

test("the blog form: body textarea is not required, the editor says what is wrong, Save shows a Saving state", async () => {
  const { text } = await h.get("/admin/blog");
  const ta = text.match(/<textarea name="body"[^>]*>/)[0];
  assert.ok(!/required/.test(ta), ta);
  assert.ok(text.includes('data-richtext-required='));
  assert.ok(text.includes('id="blog-body-error"'));
  assert.ok(text.includes("data-saving-text="));
  assert.ok(text.includes('data-max-bytes="15728640"'), "big camera photos are allowed up to 15 MB and checked before sending");
});

test("a draft with only a title is saved; publishing or scheduling without content is refused with a message and keeps the typed text", async () => {
  const u = h.uniq();
  const ok = await h.post("/admin/blog", { title: `Only title ${u}`, body: "", status: "draft" });
  assert.equal(ok.res.status, 200);
  assert.ok(ok.text.includes("saved as a draft"));
  const row = await blogByTitle(`Only title ${u}`);
  assert.equal(row.status, "draft");
  assert.equal(row.body, "");

  for (const status of ["published", "scheduled", undefined]) {
    const fields = { title: `Needs body ${u}`, body: "<p><br></p>", excerpt: "My excerpt", tags: "t1", category: "News" };
    if (status) fields.status = status;
    const r = await h.post("/admin/blog", fields);
    assert.ok(r.text.includes("write some content"), "visible reason");
    assert.ok(r.text.includes('role="alert"'));
    assert.ok(decode(r.text).includes(`value="Needs body ${u}"`), "title kept");
    assert.ok(r.text.includes("My excerpt"), "excerpt kept");
    assert.ok(/<option value="News" selected>/.test(r.text), "category kept");
  }
  assert.equal(await blogByTitle(`Needs body ${u}`), undefined);
});

test("an empty title and a bad publish date are refused with a message", async () => {
  const u = h.uniq();
  const noTitle = await h.post("/admin/blog", { title: "  ", body: `<p>content ${u}</p>` });
  assert.ok(noTitle.text.includes("give the post a title"));
  assert.ok(noTitle.text.includes(`content ${u}`), "the content typed is kept");

  const badDate = await h.post("/admin/blog", { title: `Bad date ${u}`, body: "<p>x</p>", publishDate: "31/10/2026", status: "scheduled" });
  assert.ok(badDate.text.includes("not a valid date"));
  const badDate2 = await h.post("/admin/blog", { title: `Bad date ${u}`, body: "<p>x</p>", publishDate: "2026-13-45", status: "scheduled" });
  assert.ok(badDate2.text.includes("not a valid date"));
  assert.equal(await blogByTitle(`Bad date ${u}`), undefined, "nothing is written, and no 500");
});

test("French text with curly quotes and emoji is stored intact; the same title twice gets two posts", async () => {
  const u = h.uniq();
  const title = `L’été « très » chaud ✨ ${u}`;
  const body = "<p>Éveil à l’école — “citation” œuvre naïve 📚</p>";
  const r = await h.post("/admin/blog", { title, body });
  assert.ok(r.text.includes("was published"));
  const p = await blogByTitle(title);
  assert.equal(p.body, body);
  await h.post("/admin/blog", { title, body });
  assert.equal((await h.q("SELECT 1 FROM blog_posts WHERE title = $1", [title])).length, 2);
});

test("an unreadable picture (e.g. HEIC) refuses the whole save with a message and writes nothing", async () => {
  // The harness's x-test-image gives a readable PNG; an unreadable one is injected here.
  const express = require("express");
  const { buildApp, listen } = require("../helpers/inProcessApp");
  const files = express.Router();
  files.use((req, res, next) => {
    if (req.get("x-bad-image")) req.files = { image: [{ buffer: Buffer.from("not an image at all"), mimetype: "image/heic", size: 19 }] };
    next();
  });
  const server = await listen(buildApp([files, require("../../src/routes/admin/blog")]));
  try {
    const u = h.uniq();
    const post = (fields, extra = {}) => fetch(`${server.base}/admin/blog`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-test-user": JSON.stringify(h.admin), ...extra },
      body: new URLSearchParams(fields).toString(),
    });
    const res = await post({ title: `Heic ${u}`, body: "<p>my words</p>" }, { "x-bad-image": "1" });
    assert.equal(res.status, 303);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const page = await fetch(`${server.base}${res.headers.get("location")}`, { headers: { "x-test-user": JSON.stringify(h.admin), cookie } });
    const text = await page.text();
    assert.ok(text.includes("could not be read"), "the reason is shown");
    assert.ok(text.includes("JPG, PNG or WebP"));
    assert.ok(text.includes("my words"), "the text typed is still in the form");
    assert.equal(await blogByTitle(`Heic ${u}`), undefined);
  } finally {
    await server.close();
  }
});

test("editing: a refused save returns to that post's form with a message; saving a deleted post says so", async () => {
  const u = h.uniq();
  await h.post("/admin/blog", { title: `Edit me ${u}`, body: "<p>orig</p>" });
  const p = await blogByTitle(`Edit me ${u}`);
  const r = await h.post(`/admin/blog/${p.id}`, { title: `Edit me ${u}`, body: "", backQuery: "status=published" });
  assert.ok(r.text.includes("write some content"));
  assert.ok(r.text.includes("Edit Post"), "back on the edit form");
  assert.ok(r.text.includes(`/admin/blog/${p.id}`));
  assert.equal((await blogByTitle(`Edit me ${u}`)).body, "<p>orig</p>");

  await h.q("DELETE FROM blog_posts WHERE id = $1", [p.id]);
  const gone = await h.post(`/admin/blog/${p.id}`, { title: "x", body: "<p>x</p>" });
  assert.ok(gone.text.includes("no longer exists"));
});
