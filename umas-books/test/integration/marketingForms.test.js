// The pre-registration and volunteer forms (routes/marketingForms.js): they
// were "mailto:" links with no validation. In-process, so sendMail can be
// stubbed (the route destructures it at require time) and each test gets a
// fresh copy of the router (its rate limiter is module-level state).
//
// Covers: validation errors (accessible: aria-invalid, aria-describedby, an
// error summary with role="alert"), consent required, honeypot, rate limit,
// the email's content, French pages, and that nothing typed reaches the logs.
// CSRF and the real page flow are in marketingFormsApp.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");


const db = prepareDatabase("mktforms", { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let sendImpl;
mailer.sendMail = async (opts) => sendImpl(opts);

const { pool } = require("../../src/db");

const ROUTE = path.join(__dirname, "..", "..", "src", "routes", "marketingForms.js");
const EXPECTED_TO = process.env.CONTACT_TO || "admin@umasbooks.org";

before(() => db.create());
after(async () => {
  await pool.end();
  db.drop();
});
beforeEach(() => {
  sent.length = 0;
  sendImpl = async (opts) => { sent.push(opts); };
});

// The two form pages as src/index.js serves them (their GET shows what a refused POST left in the session).
function pagesRouter(forms) {
  const { renderMarketing } = require("../../src/lib/pageDictionary");
  const { marketingCsp } = require("../../src/lib/marketingCsp");
  const { setMarketingSeoLocals } = require("../../src/routes/seo");
  const r = express.Router();
  for (const file of ["pre-registration.html", "volunteer.html"]) {
    r.get("/" + file, (req, res, next) => {
      res.set("Content-Security-Policy", marketingCsp());
      setMarketingSeoLocals(req, res, "/" + file);
      forms.prepareFormPage(res);
      forms.setFormState(req, res, file);
      renderMarketing(req, res, next, "marketing/" + file.replace(/\.html$/, ""));
    });
  }
  return r;
}

async function withApp(fn) {
  delete require.cache[ROUTE];
  const forms = require(ROUTE);
  const server = await listen(buildApp([forms, pagesRouter(forms)]));
  try {
    // A refused POST answers 303 and the page is the GET it points to (a browser follows it with the same
    // session). `res` is the POST's own answer; `text` is the page the person ends up on.
    let cookie = "";
    const post = async (pathname, fields, headers = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
      const res = await fetch(`${server.base}${pathname}`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers, cookie: [cookie, headers.cookie].filter(Boolean).join("; ") },
        body: body.toString(),
      });
      const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
      if (set.length) cookie = set.join("; ");
      if (res.status === 303) {
        const page = await fetch(`${server.base}${res.headers.get("location")}`, { redirect: "manual", headers: { ...headers, cookie: [cookie, headers.cookie].filter(Boolean).join("; ") } });
        return { res, text: await page.text(), page };
      }
      return { res, text: await res.text() };
    };
    await fn({ base: server.base, post });
  } finally {
    await server.close();
  }
}

const PREREG = {
  who: "child", childFirst: "Léa", childLast: "Martin", birthYear: String(new Date().getFullYear() - 8), guardian: "1", session: "young-adventurers",
  days: ["tue", "sat"], times: ["morning", "evening"],
  parent: "Claire Martin", email: "claire@example.test", phone: "+33 6 12 34 56 78",
  level: "Beginner", notes: "Loves dinosaurs", updates: "1", consent: "1",
};
// An adult registering for themselves: no child section, no guardian statement.
const ADULT = {
  who: "self", session: "english-cafe", days: ["wed"], times: ["evening"],
  parent: "Sam Adult", email: "sam.adult@example.test", phone: "0612345678", consent: "1",
};
// A post from the OLD form (still open in a browser tab at deploy time): full date of birth, one consent box.
const OLD_FORM = {
  childFirst: "Léa", childLast: "Martin", dob: "2018-04-12", session: "young-adventurers",
  days: ["tue", "sat"], times: ["morning", "evening"],
  parent: "Claire Martin", email: "claire@example.test", phone: "+33 6 12 34 56 78",
  level: "Beginner", notes: "Loves dinosaurs", updates: "1", consent: "1",
};
const VOLUNTEER = { name: "Sam Lee", email: "sam@example.test", availability: "Saturday mornings", note: "I speak English and French", consent: "1" };
const PRE = "/pre-registration";
const VOL = "/volunteer-signup";

