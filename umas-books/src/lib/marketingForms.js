// Validation and email text for the two marketing-site forms that used to be
// "mailto:" links: the English Immersion pre-registration
// (views/marketing/pre-registration.ejs) and the volunteer sign-up
// (views/marketing/volunteer.ejs). Pure functions: routes/marketingForms.js
// does the HTTP, the rate limit and the sending.
//
// Nothing is stored in the database: a valid submission becomes ONE email to
// the contact inbox (kept 12 months there, then deleted: see the privacy
// policy and docs/privacy/record-of-processing.md).
//
// An error is a { key, label } pair: `key` selects a message in the page's
// dictionaries (form.err.* in assets/site.js COMMON, so the language toggle
// works), `label` is the i18n key of the field's own label for the summary.

const { isEmail, emailSafeName } = require("./validation");

// Value posted by the <select>, English label used in the email to staff.
const SESSIONS = {
  "little-explorers": "Little Explorers (Age 2–3)",
  "eveil-english": "Éveil English (Age 3–5)",
  "young-adventurers": "Young Adventurers (Age 5–9)",
  "young-readers": "Young Readers (Age 9–14)",
  "teen-literature": "Teen Literature (Age 14–17)",
  "english-cafe": "English Café (Adult)",
};
const DAYS = { tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const TIMES = { morning: "Morning", earlyafternoon: "Early afternoon", lateafternoon: "Late afternoon", evening: "Evening" };

const str = (v, max) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").trim().slice(0, max);
// One line only (names, availability, level): no line breaks that could add email headers or fake lines.
const oneLine = (v, max) => str(v, max).replace(/\s*\n\s*/g, " ");
const checked = (v) => v === "1" || v === "on" || v === "yes" || v === "true";
const list = (v) => [].concat(v === undefined ? [] : v).map(String);
const pick = (v, allowed) => [...new Set(list(v))].filter((k) => Object.prototype.hasOwnProperty.call(allowed, k));

// 2 to 20 characters of a phone number: digits, spaces and + - . ( ) only, at least 6 digits.
const PHONE_RE = /^[0-9 +().-]{6,30}$/;
const isPhone = (s) => PHONE_RE.test(s) && (s.match(/\d/g) || []).length >= 6;

// "YYYY-MM-DD" that is a real calendar date, not in the future, within 120 years.
function parseBirthDate(s, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (date.getTime() > now.getTime()) return null;
  if (y < now.getUTCFullYear() - 120) return null;
  return s;
}

function validatePreRegistration(body = {}, now = new Date()) {
  const values = {
    childFirst: oneLine(body.childFirst, 80),
    childLast: oneLine(body.childLast, 80),
    dob: str(body.dob, 10),
    session: Object.prototype.hasOwnProperty.call(SESSIONS, body.session) ? body.session : "",
    days: pick(body.days, DAYS),
    times: pick(body.times, TIMES),
    parent: oneLine(body.parent, 120),
    email: str(body.email, 200),
    phone: oneLine(body.phone, 30),
    level: oneLine(body.level, 200),
    notes: str(body.notes, 1000),
    updates: checked(body.updates),
    consent: checked(body.consent),
  };
  const errors = {};
  const need = (field, ok, label, key = "required") => { if (!ok) errors[field] = { key, label }; };
  need("childFirst", values.childFirst, "preg.f.first.l");
  need("childLast", values.childLast, "preg.f.last.l");
  need("dob", parseBirthDate(values.dob, now), "preg.f.dob.l", values.dob ? "date" : "required");
  need("session", values.session, "preg.f.session.l");
  need("days", values.days.length, "preg.f.days.l", "choose");
  need("times", values.times.length, "preg.f.times.l", "choose");
  need("parent", values.parent, "preg.f.parent.l");
  need("email", isEmail(values.email), "preg.f.email.l", values.email ? "email" : "required");
  need("phone", isPhone(values.phone), "preg.f.phone.l", values.phone ? "phone" : "required");
  need("consent", values.consent, "preg.f.consent.l", "consent");
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function validateVolunteer(body = {}) {
  const values = {
    name: oneLine(body.name, 120),
    email: str(body.email, 200),
    availability: oneLine(body.availability, 300),
    note: str(body.note, 1000),
    consent: checked(body.consent),
  };
  const errors = {};
  if (!values.name) errors.name = { key: "required", label: "form.name.l" };
  if (!isEmail(values.email)) errors.email = { key: values.email ? "email" : "required", label: "form.email.l" };
  if (!values.consent) errors.consent = { key: "consent", label: "volunteer.form.consent.l" };
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// What the mailbox owner reads. Always English (the admin side is English
// only); the visitor's language is one line so a reply can match it.
// The subject carries no personal data (a mail relay without credentials logs it).
function preRegistrationEmail(v, lang) {
  const c = (s) => emailSafeName(s);
  return {
    subject: `Website pre-registration: ${SESSIONS[v.session]}`,
    replyTo: { name: c(v.parent).replace(/[<>",;\r\n]/g, " "), address: v.email },
    text:
      "New pre-registration from the website (Weekly English Immersion)\n\n" +
      "Child\n" +
      `  First name: ${c(v.childFirst)}\n  Last name: ${c(v.childLast)}\n  Date of birth: ${v.dob}\n` +
      `  Session: ${SESSIONS[v.session]}\n\n` +
      "Availability\n" +
      `  Days: ${v.days.map((d) => DAYS[d]).join(", ")}\n  Times: ${v.times.map((t) => TIMES[t]).join(", ")}\n\n` +
      "Parent / legal guardian\n" +
      `  Name: ${c(v.parent)}\n  Email: ${v.email}\n  Phone: ${v.phone}\n\n` +
      "Additional information\n" +
      `  English level: ${v.level || "-"}\n  Notes: ${v.notes || "-"}\n\n` +
      `Wants program updates: ${v.updates ? "yes" : "no"}\n` +
      "The parent or legal guardian confirmed they agree to be contacted about this program.\n" +
      `Site language: ${lang === "fr" ? "French" : "English"}\n\n` +
      "Retention: delete this email 12 months after receiving it (privacy policy).\n",
  };
}

function volunteerEmail(v, lang) {
  const c = (s) => emailSafeName(s);
  return {
    subject: "Website volunteer sign-up",
    replyTo: { name: c(v.name).replace(/[<>",;\r\n]/g, " "), address: v.email },
    text:
      "New volunteer sign-up from the website\n\n" +
      `Name: ${c(v.name)}\nEmail: ${v.email}\nAvailability: ${v.availability || "-"}\n\n` +
      `Note: ${v.note || "-"}\n\n` +
      "The person confirmed they agree to be contacted about volunteering.\n" +
      `Site language: ${lang === "fr" ? "French" : "English"}\n\n` +
      "Retention: delete this email 12 months after receiving it (privacy policy).\n",
  };
}

module.exports = {
  SESSIONS, DAYS, TIMES,
  validatePreRegistration, validateVolunteer, preRegistrationEmail, volunteerEmail, parseBirthDate, isPhone,
};
