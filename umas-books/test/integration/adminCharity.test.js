// Admin charity screen (src/routes/admin/charity.js) against the REAL router
// + view (in-process): vote rounds (create / settings / close), the charity
// library (create / update / archive / image / website_url cleaning), round
// options (add / remove), the ideas queue (approve / reject / delete), every
// tab of the list page, <script> escaping and the non-admin refusal.
//
// Isolated database: creating a round deactivates EVERY active round, which
// would race with other files' charity fixtures in the shared CI database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("admincharity", ["charity"], { isolated: true });
before(h.start);
after(h.stop);

const location = (r) => r.res.headers.get("location");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");

const roundBy = async (title) => (await h.q("SELECT * FROM charity_rounds WHERE title = $1", [title]))[0];
const charityBy = async (name) => (await h.q("SELECT * FROM charities WHERE name = $1", [name]))[0];
const activeRounds = async () => h.q("SELECT * FROM charity_rounds WHERE is_active = TRUE");

async function openRound(title = `Round ${h.uniq()}`) {
  await h.post("/admin/charity-rounds", { title });
  return roundBy(title);
}
async function newCharity(extra = {}) {
  const name = extra.name || `Charity ${h.uniq()}`;
  const [{ id }] = await h.q(
    "INSERT INTO charities (name, category, created_by) VALUES ($1, $2, $3) RETURNING id", [name, extra.category || null, h.admin.id]
  );
  return { id, name };
}

// ---------- authorization ----------

test("a non-admin member is refused on every charity route; nothing is written", async () => {
  assert.equal((await h.get("/admin/charity", h.member)).res.status, 403);
  const anon = await h.get("/admin/charity", null);
  assert.equal(anon.res.status, 302);
  assert.equal(location(anon), "/login");

  const title = `Blocked ${h.uniq()}`;
  const c = await newCharity();
  const paths = [
    ["/admin/charity-rounds", { title }],
    ["/admin/charity-rounds/1/settings", { title }],
    ["/admin/charity-rounds/1/close", {}],
    ["/admin/charities", { name: title }],
    [`/admin/charities/${c.id}`, { name: "Hacked" }],
    [`/admin/charities/${c.id}/archive`, {}],
    ["/admin/charity-options", { charityId: c.id }],
    ["/admin/charity-options/1/delete", {}],
    ["/admin/charity-ideas/1/approve", {}],
    ["/admin/charity-ideas/1/reject", {}],
    ["/admin/charity-ideas/1/delete", {}],
  ];
  for (const [p, fields] of paths) {
    assert.equal((await h.post(p, fields, { user: h.member })).res.status, 403, p);
  }
  assert.equal((await h.q("SELECT 1 FROM charity_rounds WHERE title = $1", [title])).length, 0);
  assert.equal((await h.q("SELECT 1 FROM charities WHERE name = $1", [title])).length, 0);
  const row = await charityBy(c.name);
  assert.equal(row.is_archived, false);
});

// ---------- rounds ----------

test("rounds: creating one stores its settings and deactivates the previous active round; blank title writes nothing", async () => {
  const first = await openRound();
  assert.equal(first.is_active, true);
  assert.equal(first.allow_multiple, false, "unchecked allowMultiple is false");
  assert.equal(first.visible_to, "members");
  assert.equal(first.show_results_during_vote, false);
  assert.ok(first.opens_at, "opens_at defaults to now");

  const title = `Second ${h.uniq()}`;
  const r = await h.post("/admin/charity-rounds", {
    title: `  ${title}  `, label: " Spring ", opensAt: "2031-01-01T10:00", closesAt: "2031-02-01T10:00",
    allowMultiple: "on", visibleTo: "everyone", showResultsDuringVote: "on",
  });
  assert.equal(location(r), "/admin/charity?tab=current");
  const second = await roundBy(title);
  assert.equal(second.label, "Spring");
  assert.equal(second.allow_multiple, true);
  assert.equal(second.visible_to, "everyone");
  assert.equal(second.show_results_during_vote, true);
  assert.ok(second.closes_at);
  assert.equal((await roundBy(first.title)).is_active, false, "previous round deactivated");
  const active = await activeRounds();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, second.id);

  // Invalid visibleTo falls back to members; blank title is a no-op.
  const t3 = `Third ${h.uniq()}`;
  await h.post("/admin/charity-rounds", { title: t3, visibleTo: "robots" });
  assert.equal((await roundBy(t3)).visible_to, "members");
  const before = (await activeRounds())[0].id;
  const blank = await h.post("/admin/charity-rounds", { title: "   " });
  assert.equal(location(blank), "/admin/charity?tab=current");
  assert.equal((await activeRounds())[0].id, before, "blank title must not deactivate the active round");
});