test("pre-registration: a valid submission sends ONE email to the contact inbox and redirects to the thank-you state", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(PRE, PREREG);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/pre-registration.html?sent=1");
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.equal(mail.to, EXPECTED_TO);
    assert.deepEqual(mail.replyTo, { name: "Claire Martin", address: "claire@example.test" });
    assert.equal(mail.subject, "Website pre-registration: Young Adventurers (Age 5–9)");
    for (const line of [
      "Registering: A parent or guardian, for a child", "First name: Léa", "Last name: Martin", `Year of birth: ${PREREG.birthYear}`, "Session: Young Adventurers (Age 5–9)",
      "Days: Tuesday, Saturday", "Times: Morning, Evening",
      "Name: Claire Martin", "Email: claire@example.test", "Phone: +33 6 12 34 56 78",
      "English level: Beginner", "Notes: Loves dinosaurs", "Wants program updates: yes",
      "parent or legal guardian confirmed they are the child's parent or legal guardian and agree to be contacted", "Site language: English", "12 months",
    ]) assert.ok(mail.text.includes(line), `email contains "${line}"`);
    assert.ok(!/Date of birth/.test(mail.text), "no full date of birth is asked for or sent");
    // The subject (which a mail relay without credentials would log) has no personal data.
    assert.ok(!/Léa|Martin|claire/i.test(mail.subject));
  });
});

test("pre-registration: the email stays English for staff but notes the visitor's language (French)", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(PRE, PREREG, { cookie: "umasbooks_lang=fr" });
    assert.equal(res.status, 302);
    assert.match(sent[0].text, /New pre-registration from the website/);
    assert.match(sent[0].text, /Site language: French/);
  });
});

test("pre-registration: every required field is enforced for a child, with an accessible error summary and field errors (EN)", async () => {
  await withApp(async ({ post }) => {
    const { res, text, page } = await post(PRE, { website: "", who: "child", childFirst: "  ", birthYear: "2999", email: "nope", phone: "12" });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/pre-registration.html", "a refused form goes back to its page (Post/Redirect/Get)");
    assert.equal(sent.length, 0);
    // Summary: role=alert, first thing in the form area, links to each field.
    assert.match(text, /<div class="form-error-summary" id="form-errors" role="alert" tabindex="-1" data-form-errors>/);
    for (const id of ["preg-first", "preg-last", "preg-birthyear", "preg-guardian", "preg-session", "preg-parent", "preg-email", "preg-phone", "preg-consent"]) {
      assert.ok(text.includes(`href="#${id}"`), `summary links to #${id}`);
      assert.match(text, new RegExp(`<[^>]*id="${id}"[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*${id}-err`), `${id} is aria-invalid and described by its error`);
      assert.ok(text.includes(`id="${id}-err"`), `${id} has its error text`);
    }
    // The day and time groups are fieldsets (a group is described by its error; aria-invalid is not allowed on it).
    for (const id of ["preg-days", "preg-times"]) {
      assert.ok(text.includes(`href="#${id}"`), `summary links to #${id}`);
      assert.match(text, new RegExp(`<fieldset[^>]*id="${id}"[^>]*aria-describedby="[^"]*${id}-err`), `${id} group is described by its error`);
    }
    assert.match(text, /There is a problem/);
    assert.match(text, /Enter a valid email address/);
    assert.match(text, /Tick this box to continue/);
    assert.match(text, /Enter the year the child was born/);
    assert.match(text, /<script src="\/assets\/form-errors\.js\?v=[0-9a-f]+"><\/script>/, "focus-on-error script is loaded");
    assert.match(text, /<script src="\/assets\/preregistration\.js\?v=[0-9a-f]+"><\/script>/, "the who-is-registering script is loaded");
    // The page is not cacheable.
    assert.equal(page.headers.get("cache-control"), "private, no-store");
  });
});

