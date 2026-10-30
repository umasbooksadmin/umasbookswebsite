// Admin form safety: an end must be after its start (events, sessions, shifts,
// charity votes) with the typed values kept; impossible calendar dates and
// invalid numbers are refused with a message; text over its limit is refused,
// not cut off; the same create form sent twice makes one row; rows already
// saved with a backwards range are listed as a warning (nothing changed).
//
// Real routers + views in-process (the harness follows the 303 a refused form
// answers, like the browser, and returns the page).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("adminformsafety", ["events", "sessions", "meetings", "volunteerShifts", "announcements", "charity", "blog"], { isolated: true });
before(h.start);
after(h.stop);

const MONTH = "2031-05";
const DAY = "2031-05-14";
const count = async (sql, params) => Number((await h.q(sql, params))[0].n);

// ---------- end after start ----------

test("sessions: an end before the start is refused with a message, keeps what was typed and saves nothing", async () => {
  const title = `Backwards ${h.uniq()}`;
  for (const endTime of ["10:00", "09:00"]) { // equal and earlier
    const r = await h.post("/admin/sessions", { title, date: DAY, startTime: "10:00", endTime, capacity: "7", location: "Back room", month: MONTH });
    assert.equal(r.res.status, 200);
    assert.match(r.text, /A session must end after it starts/);
    assert.ok(r.text.includes(`value="${title}"`), "the title typed is still in the form");
    assert.ok(r.text.includes('value="Back room"'));
    assert.match(r.text, /name="endTime" type="time" value="\d\d:\d\d"/);
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM classes WHERE title = $1", [title]), 0);
  const ok = await h.post("/admin/sessions", { title, date: DAY, startTime: "10:00", endTime: "11:00", capacity: "7", month: MONTH });
  assert.equal(ok.res.status, 302, "a good form saves and redirects as before");
  assert.equal(await count("SELECT COUNT(*) AS n FROM classes WHERE title = $1", [title]), 1);
});

test("sessions edit: a backwards range is refused, the row is unchanged, the typed times stay in the form", async () => {
  const title = `EditRange ${h.uniq()}`;
  await h.post("/admin/sessions", { title, date: DAY, startTime: "10:00", endTime: "11:00", capacity: "5" });
  const [row] = await h.q("SELECT id, starts_at, ends_at FROM classes WHERE title = $1", [title]);
  const r = await h.post(`/admin/sessions/${row.id}?month=${MONTH}`, { title, startsAt: `${DAY}T12:00`, endsAt: `${DAY}T08:00`, capacity: "5" });
  assert.match(r.text, /A session must end after it starts/);
  assert.ok(r.text.includes(`value="${DAY}T12:00"`) && r.text.includes(`value="${DAY}T08:00"`), "the typed start and end are back in the form");
  const [after] = await h.q("SELECT starts_at, ends_at FROM classes WHERE id = $1", [row.id]);
  assert.deepEqual([after.starts_at, after.ends_at], [row.starts_at, row.ends_at]);
  // an end that is not a real time is refused too (it used to clear the end silently)
  const bad = await h.post(`/admin/sessions/${row.id}?month=${MONTH}`, { title, startsAt: `${DAY}T12:00`, endsAt: "2031-02-30T10:00", capacity: "5" });
  assert.match(bad.text, /That end is not a real date and time/);
  assert.deepEqual((await h.q("SELECT ends_at FROM classes WHERE id = $1", [row.id]))[0].ends_at, row.ends_at);
  // a valid edit still works
  const fine = await h.post(`/admin/sessions/${row.id}?month=${MONTH}`, { title, startsAt: `${DAY}T12:00`, endsAt: `${DAY}T13:00`, capacity: "5" });
  assert.doesNotMatch(fine.text, /must end after/);
  assert.notDeepEqual((await h.q("SELECT starts_at FROM classes WHERE id = $1", [row.id]))[0].starts_at, row.starts_at);
});

test("events: create and edit refuse an end that is not after the start, and keep the typed values", async () => {
  const title = `EvRange ${h.uniq()}`;
  const r = await h.post("/admin/events", { title, date: DAY, startTime: "18:00", endTime: "17:00", capacity: "20", price: "5", month: MONTH });
  assert.match(r.text, /An event must end after it starts/);
  assert.ok(r.text.includes(`value="${title}"`));
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE title = $1", [title]), 0);
  await h.post("/admin/events", { title, date: DAY, startTime: "18:00", endTime: "19:00" });
  const [row] = await h.q("SELECT id, ends_at FROM events WHERE title = $1", [title]);
  const e = await h.post(`/admin/events/${row.id}?month=${MONTH}`, { title, startsAt: `${DAY}T18:00`, endsAt: `${DAY}T18:00` });
  assert.match(e.text, /An event must end after it starts/);
  assert.deepEqual((await h.q("SELECT ends_at FROM events WHERE id = $1", [row.id]))[0].ends_at, row.ends_at);
});

test("volunteer shifts: an end before the start saves nothing (not even the repeats) and keeps the values", async () => {
  const role = `ShiftRange ${h.uniq()}`;
  const r = await h.post("/admin/volunteer-shifts", { role, date: DAY, startTime: "14:00", endTime: "09:00", repeatWeeks: "4", notes: "bring keys", month: MONTH });
  assert.match(r.text, /A shift must end after it starts/);
  assert.ok(r.text.includes(`value="${role}"`) && r.text.includes('value="4"') && r.text.includes("bring keys"));
  assert.equal(await count("SELECT COUNT(*) AS n FROM volunteer_shifts WHERE role = $1", [role]), 0);
});

test("charity votes: a close date before the opening, or a date that does not exist, is refused", async () => {
  const title = `Vote ${h.uniq()}`;
  const r = await h.post("/admin/charity-rounds", { title, opensAt: "2031-06-10T09:00", closesAt: "2031-06-01T09:00" });
  assert.match(r.text, /A vote must end after it starts/);
  const r2 = await h.post("/admin/charity-rounds", { title, opensAt: "2031-02-30T09:00" });
  assert.match(r2.text, /opening date is not a real date/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM charity_rounds WHERE title = $1", [title]), 0);
});

// ---------- numbers and dates that do not exist ----------

test("events: a capacity over the limit and a day that does not exist are refused with a message, not dropped", async () => {
  const title = `EvBad ${h.uniq()}`;
  const cap = await h.post("/admin/events", { title, date: DAY, startTime: "12:00", capacity: "100001", month: MONTH });
  assert.match(cap.text, /Capacity must be a whole number between 0 and 100000/);
  assert.ok(cap.text.includes('value="100001"'), "the typed capacity stays in the form");
  const day = await h.post("/admin/events", { title, date: "2031-02-30", startTime: "12:00" });
  assert.match(day.text, /not a real date and time/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE title = $1", [title]), 0);
});

// ---------- length limits ----------

test("text over its limit is refused with a message and nothing is cut off or saved", async () => {
  const long = (n) => "x".repeat(n);
  let r = await h.post("/admin/events", { title: long(201), date: DAY, startTime: "12:00" });
  assert.match(r.text, /The title is too long \(201 characters; the limit is 200\)/);
  r = await h.post("/admin/sessions", { title: "T-long", date: DAY, startTime: "12:00", capacity: "5", description: long(5001) });
  assert.match(r.text, /The description is too long/);
  r = await h.post("/admin/meetings", { title: "M-long", date: DAY, time: "12:00", agenda: long(5001), month: MONTH });
  assert.match(r.text, /The agenda is too long/);
  assert.ok(r.text.includes('value="M-long"'), "the meeting form keeps what was typed");
  r = await h.post("/admin/volunteer-shifts", { role: "R-long", date: DAY, startTime: "12:00", endTime: "13:00", notes: long(5001) });
  assert.match(r.text, /The notes are too long|The notes is too long/);
  r = await h.post("/admin/announcements", { title: long(201), body: "<p>x</p>" });
  assert.match(r.text, /The title is too long/);
  r = await h.post("/admin/charities", { name: long(201) });
  assert.match(r.text, /The name is too long/);
  r = await h.post("/admin/blog", { title: long(201), body: "<p>x</p>", status: "draft" });
  assert.match(r.text, /The title is too long/);
  for (const [table, col, value] of [["events", "title", long(201)], ["classes", "title", "T-long"], ["meetings", "title", "M-long"], ["volunteer_shifts", "role", "R-long"], ["announcements", "title", long(201)], ["charities", "name", long(201)], ["blog_posts", "title", long(201)]]) {
    assert.equal(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = $1`, [value]), 0, table);
  }
  // exactly at the limit is fine
  const atLimit = await h.post("/admin/meetings", { title: long(200), date: DAY, time: "12:00" });
  assert.doesNotMatch(atLimit.text, /too long/);
  assert.equal(await count("SELECT COUNT(*) AS n FROM meetings WHERE title = $1", [long(200)]), 1);
});

// ---------- double submit ----------

test("the same create form sent twice at once makes one session, one event, one meeting and one set of shifts", async () => {
  const u = h.uniq();
  const twice = (path, fields) => Promise.all([h.post(path, fields), h.post(path, fields)]);
  await twice("/admin/sessions", { title: `Dbl S ${u}`, date: DAY, startTime: "10:00", capacity: "5" });
  await twice("/admin/events", { title: `Dbl E ${u}`, date: DAY, startTime: "10:00" });
  await twice("/admin/meetings", { title: `Dbl M ${u}`, date: DAY, time: "10:00" });
  await twice("/admin/volunteer-shifts", { role: `Dbl V ${u}`, date: DAY, startTime: "10:00", endTime: "12:00", repeatWeeks: "3" });
  assert.equal(await count("SELECT COUNT(*) AS n FROM classes WHERE title = $1", [`Dbl S ${u}`]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE title = $1", [`Dbl E ${u}`]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM meetings WHERE title = $1", [`Dbl M ${u}`]), 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM volunteer_shifts WHERE role = $1", [`Dbl V ${u}`]), 3, "three weekly shifts, once");
});

test("the same title at a different time, or the same one a minute later, is a normal new row", async () => {
  const title = `Twice ${h.uniq()}`;
  await h.post("/admin/events", { title, date: DAY, startTime: "10:00" });
  await h.post("/admin/events", { title, date: DAY, startTime: "15:00" });
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE title = $1", [title]), 2);
  await h.q("UPDATE events SET created_at = now() - interval '2 minutes' WHERE title = $1", [title]);
  await h.post("/admin/events", { title, date: DAY, startTime: "10:00" });
  assert.equal(await count("SELECT COUNT(*) AS n FROM events WHERE title = $1", [title]), 3);
});

test("the create forms disable their button while saving", async () => {
  for (const [path, marker] of [["/admin/events", "Add event"], ["/admin/sessions", "Add session"], ["/admin/meetings", "Schedule"], ["/admin/volunteer-shifts", "Add shift"]]) {
    const page = await h.get(`${path}?month=${MONTH}`);
    assert.match(page.text, new RegExp(`<form class="stack" method="post" action="${path}" data-saving-text="Saving&hellip;">`), path);
    assert.ok(page.text.includes(marker));
  }
  for (const path of ["/admin/announcements", "/admin/charity?tab=library"]) {
    assert.match((await h.get(path)).text, /<form class="stack" method="post" action="[^"]*" enctype="multipart\/form-data" data-saving-text=/, path);
  }
  assert.match((await h.get("/admin/charity?tab=current")).text, /action="\/admin\/charity-rounds" data-saving-text=/);
});

// ---------- existing bad rows ----------

test("rows already saved with an end before the start are listed as a warning and left alone", async () => {
  const title = `LegacyBad ${h.uniq()}`;
  await h.q("INSERT INTO classes (title, starts_at, ends_at, capacity) VALUES ($1, '2031-05-20T10:00:00Z', '2031-05-20T08:00:00Z', 5)", [title]);
  await h.q("INSERT INTO events (title, starts_at, ends_at) VALUES ($1, '2031-05-21T10:00:00Z', '2031-05-21T08:00:00Z')", [title]);
  await h.q("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ($1, '2031-05-22T10:00:00Z', '2031-05-22T08:00:00Z', 1)", [title]);
  for (const [path, noun] of [["/admin/sessions", "session"], ["/admin/events", "event"], ["/admin/volunteer-shifts", "volunteer shift"]]) {
    const page = await h.get(path); // the current month is not 2031-05: the warning is not tied to the month shown
    assert.match(page.text, new RegExp(`data-bad-ranges`), path);
    assert.ok(page.text.includes(title), path);
    assert.ok(page.text.includes(`${path}?month=2031-05`), `${path} links to the month`);
    assert.match(page.text, new RegExp(`end(s)? before (it starts|they start)`), noun);
  }
  const [row] = await h.q("SELECT starts_at, ends_at FROM classes WHERE title = $1", [title]);
  assert.ok(row.ends_at < row.starts_at, "nothing was changed");
  await h.q("DELETE FROM classes WHERE title = $1", [title]);
  await h.q("DELETE FROM events WHERE title = $1", [title]);
  await h.q("DELETE FROM volunteer_shifts WHERE role = $1", [title]);
  assert.doesNotMatch((await h.get("/admin/sessions")).text, /data-bad-ranges/);
});