test("rounds: settings update changes fields, keeps opens_at when blank, and ignores a blank title; close deactivates and stamps closes_at", async () => {
  const round = await openRound();
  const r = await h.post(`/admin/charity-rounds/${round.id}/settings`, {
    title: `${round.title} v2`, label: "L", closesAt: "2031-03-01T10:00", allowMultiple: "on", visibleTo: "everyone",
  });
  assert.equal(location(r), "/admin/charity?tab=current");
  let row = (await h.q("SELECT * FROM charity_rounds WHERE id = $1", [round.id]))[0];
  assert.equal(row.title, `${round.title} v2`);
  assert.equal(row.label, "L");
  assert.equal(row.allow_multiple, true);
  assert.equal(row.visible_to, "everyone");
  assert.equal(row.show_results_during_vote, false);
  assert.equal(row.opens_at.getTime(), round.opens_at.getTime(), "blank opensAt keeps the existing date");
  assert.ok(row.closes_at);

  await h.post(`/admin/charity-rounds/${round.id}/settings`, { title: "  ", label: "changed" });
  row = (await h.q("SELECT * FROM charity_rounds WHERE id = $1", [round.id]))[0];
  assert.equal(row.title, `${round.title} v2`);
  assert.equal(row.label, "L");

  await h.post(`/admin/charity-rounds/${round.id}/settings`, { title: row.title, closesAt: "" });
  assert.equal((await h.q("SELECT closes_at FROM charity_rounds WHERE id = $1", [round.id]))[0].closes_at, null, "blank closesAt clears it");

  const close = await h.post(`/admin/charity-rounds/${round.id}/close`);
  assert.equal(location(close), "/admin/charity?tab=past");
  row = (await h.q("SELECT * FROM charity_rounds WHERE id = $1", [round.id]))[0];
  assert.equal(row.is_active, false);
  assert.ok(row.closes_at, "closes_at stamped on close");

  // Closing an already-dated round keeps its closes_at.
  const dated = await openRound();
  await h.post(`/admin/charity-rounds/${dated.id}/settings`, { title: dated.title, closesAt: "2031-04-01T10:00" });
  const closesAt = (await h.q("SELECT closes_at FROM charity_rounds WHERE id = $1", [dated.id]))[0].closes_at.getTime();
  await h.post(`/admin/charity-rounds/${dated.id}/close`);
  assert.equal((await h.q("SELECT closes_at FROM charity_rounds WHERE id = $1", [dated.id]))[0].closes_at.getTime(), closesAt);
});

// ---------- library ----------