test("pre-registration: an empty submission asks who is registering and does not demand child fields yet", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, {});
    assert.equal(res.status, 303);
    for (const id of ["preg-who", "preg-session", "preg-days", "preg-times", "preg-parent", "preg-email", "preg-phone", "preg-consent"]) {
      assert.ok(text.includes(`href="#${id}"`), `summary links to #${id}`);
    }
    for (const id of ["preg-first", "preg-last", "preg-birthyear", "preg-guardian"]) {
      assert.ok(!text.includes(`href="#${id}"`), `${id} is not reported before a child is chosen`);
    }
  });
});

test("pre-registration: an adult registering for themselves needs no child section and no guardian statement", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(PRE, ADULT);
    assert.equal(res.status, 302);
    assert.equal(sent.length, 1);
    const t = sent[0].text;
    assert.match(t, /Registering: An adult, for themselves/);
    assert.match(t, /Adult registering\n {2}Name: Sam Adult/);
    assert.doesNotMatch(t, /Child\n|First name|Year of birth|parent or legal guardian/i);
    assert.match(t, /The person confirmed they agree to be contacted about this program\./);
    // Child fields typed by mistake for an adult are ignored, not sent.
    const mixed = await post(PRE, { ...ADULT, childFirst: "Ignored", childLast: "Kid", birthYear: "abc" });
    assert.equal(mixed.res.status, 302);
    assert.doesNotMatch(sent[1].text, /Ignored|Kid|abc/);
  });
});

test("pre-registration: for a child the child's names, a plausible year of birth and the guardian statement are required (server-side)", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, childFirst: "", childLast: "", birthYear: "", guardian: "" });
    assert.equal(res.status, 303);
    for (const id of ["preg-first", "preg-last", "preg-birthyear", "preg-guardian"]) assert.match(text, new RegExp(`href="#${id}"`), id);
    assert.doesNotMatch(text, /href="#preg-consent"/, "the agreement to be contacted is a separate box");
    // Only the guardian box missing: the guardian error alone.
    const g = await post(PRE, { ...PREREG, guardian: "" });
    assert.equal(g.res.status, 303);
    assert.match(g.text, /href="#preg-guardian"/);
    assert.doesNotMatch(g.text, /href="#preg-first"/);
    assert.equal(sent.length, 0);
  });
});

test("pre-registration: an unknown 'who' is refused", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, who: "robot" });
    assert.equal(res.status, 303);
    assert.match(text, /href="#preg-who"/);
  });
});

test("pre-registration: the agreement to be contacted is required on its own", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, consent: "" });
    assert.equal(res.status, 303);
    assert.equal(sent.length, 0);
    assert.match(text, /href="#preg-consent"/);
    assert.doesNotMatch(text, /href="#preg-first"/, "only the consent is reported");
    assert.match(text, /type="checkbox" name="consent"[^>]*aria-invalid="true"/);
  });
});

test("pre-registration: refused values are echoed back; an unknown session, day or time is not accepted", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, session: "free-money", days: ["sun", "tue"], times: ["midnight"], notes: "keep <me>" });
    assert.equal(res.status, 303);
    assert.match(text, /value="Léa"/);
    assert.match(text, /value="claire@example\.test"/);
    assert.match(text, /keep &lt;me&gt;/);
    assert.match(text, /<input type="checkbox" name="days" value="tue" checked/);
    assert.doesNotMatch(text, /<input type="checkbox" name="days" value="sat" checked/);
    assert.match(text, /href="#preg-session"/);
    assert.match(text, /href="#preg-times"/);
    assert.doesNotMatch(text, /href="#preg-days"/, "tue is valid, the unknown day is just dropped");
  });
});

