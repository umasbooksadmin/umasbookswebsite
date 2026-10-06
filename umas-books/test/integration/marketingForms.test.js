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

async function withApp(fn) {
  delete require.cache[ROUTE];
  const server = await listen(buildApp([require(ROUTE)]));
  try {
    const post = async (pathname, fields, headers = {}) => {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
      const res = await fetch(`${server.base}${pathname}`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: body.toString(),
      });
      return { res, text: await res.text() };
    };
    await fn({ base: server.base, post });
  } finally {
    await server.close();
  }
}

const PREREG = {
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
      "First name: Léa", "Last name: Martin", "Date of birth: 2018-04-12", "Session: Young Adventurers (Age 5–9)",
      "Days: Tuesday, Saturday", "Times: Morning, Evening",
      "Name: Claire Martin", "Email: claire@example.test", "Phone: +33 6 12 34 56 78",
      "English level: Beginner", "Notes: Loves dinosaurs", "Wants program updates: yes",
      "parent or legal guardian confirmed they agree to be contacted", "Site language: English", "12 months",
    ]) assert.ok(mail.text.includes(line), `email contains "${line}"`);
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

test("pre-registration: every required field is enforced, with an accessible error summary and field errors (EN)", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { website: "", childFirst: "  ", dob: "2999-01-01", email: "nope", phone: "12" });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
    // Summary: role=alert, first thing in the form area, links to each field.
    assert.match(text, /<div class="form-error-summary" id="form-errors" role="alert" tabindex="-1" data-form-errors>/);
    for (const id of ["preg-first", "preg-last", "preg-dob", "preg-session", "preg-days", "preg-times", "preg-parent", "preg-email", "preg-phone", "preg-consent"]) {
      assert.ok(text.includes(`href="#${id}"`), `summary links to #${id}`);
      assert.match(text, new RegExp(`<[^>]*id="${id}"[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*${id}-err`), `${id} is aria-invalid and described by its error`);
      assert.ok(text.includes(`id="${id}-err"`), `${id} has its error text`);
    }
    assert.match(text, /There is a problem/);
    assert.match(text, /Enter a valid email address/);
    assert.match(text, /Tick this box to continue/);
    assert.match(text, /not in the future/);
    assert.match(text, /<script src="assets\/form-errors\.js"><\/script>/, "focus-on-error script is loaded");
    // The day/time lists keep what was chosen (nothing here) and the page is not cacheable.
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });
});

test("pre-registration: the consent checkbox is required on its own", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, consent: "" });
    assert.equal(res.status, 400);
    assert.equal(sent.length, 0);
    assert.match(text, /href="#preg-consent"/);
    assert.doesNotMatch(text, /href="#preg-first"/, "only the consent is reported");
    assert.match(text, /type="checkbox" name="consent"[^>]*aria-invalid="true"/);
  });
});

test("pre-registration: refused values are echoed back; an unknown session, day or time is not accepted", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, session: "free-money", days: ["sun", "tue"], times: ["midnight"], notes: "keep <me>" });
    assert.equal(res.status, 400);
    assert.match(text, /value="Léa"/);
    assert.match(text, /value="claire@example\.test"/);
    assert.match(text, /keep &lt;me&gt;/);
    assert.match(text, /<option value="tue" selected/);
    assert.doesNotMatch(text, /<option value="sat" selected/);
    assert.match(text, /href="#preg-session"/);
    assert.match(text, /href="#preg-times"/);
    assert.doesNotMatch(text, /href="#preg-days"/, "tue is valid, the unknown day is just dropped");
  });
});

test("pre-registration: dates must be real, past and plausible", async () => {
  await withApp(async ({ post }) => {
    for (const dob of ["2018-02-31", "1800-01-01", "tomorrow", "", "2018-4-2"]) {
      const { res, text } = await post(PRE, { ...PREREG, dob });
      assert.equal(res.status, 400, dob);
      assert.match(text, /href="#preg-dob"/, dob);
    }
    assert.equal(sent.length, 0);
  });
});

test("pre-registration: the page is French when the visitor's language is French (summary, field errors, labels)", async () => {
  await withApp(async ({ post }) => {
    const { res, text } = await post(PRE, { ...PREREG, email: "bad", consent: "" }, { cookie: "umasbooks_lang=fr" });
    assert.equal(res.status, 400);
    assert.match(text, /<h2 data-i18n="form\.err\.title">Il y a un problème<\/h2>/);
    assert.match(text, /Saisissez une adresse e-mail valide/);
    assert.match(text, /Cochez cette case pour continuer/);
    assert.match(text, /Adresse e-mail<\/span> — <span data-i18n="form\.err\.email">/);
    assert.match(text, /Je suis le parent ou le représentant légal de l’enfant et j’accepte d’être contacté\(e\) au sujet de ce programme\./);
    assert.match(text, /Ne saisissez pas d’informations de santé ici/);
  });
});

test("pre-registration: the form asks for the guardian statement, forbids health information, and has no mailto left", async () => {
  await withApp(async ({ post }) => {
    const { text } = await post(PRE, {});
    assert.match(text, /I am the parent or legal guardian of the child and I agree to be contacted about this program\./);
    assert.match(text, /Do not enter health information here \(allergies, medical conditions, disabilities\): tell us in person\./);
    assert.doesNotMatch(text, /data-mailto|mailto:admin@umasbooks\.org\?subject|opens your email app/i);
    assert.match(text, /<form class="preg-form" method="post" action="\/pre-registration" novalidate>/);
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
      assert.equal(res.status, 400, JSON.stringify(bad));
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
    assert.equal(res.status, 429);
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
    assert.equal((await post(PRE, PREREG)).res.status, 429);
    assert.equal((await post(VOL, VOLUNTEER)).res.status, 302, "the volunteer form is not affected");
  });
});

test("when the mail transport fails the person sees a 500 page with the fallback address and their values", async () => {
  await withApp(async ({ post }) => {
    sendImpl = async () => { throw new Error("SMTP down"); };
    const realError = console.error;
    console.error = () => {};
    let r;
    try { r = await post(PRE, PREREG); } finally { console.error = realError; }
    assert.equal(r.res.status, 500);
    assert.match(r.text, /could not be sent just now/);
    assert.ok(r.text.includes("admin@umasbooks.org"));
    assert.ok(r.text.includes("Claire Martin"), "entered values preserved");
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
    assert.ok([302, 400].includes(res.status));
  });
});
