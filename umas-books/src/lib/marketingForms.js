// Validation and email text for the two marketing-site forms that used to be
// "mailto:" links: the English Immersion pre-registration
// (views/marketing/pre-registration.ejs) and the volunteer sign-up
// (views/marketing/volunteer.ejs). Pure functions: routes/marketingForms.js
// does the HTTP, the rate limit and the sending.
//
// A valid submission becomes ONE email to the contact inbox (kept 12 months
// there, then deleted). The only database copy is the email outbox row, kept up
// to 30 days (90 if sending failed), and the copy in the backups (up to 2 years)
// is erased with them: see the privacy policy and
// docs/privacy/record-of-processing.md. The form does NOT store the submission
// anywhere else.
//
// An error is a { key, label } pair: `key` selects a message in the page's
// dictionaries (form.err.* in assets/site.js COMMON, so the language toggle
// works), `label` is the i18n key of the field's own label for the summary.

const { isEmail, emailSafeName } = require("./validation");

// Value posted by the <select>, English label used in the email to staff.
// A session is not matched to who is registering (an adult may pick a child's
// session by mistake): staff sort it out when they answer.
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
// Only used to read the OLD form's full date of birth (see birthYearOf): the
// form now asks for the year only.
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

// Year of birth of a child: four digits, this year or up to 19 years back (a
// child, up to 17, with a margin for a birthday not yet reached).
const CHILD_MAX_AGE_YEARS = 19;
function parseBirthYear(s, now = new Date()) {
  if (!/^\d{4}$/.test(s)) return null;
  const y = Number(s);
  const thisYear = now.getUTCFullYear();
  return y <= thisYear && y >= thisYear - CHILD_MAX_AGE_YEARS ? String(y) : null;
}

// The year typed in the new field, or, for a post from the OLD form (still in an
// open browser tab at deploy time), the year of the full "dob" it sent: only
// the year is kept, the rest of the date is dropped.
function birthYearOf(body, now) {
  const typed = str(body.birthYear, 8);
  if (typed) return typed;
  const old = parseBirthDate(str(body.dob, 10), now);
  return old ? old.slice(0, 4) : "";
}

const WHO = { self: "An adult, for themselves", child: "A parent or guardian, for a child" };

function validatePreRegistration(body = {}, now = new Date()) {
  // A post from the old form has no "who": it always was for a child, and its single
  // "consent" box was the guardian statement as well as the agreement to be contacted.
  const legacy = body.who === undefined && body.dob !== undefined; // only the old form sent "dob"
  const who = legacy ? "child" : Object.prototype.hasOwnProperty.call(WHO, body.who) ? body.who : "";
  const consent = checked(body.consent);
  const values = {
    who,
    childFirst: oneLine(body.childFirst, 80),
    childLast: oneLine(body.childLast, 80),
    birthYear: birthYearOf(body, now),
    guardian: legacy ? consent : checked(body.guardian),
    session: Object.prototype.hasOwnProperty.call(SESSIONS, body.session) ? body.session : "",
    days: pick(body.days, DAYS),
    times: pick(body.times, TIMES),
    parent: oneLine(body.parent, 120),
    email: str(body.email, 200),
    phone: oneLine(body.phone, 30),
    level: oneLine(body.level, 200),
    notes: str(body.notes, 1000),
    updates: checked(body.updates),
    consent,
  };
  const errors = {};
  const need = (field, ok, label, key = "required") => { if (!ok) errors[field] = { key, label }; };
  need("who", who, "preg.f.who.l", "choose");
  // The child section and the guardian statement apply only when a child is registered.
  if (who === "child") {
    need("childFirst", values.childFirst, "preg.f.first.l");
    need("childLast", values.childLast, "preg.f.last.l");
    need("birthYear", parseBirthYear(values.birthYear, now), "preg.f.birthyear.l", values.birthYear ? "birthyear" : "required");
    need("guardian", values.guardian, "preg.f.guardian.l", "consent");
  }
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
  const child = v.who === "child";
  return {
    subject: `Website pre-registration: ${SESSIONS[v.session]}`,
    replyTo: { name: c(v.parent).replace(/[<>",;\r\n]/g, " "), address: v.email },
    text:
      "New pre-registration from the website (Weekly English Immersion)\n\n" +
      `Registering: ${WHO[v.who]}\n` +
      `Session: ${SESSIONS[v.session]}\n\n` +
      (child
        ? "Child\n" + `  First name: ${c(v.childFirst)}\n  Last name: ${c(v.childLast)}\n  Year of birth: ${v.birthYear}\n\n`
        : "") +
      "Availability\n" +
      `  Days: ${v.days.map((d) => DAYS[d]).join(", ")}\n  Times: ${v.times.map((t) => TIMES[t]).join(", ")}\n\n` +
      (child ? "Parent / legal guardian\n" : "Adult registering\n") +
      `  Name: ${c(v.parent)}\n  Email: ${v.email}\n  Phone: ${v.phone}\n\n` +
      "Additional information\n" +
      `  English level: ${v.level || "-"}\n  Notes: ${v.notes || "-"}\n\n` +
      `Wants program updates: ${v.updates ? "yes" : "no"}\n` +
      (child
        ? "The parent or legal guardian confirmed they are the child's parent or legal guardian and agree to be contacted about this program.\n"
        : "The person confirmed they agree to be contacted about this program.\n") +
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
  SESSIONS, DAYS, TIMES, WHO,
  validatePreRegistration, validateVolunteer, preRegistrationEmail, volunteerEmail, parseBirthDate, parseBirthYear, isPhone,
};