test("pre-registration: the year of birth must be four digits, not in the future and plausible for a child", async () => {
  const year = new Date().getFullYear();
  const { validatePreRegistration } = require("../../src/lib/marketingForms");
  for (const birthYear of [String(year + 1), "1800", String(year - 40), "abc", "", "98", "20188"]) {
    const r = validatePreRegistration({ ...PREREG, birthYear });
    assert.equal(r.ok, false, birthYear);
    assert.ok(r.errors.birthYear, birthYear);
  }
  for (const birthYear of [String(year), String(year - 17), String(year - 19)]) assert.equal(validatePreRegistration({ ...PREREG, birthYear }).ok, true, birthYear);
  // Through the real route (the rate limit allows 5 posts per file run, so only a few here).
  await withApp(async ({ post }) => {
    const bad = await post(PRE, { ...PREREG, birthYear: "1800" });
    assert.equal(bad.res.status, 303);
    assert.match(bad.text, /href="#preg-birthyear"/);
    assert.equal(sent.length, 0);
  });
});

test("pre-registration: a post from the old form (full date of birth, one consent box) is still understood; only the year is kept", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(PRE, OLD_FORM);
    assert.equal(res.status, 302);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Registering: A parent or guardian, for a child/);
    assert.match(sent[0].text, /Year of birth: 2018/);
    assert.doesNotMatch(sent[0].text, /2018-04-12|Date of birth/, "the day and month are not forwarded");
    const bad = await post(PRE, { ...OLD_FORM, dob: "2018-02-31" });
    assert.equal(bad.res.status, 303);
    assert.match(bad.text, /href="#preg-birthyear"/);
    assert.equal(sent.length, 1);
    assert.equal(validateOld({ ...OLD_FORM, consent: "" }).ok, false, "the old single box was both statements: still required");
  });
});

function validateOld(body) { return require("../../src/lib/marketingForms").validatePreRegistration(body); }

test("pre-registration: the page is French when the visitor's language is French (summary, field errors, labels)", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, email: "bad", consent: "" }, { cookie: "umasbooks_lang=fr" });
    assert.equal(res.status, 303);
    assert.match(text, /<h2 data-i18n="form\.err\.title">Il y a un problème<\/h2>/);
    assert.match(text, /Saisissez une adresse e-mail valide/);
    assert.match(text, /Cochez cette case pour continuer/);
    assert.match(text, /Adresse e-mail<\/span> — <span data-i18n="form\.err\.email">/);
    assert.match(text, /J’accepte d’être contacté\(e\) au sujet de ce programme\./);
    assert.match(text, /Je suis le parent ou le représentant légal de l’enfant\./);
    assert.match(text, /Qui s’inscrit\u00a0\?/);
    assert.match(text, /Année de naissance de l’enfant/);
    assert.match(text, /Ne saisissez pas d’informations de santé ici/);
  });
});

