// Script 3 of docs/testing/manual-test-scripts.md: the new member.
//
// A test member account is created and confirmed through emails, which tests
// cannot read. So: the sign-up steps that need no email run (and, with
// E2E_ALLOW_WRITES=1, create ONE tagged unconfirmed account that can never
// log in), and everything after "log in" uses the member account you supply
// in E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD (a member created in admin, then
// given a password through "Forgot password" once, by hand).
// Nothing here changes that account's password, deletes it or locks it.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const e2e = require("../helpers/harness");
const { has } = require("../helpers/pages");
const cfg = require("../helpers/config");

const s = e2e.persona("member");
const memberCreds = () => cfg.credentials("member");
let signup = null; // { email, password } of the tagged account M3 creates
let thread = null; // address of the tagged forum thread M20 creates

// ---- 3A. Sign up, confirm, choose a password, log in ----

s.test("M1 (must) the sign-up page has Name, Email and the password rule", { anon: true }, async (ctx) => {
  await ctx.goto("/signup");
  const labels = await ctx.page.$$eval("form[action='/signup'] label", (l) => l.map((x) => x.textContent.trim().toLowerCase()));
  assert.ok(labels.includes("name") && labels.includes("email"), `labels: ${labels}`);
  // Until the follow-up change removes it, the form still has a password field.
  if (await ctx.page.$("#password")) {
    has(await ctx.text(), /At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a symbol/);
    assert.ok(await ctx.page.$(".password-toggle"), "Show button");
  }
});

s.test("M2 a weak password is refused by the form", { anon: true }, async (ctx) => {
  await ctx.goto("/signup");
  if (!(await ctx.page.$("#password"))) ctx.skip("the sign-up form no longer asks for a password");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Weak`);
  await ctx.page.type("#email", cfg.testEmail("weak"));
  await ctx.page.type("#password", "abc");
  const v = await ctx.page.$eval("#password", (i) => ({ short: i.validity.tooShort || i.validity.patternMismatch, ok: i.checkValidity() }));
  assert.equal(v.ok, false);
  await ctx.page.click("form[action='/signup'] button[type='submit']");
  assert.equal(new URL(ctx.page.url()).pathname, "/signup", "nothing was sent");
});

s.write("M2b a known-breached password is refused by the server", { anon: true }, async (ctx) => {
  await ctx.goto("/signup");
  if (!(await ctx.page.$("#password"))) ctx.skip("the sign-up form no longer asks for a password");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Breached`);
  await ctx.page.type("#email", cfg.testEmail("breached"));
  await ctx.page.type("#password", "Password123!");
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/signup'] button[type='submit']")]);
  const text = await ctx.text();
  if (/Check your inbox/i.test(text)) {
    // The breach check could not run, so an account was made: say so loudly.
    ctx.created("sign-up with a breached password was ACCEPTED (breach check unavailable?)", cfg.testEmail("breached"), "admin Accounts > Erase Member");
    assert.fail("the site accepted a known-breached password");
  }
  has(text, /known data breach/);
});