test("charities: create trims fields, validates category, and keeps only http(s) website URLs", async () => {
  const u = h.uniq();
  const cases = [
    ["https://example.org/a?b=1", "https://example.org/a?b=1"],
    ["http://example.org", "http://example.org"],
    ["  https://example.org/trim  ", "https://example.org/trim"],
    ["javascript:alert(1)", null],
    ["data:text/html,<script>1</script>", null],
    ["ftp://example.org/file", null],
    ["example.org/no-scheme", null],
    ["not a url", null],
    [`https://example.org/${"x".repeat(320)}`, null],
    ["", null],
  ];
  for (const [i, [input, expected]] of cases.entries()) {
    const name = `Url ${i} ${u}`;
    const r = await h.post("/admin/charities", { name, websiteUrl: input, category: "Not a category" });
    assert.equal(r.res.status, 302);
    const row = await charityBy(name);
    assert.ok(row, name);
    assert.equal(row.website_url, expected, `create websiteUrl=${JSON.stringify(input).slice(0, 50)}`);
    assert.equal(row.category, null);
  }

  const { CHARITY_CATEGORIES } = require("../../src/lib/charityCategories");
  const name = `Full ${u}`;
  const r = await h.post("/admin/charities", {
    name: `  ${name}  `, description: "  Helps  ", category: CHARITY_CATEGORIES[0], websiteUrl: "https://ok.example", returnTab: "current",
  });
  assert.equal(location(r), "/admin/charity?tab=current");
  const row = await charityBy(name);
  assert.equal(row.description, "Helps");
  assert.equal(row.category, CHARITY_CATEGORIES[0]);
  assert.equal(row.created_by, h.admin.id);
  assert.equal(row.image_url, null);
  assert.equal(row.is_archived, false);

  const bogusTab = await h.post("/admin/charities", { name: `Tab ${u}`, returnTab: "elsewhere" });
  assert.equal(location(bogusTab), "/admin/charity?tab=library");
});

test("charities: create needs a name (nothing written); an uploaded image becomes an /img/ URL", async () => {
  const u = h.uniq();
  const before = Number((await h.q("SELECT COUNT(*) AS n FROM charities"))[0].n);
  const r = await h.post("/admin/charities", { name: "   ", description: `d ${u}` });
  assert.equal(location(r), "/admin/charity?tab=library");
  assert.equal(Number((await h.q("SELECT COUNT(*) AS n FROM charities"))[0].n), before);

  const name = `Pic ${u}`;
  await h.post("/admin/charities", { name }, { image: true });
  assert.match((await charityBy(name)).image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);
});

test("charities: addToCurrentVote adds an option to the active round only (once), and is a no-op without one", async () => {
  await h.q("UPDATE charity_rounds SET is_active = FALSE");
  const noRound = `NoRound ${h.uniq()}`;
  const r0 = await h.post("/admin/charities", { name: noRound, addToCurrentVote: "on" });
  assert.equal(r0.res.status, 302);
  const c0 = await charityBy(noRound);
  assert.ok(c0, "charity still created");
  assert.equal((await h.q("SELECT 1 FROM charity_options WHERE charity_id = $1", [c0.id])).length, 0);

  const round = await openRound();
  const name = `Voted ${h.uniq()}`;
  await h.post("/admin/charities", { name, addToCurrentVote: "on" });
  const c = await charityBy(name);
  const opts = await h.q("SELECT * FROM charity_options WHERE charity_id = $1", [c.id]);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].round_id, round.id);
  assert.equal(opts[0].name, name);

  const plain = `NotVoted ${h.uniq()}`;
  await h.post("/admin/charities", { name: plain });
  assert.equal((await h.q("SELECT 1 FROM charity_options WHERE charity_id = $1", [(await charityBy(plain)).id])).length, 0);
});

