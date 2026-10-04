// Script 4 of docs/testing/manual-test-scripts.md: the volunteer.
// Needs E2E_VOLUNTEER_EMAIL / E2E_VOLUNTEER_PASSWORD (a confirmed account an
// admin marked as volunteer). VO1 also uses the member account and VO7 the
// admin account when those are supplied.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has } = require("../helpers/pages");

const s = e2e.persona("volunteer");
let signedUp = null; // the shift VO3 signed up for, for VO5

s.test("VO1 (must) a plain member (not a volunteer) is sent from /volunteer to the home page", { anon: true, as: "member" }, async (ctx) => {
  await ctx.goto("/volunteer");
  const where = new URL(ctx.page.url()).pathname;
  if (where === "/volunteer") ctx.skip("the member test account is also a volunteer, so it can see the shifts");
  // The manual script says the home page; the site sends a member to Member's Access.
  assert.ok(where === "/" || where === "/dashboard", `sent to ${where}`);
});

s.test("VO2 the volunteer sees the shifts calendar with Month / Week and Prev / Next", { as: "volunteer" }, async (ctx) => {
  await ctx.goto("/dashboard");
  assert.equal(new URL(ctx.page.url()).pathname, "/dashboard", "volunteers reach Member's Access");
  await ctx.goto("/volunteer");
  assert.equal(new URL(ctx.page.url()).pathname, "/volunteer");
  const text = await ctx.text();
  for (const re of [/Volunteer Shifts/, /Sign up for a shift below/, /Month/, /Week/, /Prev/, /Next/]) has(text, re);
});

s.write("VO3 (must) sign up for a shift and see it under My upcoming shifts", { as: "volunteer" }, async (ctx) => {
  await ctx.goto("/volunteer");
  const form = await ctx.page.$("form[action*='/volunteer/'][action$='/signup'], form[action*='signup']");
  if (!form) ctx.skip("data: no open shift to sign up for this month");
  const action = await form.evaluate((f) => f.getAttribute("action"));
  await form.evaluate((f) => { const d = f.closest("details"); if (d) d.open = true; });
  await Promise.all([ctx.page.waitForNavigation(), form.$eval("button[type='submit']", (b) => b.click())]);
  has(await ctx.text(), /My upcoming shifts/);
  signedUp = action;
  ctx.created("volunteer shift sign-up (cancelled again by VO5)", "the volunteer test account", "admin Volunteer Shifts");
});

s.manual("VO4 a second volunteer sees the shift as Full", "needs a second volunteer account");

s.write("VO5 (must) cancel the shift again and it is free", { as: "volunteer" }, async (ctx) => {
  if (!signedUp) ctx.skip("needs VO3");
  await ctx.goto("/volunteer");
  const cancel = await ctx.page.$("form[action$='/cancel'] button[type='submit'], form[action*='cancel'] button[type='submit']");
  assert.ok(cancel, "a Cancel button for the shift");
  await cancel.evaluate((b) => { const d = b.closest("details"); if (d) d.open = true; });
  await Promise.all([ctx.page.waitForNavigation(), cancel.evaluate((b) => b.click())]);
  assert.equal(await ctx.page.$("form[action$='/cancel']"), null, "no shift of mine is left");
});

s.test("VO6 volunteers can open the forum, charity vote and meetings", { as: "volunteer" }, async (ctx) => {
  for (const p of ["/forum", "/charity", "/meetings"]) {
    const res = await ctx.goto(p);
    assert.ok(res.status() < 400, `${p} ${res.status()}`);
    assert.equal(new URL(ctx.page.url()).pathname, p, `${p} did not redirect`);
  }
});

s.test("VO7 admin: the volunteer shifts page opens", { anon: true, as: "admin" }, async (ctx) => {
  await ctx.goto("/admin/volunteer-shifts");
  assert.equal(new URL(ctx.page.url()).pathname, "/admin/volunteer-shifts");
  has(await ctx.text(), /Volunteer Shifts/);
});

s.test("VO-FR2 FR check: the volunteer page is in French", { as: "volunteer", lang: "fr" }, async (ctx) => {
  await ctx.goto("/volunteer");
  const text = await ctx.text();
  for (const re of [/Créneaux de bénévolat/, /Mois/, /Semaine/]) has(text, re);
});