s.write("M3 (must) sign up creates an unconfirmed account and shows the check-your-inbox message", { anon: true }, async (ctx) => {
  const email = cfg.testEmail("member-signup");
  const password = `Zq9!${crypto.randomBytes(8).toString("hex")}`;
  await ctx.goto("/signup");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Test Member One`);
  await ctx.page.type("#email", email);
  const asksPassword = Boolean(await ctx.page.$("#password"));
  if (asksPassword) await ctx.page.type("#password", password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/signup'] button[type='submit']")]);
  has(await ctx.text(), /Check your inbox/);
  assert.equal(await ctx.page.$("form[action='/logout']"), null, "not logged in after signing up");
  signup = { email, password: asksPassword ? password : null };
  ctx.created("unconfirmed account (cannot log in: its email is example.invalid)", `${process.env.E2E_RUN_ID} Test Member One <${email}>`, "admin Accounts > search the tag > Erase Member");
});

s.write("M4 (must) logging in with the unconfirmed address gives the same 'Incorrect email or password' as an unknown address", { anon: true }, async (ctx) => {
  if (!signup) ctx.skip("needs M3 to have created the account");
  // The sign-up form no longer asks for a password, so no right password exists yet: a login attempt is
  // refused exactly like an unknown address (nothing is revealed about the account).
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", signup.email);
  await ctx.page.type("form[action='/login'] #password", `Zq9!${crypto.randomBytes(8).toString("hex")}`);
  const [res] = await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.equal(res.status(), 401);
  has(await ctx.text(), /Incorrect email or password\./);
  if (signup.password) {
    // Older form with a password: the site says to confirm first and offers a new link.
    await ctx.goto("/login");
    await ctx.page.type("form[action='/login'] #email", signup.email);
    await ctx.page.type("form[action='/login'] #password", signup.password);
    await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
    has(await ctx.text(), /Please confirm your email first/);
  }
});

s.manual("M5 open the confirmation email and click the link", "needs the emailed link");
s.manual("M6 choose a password after confirming", "needs the emailed link");

s.test("M7 (must) the member test account can log in and the header shows Log Out", async (ctx) => {
  const c = memberCreds();
  await ctx.goto("/login");
  await ctx.page.type("form[action='/login'] #email", c.email);
  await ctx.page.type("form[action='/login'] #password", c.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
  assert.notEqual(new URL(ctx.page.url()).pathname, "/login", "still on the login page");
  assert.ok(await ctx.page.$("form[action='/logout'] button"), "the person icon is now Log Out");
  await ctx.keepSession("member");
});

s.write("M8 (must) signing up again with the same address shows the same message", { anon: true }, async (ctx) => {
  if (!signup) ctx.skip("needs M3 to have created the account");
  await ctx.goto("/signup");
  await ctx.page.type("#displayName", `${process.env.E2E_RUN_ID} Test Member One`);
  await ctx.page.type("#email", signup.email);
  if (await ctx.page.$("#password")) await ctx.page.type("#password", signup.password);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/signup'] button[type='submit']")]);
  has(await ctx.text(), /Check your inbox/);
});

s.test("M-FR1 FR check (sign-up): the sign-up page is in French", { anon: true, lang: "fr" }, async (ctx) => {
  await ctx.goto("/signup");
  const text = await ctx.text();
  for (const re of [/Créer votre compte/, /Nom/, /E-mail/, /Créer mon compte/]) has(text, re);
  if (await ctx.page.$("#password")) has(text, /Mot de passe/);
});

// ---- 3B. Wrong password, lockout, forgot and reset ----

s.test("M9 (must) a wrong password and an unknown email give the same message", { anon: true, needs: ["member"] }, async (ctx) => {
  // One wrong attempt on the test account (the lock needs 5); the next right login clears it.
  const tries = [[memberCreds().email, `Wrong-${crypto.randomBytes(6).toString("hex")}!1`], [cfg.testEmail("nobody"), "Wrong-Password-1!"]];
  const seen = [];
  for (const [email, password] of tries) {
    await ctx.goto("/login");
    await ctx.page.type("form[action='/login'] #email", email);
    await ctx.page.type("form[action='/login'] #password", password);
    await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/login'] button[type='submit']")]);
    seen.push(await ctx.page.$eval(".error-box", (e) => e.textContent.trim()));
  }
  assert.equal(seen[0], "Incorrect email or password.");
  assert.equal(seen[1], seen[0]);
});

s.manual("M10 five wrong passwords lock the account for 15 minutes", "would lock the test account for 15 minutes and break the rest of the run; use a throwaway account by hand");

s.test("M11 (must) forgot password gives the same message for an address with no account", { anon: true }, async (ctx) => {
  await ctx.goto("/login");
  await ctx.page.click("a[href='/forgot-password']");
  await ctx.page.waitForSelector("form[action='/forgot-password']");
  await ctx.page.type("form[action='/forgot-password'] input[name='email']", cfg.testEmail("no-account"));
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/forgot-password'] button[type='submit']")]);
  has(await ctx.text(), /If an account exists for that email, we've sent a password reset link|we.ve sent a password reset link/);
});

s.manual("M11b the reset email, its link and setting a new password", "needs the emailed link");
s.manual("M12 using the same reset link twice", "needs the emailed link");

// ---- 3C. Membership (payment) ----

s.manual("M13 (must) pay for membership with the HelloAsso form and see the member area open", "a HelloAsso payment; the tests never pay");

s.test("M14 the Membership Terms page opens and is linked from the membership page", { anon: true }, async (ctx) => {
  await ctx.goto("/membership-terms.html");
  has(await ctx.text(), /Membership Terms/);
  await ctx.goto("/membership.html");
  if (!ctx.preview) assert.ok(await ctx.page.$("a[href*='membership-terms']"), "terms linked from the membership page");
});

// ---- 3D / 3E. Member area ----

s.test("M15 (must) Member's Access shows announcements, charity, forum, meetings, volunteer and change password", { as: "member" }, async (ctx) => {
  await ctx.goto("/dashboard");
  assert.equal(new URL(ctx.page.url()).pathname, "/dashboard", "the member test account must be a member (admin: Mark as Member)");
  const text = await ctx.text();
  for (const re of [/Member.s Access/, /Welcome back/, /Announcements/, /Charity We Support/, /Community Forum/, /Meetings Calendar/, /Change Password/]) has(text, re);
});

s.test("M16 (must) My Account shows orders, two-step, privacy and book requests", { as: "member" }, async (ctx) => {
  await ctx.goto("/account");
  const text = await ctx.text();
  for (const re of [/My Account/, /Orders/, /Two-step verification/, /Privacy: download or delete my data/, /My book requests/]) has(text, re);
});

s.manual("M17 cancel a book request from My Account and ask for another", "needs a confirmed book request, which needs an emailed link");

s.test("M18 a wrong current password is refused when changing the password", { as: "member" }, async (ctx) => {
  // Only the refusal is tested: changing the password would break the next run.
  await ctx.goto("/account/password");
  const fields = await ctx.page.$$eval("form[action='/account/password'] input[type='password']", (i) => i.map((x) => x.name));
  assert.ok(fields.length >= 2, `password fields: ${fields}`);
  const bad = `Wrong-${crypto.randomBytes(6).toString("hex")}!1`;
  const next = `Next-${crypto.randomBytes(6).toString("hex")}!1`;
  await ctx.page.$eval("form[action='/account/password']", (f, bad2, next2) => {
    const inputs = [...f.querySelectorAll("input[type='password']")];
    inputs[0].value = bad2;
    inputs.slice(1).forEach((i) => { i.value = next2; });
  }, bad, next);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/account/password'] button[type='submit']")]);
  has(await ctx.text(), /current password is incorrect|incorrect/);
});
s.manual("M18b changing the password for real and logging in again with it", "would change the test account's password, which the next run needs");

s.test("M19 a hearted book stays in favorites in the same browser", { as: "member" }, async (ctx) => {
  const list = await e2e.books();
  if (!list.length) ctx.skip("data: no in-stock book");
  await ctx.goto(`/books/${list[0].id}`);
  await ctx.page.click(".book-detail-cover-wrap .favorite-toggle");
  await ctx.goto("/favorites", "networkidle2");
  await ctx.page.waitForFunction((t) => document.body.innerText.includes(t), {}, list[0].title);
});

s.write("M20 (must) start a forum thread with a tagged title", { as: "member" }, async (ctx) => {
  const tag = process.env.E2E_RUN_ID;
  await ctx.goto("/forum/new");
  await ctx.page.type("#title", `${tag} test thread`);
  await ctx.page.type("#body", `${tag} automated test post: please ignore.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/forum/new'] button[type='submit']")]);
  has(await ctx.text(), new RegExp(tag));
  ctx.created("forum thread", `${tag} test thread`, ctx.page.url());
  thread = ctx.page.url();
});

