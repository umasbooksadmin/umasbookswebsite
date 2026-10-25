// The admin blog editor's French version: the three French fields are saved and sanitised like the English body, the
// "French: missing / draft / ready" status is shown in the editor and the list, a post can be published in English
// alone, and "Translate to French" (lib/blogTranslate.js) fills the form only: AI mocked, failures explained, nothing
// saved or published by itself, one call of the shared cap per press, admins only.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { adminHarness } = require("../helpers/adminHarness");
const anthropic = require("../../src/lib/anthropic");

const h = adminHarness("adminblogfr", ["blog"], { isolated: true });
before(h.start);
after(h.stop);

const realAsk = anthropic.askText;
let calls;
let reply;
beforeEach(() => {
  calls = [];
  reply = { text: null, reason: "no_key" };
  anthropic.askText = async (prompt, opts) => { calls.push({ prompt, opts }); return typeof reply === "function" ? reply(prompt) : reply; };
});
after(() => { anthropic.askText = realAsk; });

const row = async (title) => (await h.q("SELECT * FROM blog_posts WHERE title = $1", [title]))[0];
// The button is limited to 10 presses a minute per admin; every call here is made by a fresh admin unless a user is given.
const translate = async (fields, opts) => {
  const user = opts && opts.user ? opts.user : await h.makeUser({ admin: true });
  const { res, text } = await h.post("/admin/blog/translate", fields, { user });
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};
const decode = (t) => t.replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------------------------------------------------------------- saving

test("the French title, excerpt and content are saved with a new post, shown again in the editor, and a post can be published in English alone", async () => {
  const title = `FR save ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: "<p>English body</p>", status: "published", title_fr: "Titre français", excerpt_fr: "Résumé", body_fr: "<p>Corps <strong>français</strong></p>" });
  const r = await row(title);
  assert.equal(r.title_fr, "Titre français");
  assert.equal(r.excerpt_fr, "Résumé");
  assert.equal(r.body_fr, "<p>Corps <strong>français</strong></p>");
  assert.equal(r.status, "published");
  const form = await h.get(`/admin/blog?edit=${r.id}`);
  assert.ok(form.text.includes('name="title_fr"') && form.text.includes('value="Titre français"'));
  assert.ok(form.text.includes("Corps <strong>français</strong>"), "the French content is in the French editor");
  assert.match(form.text, /French: ready/);

  const only = `EN only ${h.uniq()}`;
  await h.post("/admin/blog", { title: only, body: "<p>English only</p>", status: "published" });
  const o = await row(only);
  assert.deepEqual([o.title_fr, o.excerpt_fr, o.body_fr, o.status], [null, null, null, "published"], "no French is stored as NULL, and the post is published");
  assert.match((await h.get(`/admin/blog?edit=${o.id}`)).text, /French: missing/);
});

test("editing keeps, changes and clears the French text; an editor holding only empty paragraphs counts as nothing", async () => {
  const title = `FR edit ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: "<p>x</p>", status: "published", title_fr: "A", body_fr: "<p>B</p>" });
  const r = await row(title);
  await h.post(`/admin/blog/${r.id}`, { title, body: "<p>x</p>", status: "published", title_fr: "A2", excerpt_fr: "E2", body_fr: "<p>B2</p>" });
  assert.deepEqual([(await row(title)).title_fr, (await row(title)).excerpt_fr, (await row(title)).body_fr], ["A2", "E2", "<p>B2</p>"]);
  await h.post(`/admin/blog/${r.id}`, { title, body: "<p>x</p>", status: "published", title_fr: "", excerpt_fr: "  ", body_fr: "<p><br></p><div>&nbsp;</div>" });
  const cleared = await row(title);
  assert.deepEqual([cleared.title_fr, cleared.excerpt_fr, cleared.body_fr], [null, null, null]);
});

test("the French content passes the same sanitising as the English: script, handlers, javascript: links and iframes are removed", async () => {
  const title = `FR xss ${h.uniq()}`;
  const evil = '<p onclick="alert(1)">F</p><script>alert(2)</script><img src=x onerror=alert(3)><a href="javascript:alert(4)">l</a><iframe src="//e"></iframe><b>ok</b>';
  await h.post("/admin/blog", { title, body: evil, status: "published", title_fr: "T", body_fr: evil });
  const r = await row(title);
  for (const field of ["body", "body_fr"]) {
    assert.ok(!/<script|onclick|onerror|javascript:|<iframe|<img/i.test(r[field]), `${field}: ${r[field]}`);
    assert.ok(r[field].includes("<b>ok</b>"));
  }
  assert.equal(r.body, r.body_fr, "the same rules for both languages");
});