test("charities: update rewrites fields (cleaning the URL), keeps the image unless replaced, ignores a blank name; archive toggles", async () => {
  const c = await newCharity();
  const r = await h.post(`/admin/charities/${c.id}`, {
    name: `${c.name} v2`, description: "New", category: "Bogus", websiteUrl: "javascript:alert(1)", returnTab: "current",
  });
  assert.equal(location(r), "/admin/charity?tab=current");
  let row = (await h.q("SELECT * FROM charities WHERE id = $1", [c.id]))[0];
  assert.equal(row.name, `${c.name} v2`);
  assert.equal(row.description, "New");
  assert.equal(row.category, null);
  assert.equal(row.website_url, null, "non-http(s) URL dropped on update");

  await h.post(`/admin/charities/${c.id}`, { name: row.name, websiteUrl: "https://good.example/x" });
  assert.equal((await h.q("SELECT website_url FROM charities WHERE id = $1", [c.id]))[0].website_url, "https://good.example/x");

  await h.post(`/admin/charities/${c.id}`, { name: row.name }, { image: true });
  const img = (await h.q("SELECT image_url FROM charities WHERE id = $1", [c.id]))[0].image_url;
  assert.match(img, /^\/img\/[0-9a-f]{64}\.jpg$/);
  await h.post(`/admin/charities/${c.id}`, { name: row.name });
  assert.equal((await h.q("SELECT image_url FROM charities WHERE id = $1", [c.id]))[0].image_url, img, "image kept when no new file");

  await h.post(`/admin/charities/${c.id}`, { name: row.name, description: "Kept" });
  const blank = await h.post(`/admin/charities/${c.id}`, { name: "   ", description: "should not apply" });
  assert.equal(location(blank), "/admin/charity?tab=library");
  row = (await h.q("SELECT * FROM charities WHERE id = $1", [c.id]))[0];
  assert.equal(row.name, `${c.name} v2`);
  assert.equal(row.description, "Kept");

  const arch = await h.post(`/admin/charities/${c.id}/archive`, { returnTab: "current" });
  assert.equal(location(arch), "/admin/charity?tab=current");
  assert.equal((await h.q("SELECT is_archived FROM charities WHERE id = $1", [c.id]))[0].is_archived, true);
  const lib = await h.get(`/admin/charity?tab=library&q=${encodeURIComponent(c.name)}`);
  assert.ok(!lib.text.includes(esc(`${c.name} v2`)), "archived charities leave the library list");
  const back = await h.post(`/admin/charities/${c.id}/archive`, {});
  assert.equal(location(back), "/admin/charity?tab=library");
  assert.equal((await h.q("SELECT is_archived FROM charities WHERE id = $1", [c.id]))[0].is_archived, false);
});

// ---------- options ----------

test("options: add a library charity to the active round once; unknown/zero/garbage ids and no active round do nothing; delete removes", async () => {
  const round = await openRound();
  const c = await newCharity();
  const r = await h.post("/admin/charity-options", { charityId: c.id });
  assert.equal(location(r), "/admin/charity?tab=current");
  await h.post("/admin/charity-options", { charityId: c.id });
  const opts = await h.q("SELECT * FROM charity_options WHERE charity_id = $1", [c.id]);
  assert.equal(opts.length, 1, "adding twice keeps one option");
  assert.equal(opts[0].round_id, round.id);
  assert.equal(opts[0].name, c.name);

  const before = Number((await h.q("SELECT COUNT(*) AS n FROM charity_options"))[0].n);
  for (const charityId of ["99999999", "0", "abc", ""]) await h.post("/admin/charity-options", { charityId });
  assert.equal(Number((await h.q("SELECT COUNT(*) AS n FROM charity_options"))[0].n), before);

  const page = await h.get("/admin/charity?tab=current");
  assert.ok(page.text.includes(esc(c.name)), "current tab lists the option");

  const del = await h.post(`/admin/charity-options/${opts[0].id}/delete`);
  assert.equal(location(del), "/admin/charity?tab=current");
  assert.equal((await h.q("SELECT 1 FROM charity_options WHERE id = $1", [opts[0].id])).length, 0);

  await h.q("UPDATE charity_rounds SET is_active = FALSE");
  const other = await newCharity();
  await h.post("/admin/charity-options", { charityId: other.id });
  assert.equal((await h.q("SELECT 1 FROM charity_options WHERE charity_id = $1", [other.id])).length, 0, "no active round: nothing to add to");
});

// ---------- ideas ----------