s.write("M21 reply to the tagged thread", { as: "member" }, async (ctx) => {
  if (!thread) ctx.skip("needs M20");
  await ctx.goto(thread);
  await ctx.page.type("form[action$='/replies'] textarea[name='body']", `${process.env.E2E_RUN_ID} automated test reply.`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action$='/replies'] button[type='submit']")]);
  has(await ctx.text(), /automated test reply/);
});

s.write("M22 (must) report the tagged thread (sends an email to the shop mailbox)", { as: "member" }, async (ctx) => {
  if (!thread) ctx.skip("needs M20");
  await ctx.goto(thread);
  await ctx.page.$eval("details.report-post", (d) => { d.open = true; });
  const form = "details.report-post form[action='/forum/report']";
  const reason = await ctx.page.$eval(`${form} select[name='reason'] option:not([value=''])`, (o) => o.value);
  await ctx.page.select(`${form} select[name='reason']`, reason);
  await ctx.page.type(`${form} textarea[name='comment']`, `${process.env.E2E_RUN_ID} automated test report: ignore`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  has(await ctx.text(), /Thanks, we will review it/);
});

s.test("M23 logged out, /forum shows the login page", { anon: true }, async (ctx) => {
  await ctx.goto("/forum");
  assert.equal(new URL(ctx.page.url()).pathname, "/login");
});

s.test("M24 (must) the charity page shows the open vote, or says none is open", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const text = await ctx.text();
  assert.ok(/No vote is open right now/i.test(text) || (/Submit My Votes|votes?\b/i.test(text)), "vote or 'No vote is open'");
});

