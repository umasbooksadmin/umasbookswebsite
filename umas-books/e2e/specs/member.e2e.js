// Script 3 of docs/testing/manual-test-scripts.md: the member.
//
// A member is an account holder who also paid the membership fee (is_member
// true; HelloAsso payment matched by email, which expires after 365 days, or
// an admin pressing "Mark as Member", which has no end date). The payment is
// manual-only (the tests never pay), so these tests use the account you supply
// in E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD: a confirmed account an admin
// marked as member. Nothing here assumes the member has bought anything: the
// tests pass for a member with no orders at all. Nothing here changes that
// account's password, deletes it or locks it.

const assert = require("node:assert/strict");
const e2e = require("../helpers/harness");
const { has, hasNot } = require("../helpers/pages");
const cfg = require("../helpers/config");

const s = e2e.persona("member");
const memberCreds = () => cfg.credentials("member");
let thread = null; // address of the tagged forum thread M5 creates

// ---- 3A. Becoming a member ----

s.manual("M1 (must) pay for membership with the HelloAsso form and see the member area open", "a HelloAsso payment; the tests never pay");

s.test("M2 the Membership Terms page opens and is linked from the membership page", { anon: true }, async (ctx) => {
  await ctx.goto("/membership-terms.html");
  has(await ctx.text(), /Membership Terms/);
  await ctx.goto("/membership.html");
  if (!ctx.preview) assert.ok(await ctx.page.$("a[href*='membership-terms']"), "terms linked from the membership page");
});

s.manual("M3 (must) an admin presses Mark as Member on a confirmed account; the account then reaches Member's Access", "an admin action on the member test account, done once when that account is set up (M4 proves the result)");

// ---- 3B. Member area ----

s.test("M4 (must) Member's Access shows announcements, charity, forum, meetings, volunteer and change password", { as: "member" }, async (ctx) => {
  await ctx.goto("/dashboard");
  assert.equal(new URL(ctx.page.url()).pathname, "/dashboard", "the member test account must be a member (admin: Mark as Member)");
  const text = await ctx.text();
  for (const re of [/Member.s Access/, /Welcome back/, /Announcements/, /Charity We Support/, /Community Forum/, /Meetings Calendar/, /Change Password/]) has(text, re);
});

s.test("M12 (must) the Announcements page opens for a member", { as: "member" }, async (ctx) => {
  await ctx.goto("/announcements");
  assert.equal(new URL(ctx.page.url()).pathname, "/announcements", "the member test account must be a member (admin: Mark as Member)");
  has(await ctx.text(), /Announcements/);
});

s.test("M17 (must) Home shows the public home page to a logged-in member, with Member's Access still in the header", { as: "member" }, async (ctx) => {
  await ctx.goto("/");
  assert.equal(new URL(ctx.page.url()).pathname, "/", "Home must not redirect a member to Member's Access");
  assert.ok(await ctx.page.$("a.h-tool[href='/dashboard']"), "Member's Access link in the header");
  assert.ok(await ctx.page.$("form[action='/logout']"), "Log Out in the header");
  hasNot(await ctx.text(), /Welcome back/, "the public home page, not Member's Access");
});

s.write("M5 (must) start a forum thread with a tagged title", { as: "member" }, async (ctx) => {
  const tag = process.env.E2E_RUN_ID;
  await ctx.goto("/forum/new");
  await ctx.page.type("#title", `${tag} test thread`);
  await ctx.page.type("#body", `${tag} automated test post: please ignore.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/forum/new'] button[type='submit']")]);
  has(await ctx.text(), new RegExp(tag));
  ctx.created("forum thread", `${tag} test thread`, ctx.page.url());
  thread = ctx.page.url();
});

s.write("M6 reply to the tagged thread", { as: "member" }, async (ctx) => {
  if (!thread) ctx.skip("needs M5");
  await ctx.goto(thread);
  await ctx.page.type("form[action$='/replies'] textarea[name='body']", `${process.env.E2E_RUN_ID} automated test reply.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action$='/replies'] button[type='submit']")]);
  has(await ctx.text(), /automated test reply/);
});

s.write("M7 (must) report the tagged thread (sends an email to the shop mailbox)", { as: "member" }, async (ctx) => {
  if (!thread) ctx.skip("needs M5");
  await ctx.goto(thread);
  await ctx.page.$eval("details.report-post", (d) => { d.open = true; });
  const form = "details.report-post form[action='/forum/report']";
  const reason = await ctx.page.$eval(`${form} select[name='reason'] option:not([value=''])`, (o) => o.value);
  await ctx.page.select(`${form} select[name='reason']`, reason);
  await ctx.page.type(`${form} textarea[name='comment']`, `${process.env.E2E_RUN_ID} automated test report: ignore`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  has(await ctx.text(), /Thanks, we will review it/);
});

s.test("M8 (must) the charity page shows the open vote, or says none is open", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const text = await ctx.text();
  assert.ok(/No vote is open right now/i.test(text) || (/Submit My Votes|votes?\b/i.test(text)), "vote or 'No vote is open'");
});