async function newIdea(extra = {}) {
  const name = extra.name || `Idea ${h.uniq()}`;
  const [{ id }] = await h.q(
    "INSERT INTO charity_ideas (name, description, category, website_url, submitted_by, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [name, extra.description || "An idea", extra.category || null, extra.website_url || null, h.member.id, extra.status || "pending"]
  );
  return { id, name };
}

test("ideas: approve creates a library charity (with a cleaned URL), marks the idea approved and links it; approving twice adds nothing", async () => {
  const good = await newIdea({ website_url: "https://idea.example/page", description: "Good one" });
  const r = await h.post(`/admin/charity-ideas/${good.id}/approve`);
  assert.equal(location(r), "/admin/charity?tab=ideas&ideasTab=pending");
  let idea = (await h.q("SELECT * FROM charity_ideas WHERE id = $1", [good.id]))[0];
  assert.equal(idea.status, "approved");
  assert.ok(idea.resulting_charity_id);
  const charity = (await h.q("SELECT * FROM charities WHERE id = $1", [idea.resulting_charity_id]))[0];
  assert.equal(charity.name, good.name);
  assert.equal(charity.description, "Good one");
  assert.equal(charity.website_url, "https://idea.example/page");
  assert.equal(charity.created_by, h.admin.id);

  await h.post(`/admin/charity-ideas/${good.id}/approve`);
  assert.equal(Number((await h.q("SELECT COUNT(*) AS n FROM charities WHERE name = $1", [good.name]))[0].n), 1, "re-approve is a no-op");

  const evil = await newIdea({ website_url: "javascript:alert(1)" });
  await h.post(`/admin/charity-ideas/${evil.id}/approve`);
  idea = (await h.q("SELECT * FROM charity_ideas WHERE id = $1", [evil.id]))[0];
  assert.equal((await h.q("SELECT website_url FROM charities WHERE id = $1", [idea.resulting_charity_id]))[0].website_url, null, "javascript: URL cleaned on approval");

  const rejected = await newIdea({ status: "rejected" });
  await h.post(`/admin/charity-ideas/${rejected.id}/approve`);
  assert.equal((await h.q("SELECT 1 FROM charities WHERE name = $1", [rejected.name])).length, 0, "only pending ideas can be approved");

  const missing = await h.post("/admin/charity-ideas/99999999/approve");
  assert.equal(missing.res.status, 302);
});

test("ideas: reject only affects pending ideas; delete removes with the right sub-tab redirect", async () => {
  const idea = await newIdea();
  const r = await h.post(`/admin/charity-ideas/${idea.id}/reject`);
  assert.equal(location(r), "/admin/charity?tab=ideas&ideasTab=pending");
  assert.equal((await h.q("SELECT status FROM charity_ideas WHERE id = $1", [idea.id]))[0].status, "rejected");

  const approved = await newIdea({ status: "approved" });
  await h.post(`/admin/charity-ideas/${approved.id}/reject`);
  assert.equal((await h.q("SELECT status FROM charity_ideas WHERE id = $1", [approved.id]))[0].status, "approved", "approved ideas stay approved");

  const del = await h.post(`/admin/charity-ideas/${idea.id}/delete`, { ideasTab: "rejected" });
  assert.equal(location(del), "/admin/charity?tab=ideas&ideasTab=rejected");
  assert.equal((await h.q("SELECT 1 FROM charity_ideas WHERE id = $1", [idea.id])).length, 0);
  const del2 = await h.post(`/admin/charity-ideas/${approved.id}/delete`, { ideasTab: "nonsense" });
  assert.equal(location(del2), "/admin/charity?tab=ideas&ideasTab=pending");
});

// ---------- list page ----------