s.write("M24b vote in the open round (counted in the real vote results)", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const box = await ctx.page.$("form[action='/charity/vote'] input[name='optionIds']");
  if (!box) ctx.skip("no open vote the test member can still vote in");
  await box.click();
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click("form[action='/charity/vote'] button[type='submit']")]);
  has(await ctx.text(), /\b1 vote/);
  ctx.created("charity vote cast", memberCreds().email.replace(/(.).*@/, "$1***@"), "admin Charities > the round (a test vote)");
});

s.write("M25 suggest a charity with a tagged name", { as: "member" }, async (ctx) => {
  await ctx.goto("/charity");
  const form = "form[action='/charity/ideas']";
  if (!(await ctx.page.$(form))) ctx.skip("the charity page has no suggestion form");
  await ctx.page.type(`${form} #idea-name`, `${process.env.E2E_RUN_ID} charity`);
  await ctx.page.type(`${form} #idea-description`, `${process.env.E2E_RUN_ID} test idea`);
  await Promise.all([ctx.page.waitForNavigation(), ctx.page.click(`${form} button[type='submit']`)]);
  has(await ctx.text(), /Pending review/);
  ctx.created("charity idea", `${process.env.E2E_RUN_ID} charity`, "admin Charities > Submitted Ideas");
});

s.test("M26 RSVP to a meeting and cancel again", { as: "member" }, async (ctx) => {
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

s.manual("M27 events sign-up while logged in", "the same as V23, which is covered there (needs E2E_ALLOW_WRITES=1)");

s.test("M-FR21 FR check (member area): dashboard, forum, charity, meetings and account in French", { as: "member", lang: "fr" }, async (ctx) => {
  const checks = [["/dashboard", [/Espace membres/, /Annonces/]], ["/forum", [/Forum de la communauté/]], ["/charity", [/Vote pour une association/]], ["/meetings", [/Réunions/]], ["/account", [/Mon compte|Mes demandes/]]];
  for (const [p, res] of checks) {
    await ctx.goto(p);
    const text = await ctx.text();
    for (const re of res) has(text, re, p);
  }
});

// ---- 3F. Privacy page ----

s.test("M28 (must) Download my data returns a JSON file with the member's own data", { as: "member" }, async (ctx) => {
  await ctx.goto("/account/privacy");
  has(await ctx.text(), /Download my data|Confirm your email address first/);
  const result = await ctx.page.evaluate(async (password) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/account/privacy/export", { method: "POST", body: new URLSearchParams({ _csrf: token, currentPassword: password }) });
    return { status: r.status, disposition: r.headers.get("content-disposition"), body: await r.text() };
  }, memberCreds().password);
  if (result.status === 403) ctx.skip("the member test account's email is not confirmed yet");
  assert.equal(result.status, 200);
  assert.match(result.disposition || "", /umasbooks-my-data\.json/);
  const data = JSON.parse(result.body);
  assert.ok(JSON.stringify(data).includes(memberCreds().email), "the file holds the member's own email");
});

s.test("M29 (must) account deletion refuses a wrong password and a missing confirmation word (nothing is deleted)", { as: "member" }, async (ctx) => {
  // NEVER submits the right password together with the confirmation word.
  await ctx.goto("/account/privacy");
  const post = (password, word) => ctx.page.evaluate(async (pw, w) => {
    const { token } = await (await fetch("/api/csrf-token")).json();
    const r = await fetch("/account/privacy/delete", { method: "POST", body: new URLSearchParams({ _csrf: token, currentPassword: pw, confirmation: w }), redirect: "manual" });
    return { status: r.status, body: r.type === "opaqueredirect" ? "" : await r.text() };
  }, password, word);
  const wrongPassword = await post(`Wrong-${crypto.randomBytes(6).toString("hex")}!1`, "x");
  assert.equal(wrongPassword.status, 401);
  has(wrongPassword.body, /Current password is incorrect/);
  const noWord = await post(memberCreds().password, "not-the-word");
  if (noWord.status === 403) ctx.skip("the member test account is an admin or is unconfirmed: the deletion form says so");
  assert.equal(noWord.status, 400);
  has(noWord.body, /Type DELETE in the confirmation box/);
  await ctx.goto("/account");
  assert.equal(new URL(ctx.page.url()).pathname, "/account", "still logged in, account intact");
});
s.manual("M29b really delete a throwaway account and check the goodbye email", "destructive and needs a mailbox; do it by hand on a throwaway account");
s.manual("M30 an erased account no longer appears in admin Members", "needs a deleted account (M29b)");

// ---- 3G. Language saved, emails ----

s.manual("M31 (must) emails follow the language chosen on the site (reset email in FR and EN)", "needs a mailbox");
s.manual("M32 order or request emails in French for a logged-in member", "needs a payment or an emailed link, and a mailbox");