s.write("M8b vote in the open round (counted in the real vote results)", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const box = await ctx.page.$("form[action='/charity/vote'] input[name='optionIds']");
  if (!box) ctx.skip("no open vote the test member can still vote in");
  await box.click();
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/charity/vote'] button[type='submit']")]);
  has(await ctx.text(), /\b1 vote/);
  ctx.created("charity vote cast", memberCreds().email.replace(/(.).*@/, "$1***@"), "admin Charities > the round (a test vote)");
});

s.write("M9 suggest a charity with a tagged name", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const form = "form[action='/charity/ideas']";
  if (!(await ctx.page.$(form))) ctx.skip("the charity page has no suggestion form");
  await ctx.page.type(`${form} #idea-name`, `${process.env.E2E_RUN_ID} charity`);
  await ctx.page.type(`${form} #idea-description`, `${process.env.E2E_RUN_ID} test idea`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  has(await ctx.text(), /Pending review/);
  ctx.created("charity idea", `${process.env.E2E_RUN_ID} charity`, "admin Charities > Submitted Ideas");
});

s.test("M10 RSVP to a meeting and cancel again", { as: "member" }, async (ctx) => {
  const open = () => ctx.page.$$eval("details.calendar-pill", (ds) => ds.forEach((d) => { d.open = true; }));
  await ctx.goto("/meetings");
  await open();
  if (await ctx.page.$("form[action*='/unrsvp']")) ctx.skip("the member test account already has an RSVP: not touching it");
  const rsvp = await ctx.page.$("form[action*='/rsvp?']");
  if (!rsvp) ctx.skip("data: no upcoming meeting to RSVP to");
  await Promise.all([ctx.page.waitForNavigation(), rsvp.$eval("button[type='submit']", (b) => b.click())]);
  await open();
  const cancel = await ctx.page.$("form[action*='/unrsvp']");
  assert.ok(cancel, "the button became Cancel RSVP");
  has(await cancel.evaluate((f) => f.innerText), /Cancel RSVP/);
  await Promise.all([ctx.page.waitForNavigation(), cancel.$eval("button[type='submit']", (b) => b.click())]);
  await open();
  assert.equal(await ctx.page.$("form[action*='/unrsvp']"), null, "the RSVP is gone again");
});

s.manual("M11 events sign-up while logged in", "the same as G23, which is covered there (needs E2E_ALLOW_WRITES=1)");

s.test("M-FR11 FR check (member area): dashboard, forum, charity, meetings and account in French", { as: "member", lang: "fr" }, async (ctx) => {
  const checks = [["/dashboard", [/Espace membres/, /Annonces/]], ["/forum", [/Forum de la communauté/]], ["/charity", [/Vote pour une association/]], ["/meetings", [/Réunions/]], ["/account", [/Mon compte|Mes demandes/]]];
  for (const [p, res] of checks) {
    await ctx.goto(p);
    const text = await ctx.text();
    for (const re of res) has(text, re, p);
  }
});

// ---- 3C. How long membership lasts ----

s.manual("M13 (must) a membership an admin granted has no end date and never lapses", "needs an admin look: admin > Accounts > the member shows no 'Membership' end date (a paid one shows the date a year after the payment)");
s.manual("M14 (must) a paid member whose year has run out loses access to the member pages", "real time must pass; check the same effect with the admin toggle (Remove Member Status), then see AC44 to AC49 for what an account holder gets");

// ---- 3E. The membership page for a member ----
//
// Becoming a member needs an account (pull request #201).

s.test("M15 (must) the membership page tells a member their status instead of showing the payment form", { as: "member" }, async (ctx) => {
  if (ctx.preview) ctx.skip("preview mode: the membership page only says 'Membership opens at launch'");
  await ctx.goto("/membership.html");
  const text = await ctx.text();
  // Inside the last 30 days of a paid membership the payment form comes back (M16): that is not a failure of the test account.
  if (/You can renew from this page/i.test(text) === false && (await ctx.page.$("#haWidget"))) assert.fail("a current member must see their status, not the payment form");
  has(text, /You are a member (until \d{4}-\d{2}-\d{2}|, with no end date)|You are a member/);
  assert.equal(await ctx.page.$("form[action='/membership/join']"), null, "no sign-up form for a member");
});

s.manual("M16 the renewal window: in the last 30 days the payment form comes back", "needs a paid membership about a year old (or a changed end date in a test copy)");