test("pre-registration: asks who is registering, shows both blocks (no-JS safe), uses checkboxes not multi-selects, forbids health information, no mailto", async () => {
  await withApp(async ({ post }) => {
    const { text } = await post(PRE, {});
    assert.match(text, /Who is registering\?/);
    assert.match(text, /<input type="radio" name="who" value="self"/);
    assert.match(text, /<input type="radio" name="who" value="child"/);
    assert.match(text, /An adult, for themselves/);
    assert.match(text, /A parent or guardian, for a child/);
    assert.match(text, /About the child \(only if you are registering a child\)/);
    assert.match(text, /I am the parent or legal guardian of the child\./);
    assert.match(text, /I agree to be contacted about this program\./);
    assert.match(text, /Child’s year of birth/);
    assert.doesNotMatch(text, /Date of birth|type="date"|name="dob"/);
    // The child block is in the page and NOT hidden until an adult is chosen: nothing needs JavaScript.
    assert.match(text, /<div id="preg-child-block" class="preg-child-block" data-child-block>/);
    const adult = await post(PRE, { ...ADULT, consent: "" });
    assert.match(adult.text, /<div id="preg-child-block" class="preg-child-block" data-child-block hidden>/);
    // Days and times: checkbox groups in a fieldset with a legend, no multi-select (no Ctrl/Cmd needed).
    assert.doesNotMatch(text, /<select[^>]*multiple|Hold Cmd/);
    for (const day of ["tue", "wed", "thu", "fri", "sat"]) assert.match(text, new RegExp(`<input type="checkbox" name="days" value="${day}"`));
    for (const t of ["morning", "earlyafternoon", "lateafternoon", "evening"]) assert.match(text, new RegExp(`<input type="checkbox" name="times" value="${t}"`));
    assert.match(text, /<fieldset class="preg-fieldset" id="preg-days"[^>]*>\s*<legend>/);
    assert.match(text, /Do not enter health information here \(allergies, medical conditions, disabilities\): tell us in person\./);
    assert.doesNotMatch(text, /data-mailto|mailto:admin@umasbooks\.org\?subject|opens your email app/i);
    assert.match(text, /<form class="preg-form" method="post" action="\/pre-registration" novalidate>/);
    // The privacy note tells the truth about the copies.
    assert.match(text, /These forms send us an email\. A copy stays in our outgoing-mail queue for up to 30 days \(90 if sending failed\) and in our backups \(up to 2 years\); then it is erased\./);
    assert.doesNotMatch(text, /nothing is stored/i);
  });
});

test("volunteer: a valid sign-up sends one email; name, email and consent are required", async () => {
  await withApp(async ({ post }) => {
    const ok = await post(VOL, VOLUNTEER);
    assert.equal(ok.res.status, 302);
    assert.equal(ok.res.headers.get("location"), "/volunteer.html?sent=1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, EXPECTED_TO);
    assert.equal(sent[0].subject, "Website volunteer sign-up");
    assert.deepEqual(sent[0].replyTo, { name: "Sam Lee", address: "sam@example.test" });
    for (const line of ["Name: Sam Lee", "Email: sam@example.test", "Availability: Saturday mornings", "Note: I speak English and French", "agree to be contacted about volunteering", "Site language: English"]) {
      assert.ok(sent[0].text.includes(line), line);
    }

    for (const bad of [{ name: "" }, { email: "x" }, { email: "" }, { consent: "" }]) {
      const { res, text } = await post(VOL, { ...VOLUNTEER, ...bad });
      assert.equal(res.status, 303, JSON.stringify(bad));
      assert.match(text, /role="alert"/);
      assert.match(text, /aria-invalid="true"/);
    }
    assert.equal(sent.length, 1, "nothing more was sent");
  });
});

test("volunteer: availability and note are optional; the page has the health line and the consent checkbox", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(VOL, { name: "Sam", email: "sam@example.test", consent: "on" });
    assert.equal(res.status, 302);
    assert.match(sent[0].text, /Availability: -/);
    const page = await post(VOL, {});
    assert.match(page.text, /Do not enter health information here: tell us in person\./);
    assert.match(page.text, /name="consent"/);
    assert.doesNotMatch(page.text, /data-mailto/);
    const fr = await post(VOL, {}, { cookie: "umasbooks_lang=fr" });
    assert.match(fr.text, /J’accepte d’être contacté\(e\) au sujet du bénévolat\./);
  });
});

test("honeypot: a filled hidden field looks like success to a bot but sends nothing (both forms)", async () => {
  await withApp(async ({ post }) => {
    const a = await post(PRE, { ...PREREG, website: "http://spam.example" });
    assert.equal(a.res.status, 302);
    assert.equal(a.res.headers.get("location"), "/pre-registration.html?sent=1");
    const b = await post(VOL, { ...VOLUNTEER, website: "http://spam.example" });
    assert.equal(b.res.status, 302);
    assert.equal(b.res.headers.get("location"), "/volunteer.html?sent=1");
    assert.equal(sent.length, 0);
  });
});