test("list page: every tab and ideas sub-tab renders its content; unknown tabs fall back to current", async () => {
  const round = await openRound(`Live ${h.uniq()}`);
  const inRound = await newCharity();
  const lib = await newCharity({ category: null });
  await h.post("/admin/charity-options", { charityId: inRound.id });
  const [opt] = await h.q("SELECT id FROM charity_options WHERE charity_id = $1", [inRound.id]);
  await h.q("INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)", [round.id, opt.id, h.member.id]);

  const pending = await newIdea();
  const approved = await newIdea({ status: "approved" });
  const rejected = await newIdea({ status: "rejected" });

  // A closed round with a legacy free-text option (no library link) shows in Past.
  const past = await openRound(`Past ${h.uniq()}`);
  await h.q("INSERT INTO charity_options (round_id, name, description) VALUES ($1, 'Legacy option', 'free text') RETURNING id", [past.id]);
  await h.post(`/admin/charity-rounds/${past.id}/close`);
  const live = await openRound(`Live2 ${h.uniq()}`);
  await h.post("/admin/charity-options", { charityId: inRound.id });

  const cur = await h.get("/admin/charity");
  assert.equal(cur.res.status, 200);
  assert.ok(cur.text.includes(esc(live.title)), "default tab is the current round");
  assert.equal((await h.get("/admin/charity?tab=bogus")).text.includes(esc(live.title)), true);

  const library = await h.get("/admin/charity?tab=library");
  assert.ok(library.text.includes(esc(lib.name)) && library.text.includes(esc(inRound.name)));
  const search = await h.get(`/admin/charity?tab=library&q=${encodeURIComponent(lib.name)}`);
  assert.ok(search.text.includes(esc(lib.name)) && !search.text.includes(esc(inRound.name)), "q filters the library");

  const ideasPending = await h.get("/admin/charity?tab=ideas");
  assert.ok(ideasPending.text.includes(esc(pending.name)));
  assert.ok(!ideasPending.text.includes(esc(approved.name)));
  assert.ok((await h.get("/admin/charity?tab=ideas&ideasTab=approved")).text.includes(esc(approved.name)));
  assert.ok((await h.get("/admin/charity?tab=ideas&ideasTab=rejected")).text.includes(esc(rejected.name)));
  assert.ok((await h.get("/admin/charity?tab=ideas&ideasTab=bogus")).text.includes(esc(pending.name)), "unknown sub-tab = pending");

  const pastTab = await h.get("/admin/charity?tab=past");
  assert.ok(pastTab.text.includes(esc(past.title)));
  assert.ok(pastTab.text.includes("Legacy option"), "free-text options show their own name");
});

test("list page: with no active round the current tab still renders; a <script> charity name and idea are escaped", async () => {
  await h.q("UPDATE charity_rounds SET is_active = FALSE");
  const marker = `chr${Date.now()}`;
  const name = `<script>alert('${marker}')</script>`;
  await h.post("/admin/charities", { name });
  const idea = await newIdea({ name: `<script>alert('i${marker}')</script>` });

  const cur = await h.get("/admin/charity?tab=current");
  assert.equal(cur.res.status, 200);
  const library = await h.get(`/admin/charity?tab=library&q=${marker}`);
  assert.ok(!library.text.includes(`<script>alert('${marker}')`), "raw script tag must not appear");
  assert.ok(library.text.includes(esc(name)));
  const ideas = await h.get("/admin/charity?tab=ideas");
  assert.ok(!ideas.text.includes(`<script>alert('i${marker}')`));
  assert.ok(ideas.text.includes(esc(`<script>alert('i${marker}')</script>`)));
  await h.post(`/admin/charity-ideas/${idea.id}/delete`);
});

test("charity routes: garbage ids get the 404 page, not a 500", async () => {
  assert.equal((await h.post("/admin/charity-rounds/abc/close")).res.status, 404);
  assert.equal((await h.post("/admin/charities/abc", { name: "x" })).res.status, 404);
  assert.equal((await h.post("/admin/charity-options/abc/delete")).res.status, 404);
  assert.equal((await h.post("/admin/charity-ideas/abc/approve")).res.status, 404);
});