test("a French title with markup is escaped in the editor and the list (admin screens never print stored text raw)", async () => {
  const title = `FR esc ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: "<p>x</p>", status: "published", title_fr: '"><script>alert(9)</script>', excerpt_fr: "</textarea><script>alert(8)</script>" });
  const r = await row(title);
  const page = (await h.get(`/admin/blog?edit=${r.id}`)).text;
  assert.ok(!page.includes("<script>alert(9)") && !page.includes("<script>alert(8)"));
  assert.ok(page.includes("&lt;script&gt;alert(9)&lt;/script&gt;"));
});

test("a refused save (no English title) keeps the French text that was typed", async () => {
  const { text } = await h.post("/admin/blog", { title: "", body: "<p>x</p>", status: "published", title_fr: "Titre gardé", excerpt_fr: "Résumé gardé", body_fr: "<p>Corps gardé</p>" });
  assert.match(text, /Please give the post a title/);
  assert.ok(text.includes("Titre gardé") && text.includes("Résumé gardé") && text.includes("Corps gardé"));
});

test("the French status: missing with nothing, draft when incomplete, ready with a title and content (and an excerpt when the English post has one); shown in the list too", async () => {
  const mk = async (name, fields) => {
    const title = `FR status ${name} ${h.uniq()}`;
    await h.post("/admin/blog", { title, body: "<p>x</p>", status: "published", ...fields });
    return { title, r: await row(title) };
  };
  const cases = [
    ["missing", {}, "missing"],
    ["title only", { title_fr: "T" }, "draft"],
    ["body only", { body_fr: "<p>B</p>" }, "draft"],
    ["title and body, English has no excerpt", { title_fr: "T", body_fr: "<p>B</p>" }, "ready"],
    ["English excerpt but no French one", { excerpt: "English excerpt", title_fr: "T", body_fr: "<p>B</p>" }, "draft"],
    ["all three", { excerpt: "English excerpt", title_fr: "T", excerpt_fr: "R", body_fr: "<p>B</p>" }, "ready"],
  ];
  for (const [name, fields, want] of cases) {
    const { title, r } = await mk(name, fields);
    const page = (await h.get(`/admin/blog?edit=${r.id}&q=${encodeURIComponent(title)}`)).text;
    assert.match(page, new RegExp(`id="blog-french-status">French: ${want}<`), `${name}: editor`);
    const listRow = new RegExp(`${title}[\\s\\S]*?<span class="status-pill (?:published|scheduled|draft)">${want}</span>`);
    assert.match(page, listRow, `${name}: list`);
  }
});

// ---------------------------------------------------------------- translate

const ANSWER = "===TITLE===\nUn titre\n===EXCERPT===\nUn résumé\n===BODY===\n<p>Un <strong>corps</strong></p>";

test("Translate to French returns the French text WITHOUT saving it, with one call of the AI per press", async () => {
  const title = `FR tr ${h.uniq()}`;
  await h.post("/admin/blog", { title, body: "<p>Hello</p>", excerpt: "Hi", status: "draft" });
  const before = await row(title);
  reply = { text: ANSWER, reason: null };
  const { res, json } = await translate({ title, excerpt: "Hi", body: "<p>Hello <b>world</b></p>" });
  assert.equal(res.status, 200);
  assert.deepEqual([json.titleFr, json.excerptFr, json.bodyFr], ["Un titre", "Un résumé", "<p>Un <strong>corps</strong></p>"]);
  assert.deepEqual(json.filled.sort(), ["body_fr", "excerpt_fr", "title_fr"]);
  assert.match(json.notice, /nothing is saved until you do/);
  assert.equal(calls.length, 1, "one call of the shared daily cap");
  assert.equal(calls[0].opts.feature, "translation");
  assert.ok(calls[0].prompt.includes("Hello <b>world</b>") && calls[0].prompt.includes("Uma's Books and Adventures"));
  assert.deepEqual(await row(title), before, "nothing in the database changed");
  assert.equal((await h.q("SELECT count(*)::int AS n FROM blog_posts WHERE title_fr IS NOT NULL AND title = $1", [title]))[0].n, 0);
});

test("the AI's answer is cleaned: quotes and code fences removed, the body sanitised, a script never comes back", async () => {
  reply = { text: '===TITLE===\n"Titre"\n===EXCERPT===\n«Résumé»\n===BODY===\n```html\n<p onclick="x()">Corps</p><script>alert(1)</script>\n```', reason: null };
  const { json } = await translate({ title: "T", excerpt: "E", body: "<p>B</p>" });
  assert.equal(json.titleFr, "Titre");
  assert.equal(json.excerptFr, "Résumé");
  assert.equal(json.bodyFr, "<p>Corps</p>");
});

test("only empty French fields are filled unless the admin chose to replace; fields with no English are not sent", async () => {
  reply = (prompt) => ({ text: prompt.includes("===TITLE===\nOnly") ? "===TITLE===\nSeulement" : ANSWER, reason: null });
  const keep = await translate({ title: "Title", excerpt: "Ex", body: "<p>B</p>", title_fr: "Mon titre", body_fr: "<p>Mon corps</p>" });
  assert.deepEqual(keep.json.filled, ["excerpt_fr"], "only the empty excerpt is translated");
  assert.equal(keep.json.titleFr, "Mon titre");
  assert.equal(keep.json.bodyFr, "<p>Mon corps</p>");
  assert.ok(!calls[0].prompt.includes("===BODY===\n<p>B</p>"), "text that already has French is not sent for translation");
  const over = await translate({ title: "Title", excerpt: "Ex", body: "<p>B</p>", title_fr: "Mon titre", body_fr: "<p>Mon corps</p>", overwrite: "1" });
  assert.deepEqual(over.json.filled.sort(), ["body_fr", "excerpt_fr", "title_fr"]);
  assert.equal(over.json.titleFr, "Un titre");
  const noEx = await translate({ title: "Title", excerpt: "", body: "<p>B</p>" });
  assert.ok(!noEx.json.filled.includes("excerpt_fr") || noEx.json.excerptFr === "Un résumé");
  assert.ok(!calls[calls.length - 1].prompt.includes("===EXCERPT===\n\n"), "an empty English excerpt is not sent");
});

test("when there is nothing to translate the AI is not called", async () => {
  const none = await translate({ title: "", excerpt: "", body: "<p><br></p>" });
  assert.equal(none.res.status, 400);
  assert.match(none.json.error, /Write the English title and content first/);
  const full = await translate({ title: "T", body: "<p>B</p>", title_fr: "A", body_fr: "<p>B</p>" });
  assert.equal(full.res.status, 400);
  assert.match(full.json.error, /already filled in/);
  const long = await translate({ title: "T", body: `<p>${"x".repeat(25000)}</p>` });
  assert.equal(long.res.status, 400);
  assert.match(long.json.error, /too long to translate in one go/);
  assert.equal(calls.length, 0);
});

test("each way the AI can fail gives the admin a sentence and changes nothing", async () => {
  const cases = [
    [{ text: null, reason: "no_key" }, 502, /no Anthropic API key/],
    [{ text: null, reason: "cap", message: "The daily AI limit has been reached (600 calls)." }, 429, /daily AI limit has been reached/],
    [{ text: null, reason: "credit" }, 502, /no credit left/],
    [{ text: null, reason: "rate" }, 502, /busy right now/],
    [{ text: null, reason: "timeout" }, 502, /took too long/],
    [{ text: null, reason: "error" }, 502, /did not give a usable answer/],
    [{ text: "I am sorry, I cannot do that.", reason: null }, 502, /did not give a usable answer/],
  ];
  for (const [r, status, re] of cases) {
    reply = r;
    const { res, json } = await translate({ title: "T", excerpt: "E", body: "<p>B</p>" });
    assert.equal(res.status, status, JSON.stringify(r));
    assert.match(json.error, re);
    assert.ok(!/no suggestions/.test(json.error), "the wording is about the translation, not collection suggestions");
  }
});

test("a partly usable answer fills what it can and says so", async () => {
  reply = { text: "===TITLE===\nSeul le titre", reason: null };
  const { json } = await translate({ title: "T", excerpt: "E", body: "<p>B</p>" });
  assert.deepEqual(json.filled, ["title_fr"]);
  assert.match(json.notice, /Part of it could not be translated/);
});

test("only an admin can translate; a member or a visitor gets no AI call", async () => {
  reply = { text: ANSWER, reason: null };
  for (const user of [h.member, null]) {
    const { res, text } = await h.post("/admin/blog/translate", { title: "T", body: "<p>B</p>" }, { user });
    assert.ok(res.status !== 200 || !text.includes("Un titre"));
  }
  assert.equal(calls.length, 0);
});

test("the button is limited to 10 presses a minute per admin, with the AI not called after that", async () => {
  reply = { text: ANSWER, reason: null };
  const admin = await h.makeUser({ admin: true });
  let last;
  for (let i = 0; i < 11; i++) last = await translate({ title: "T", body: "<p>B</p>" }, { user: admin });
  assert.equal(last.res.status, 429);
  assert.match(last.json.error, /limit|AI/i);
  assert.equal(calls.length, 10);
});

test("translating leaves an entry in the admin activity log with counts only", async () => {
  await h.q("DELETE FROM admin_audit_log");
  reply = { text: ANSWER, reason: null };
  const { res } = await translate({ title: "Secret title text", body: "<p>Secret body</p>" });
  assert.equal(res.status, 200);
  const log = await h.q("SELECT action, detail FROM admin_audit_log WHERE action = 'blog.translate'");
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /^\d+ filled$/);
  assert.ok(!JSON.stringify(log).includes("Secret"));
});

// ---------------------------------------------------------------- markup

test("the editor has the French section: the status, the Translate button, a labelled French editor and field names that match the form handler", () => {
  const view = fs.readFileSync(path.join(__dirname, "..", "..", "views", "admin", "blog.ejs"), "utf8");
  for (const needle of ['name="title_fr"', 'name="body_fr"', 'name="excerpt_fr"', 'id="blog-translate-btn"', 'id="blog-french-status"', "French version", "Translate to French", "blog-translate.js"]) assert.ok(view.includes(needle), needle);
  assert.doesNotMatch(view, /<script(?![^>]*\ssrc=)/i, "no inline script (the CSP blocks it)");
  const code = fs.readFileSync(path.join(__dirname, "..", "..", "public", "blog-translate.js"), "utf8");
  assert.match(code, /\/admin\/blog\/translate|data-translate-url/);
  assert.ok(decode("&lt;").length === 1);
});