test("rate limit: the 6th submission from one client gets a 429 page with the person's values and sends nothing more", async () => {
  await withApp(async ({ post }) => {
    for (let i = 1; i <= 5; i++) assert.equal((await post(PRE, PREREG)).res.status, 302, `submission ${i}`);
    assert.equal(sent.length, 5);
    const { res, text } = await post(PRE, { ...PREREG, parent: "Sixth Parent" });
    assert.equal(res.status, 303);
    assert.match(text, /Too many messages from this connection/);
    assert.match(text, /role="alert"/);
    assert.ok(text.includes("Sixth Parent"), "values are kept so nothing typed is lost");
    assert.equal(sent.length, 5);
    assert.ok(res.headers.get("ratelimit-limit") || res.headers.get("ratelimit"), "standard RateLimit headers");
  });
});

test("rate limit: invalid submissions count too, and the two forms have separate counters", async () => {
  await withApp(async ({ post }) => {
    for (let i = 0; i < 5; i++) await post(PRE, { ...PREREG, email: "bad" });
    assert.equal((await post(PRE, PREREG)).res.status, 303);
    assert.equal((await post(VOL, VOLUNTEER)).res.status, 302, "the volunteer form is not affected");
  });
});

test("when the mail transport fails the email is queued in the outbox, the person still sees success, and the worker retries", async () => {
  await withApp(async ({ post }) => {
    sendImpl = async () => { throw new Error("SMTP down"); };
    const realError = console.error;
    console.error = () => {};
    let r;
    try { r = await post(PRE, PREREG); } finally { console.error = realError; }
    assert.equal(r.res.status, 302, "stored for retry: not an error for the visitor");
    const { rows } = await pool.query("SELECT id, status, to_email FROM email_outbox WHERE kind = 'contact' AND subject LIKE 'Website pre-registration:%' ORDER BY id DESC LIMIT 1");
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].to_email, EXPECTED_TO);
    sendImpl = async (opts) => { sent.push(opts); };
    await pool.query("UPDATE email_outbox SET next_try_at = now() WHERE id = $1", [rows[0].id]);
    await require("../../src/lib/outbox").processOutbox(pool);
    assert.equal(sent.length, 1, "delivered by the retry");
    assert.match(sent[0].text, /First name: Léa/);
  });
});

test("no personal data reaches the logs, on success, refusal or mail failure", async () => {
  await withApp(async ({ post }) => {
    const lines = [];
    const saved = {};
    for (const m of ["log", "info", "warn", "error"]) { saved[m] = console[m]; console[m] = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.stack : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }
    try {
      await post(PRE, PREREG);
      await post(PRE, { ...PREREG, email: "bad@" });
      await post(VOL, VOLUNTEER);
      sendImpl = async () => { throw new Error("SMTP down"); };
      await post(PRE, PREREG);
      await post(VOL, VOLUNTEER);
    } finally {
      for (const m of Object.keys(saved)) console[m] = saved[m];
    }
    assert.ok(lines.length >= 2, "the failures are logged");
    const all = lines.join("\n");
    for (const secret of ["Léa", "Martin", "claire@example.test", "2018-04-12", "dinosaurs", "Sam Lee", "sam@example.test", "+33 6 12 34 56 78"]) {
      assert.ok(!all.includes(secret), `the log does not contain ${secret}`);
    }
  });
});

test("a repeated field name (an array) never crashes the handlers", async () => {
  await withApp(async ({ post }) => {
    const { res } = await post(VOL, { ...VOLUNTEER, name: ["A", "B"], email: ["a@example.test", "b@example.test"] });
    assert.ok([302, 303].includes(res.status));
  });
});
