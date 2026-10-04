// Forum moderation helpers: reason codes, the stored reason format, and the
// statement of reasons emailed to the author of a hidden post (EU Digital
// Services Act, art. 17). Routes: src/routes/admin/forum.js.

const mailer = require("../mailer");
const { emailTr } = require("./lang");
const { emailSafeName } = require("./validation");

const CONTEST_ADDRESS = "admin@umasbooks.org";
const MAX_NOTE = 500;
const WHAT_EXCERPT = 100;

// code -> [English, French]
const REASONS = {
  illegal: ["Illegal content", "Contenu illicite"],
  harassment: ["Harassment", "Harcèlement"],
  spam: ["Spam", "Contenu indésirable (spam)"],
  other: ["Other", "Autre"],
};

const isReason = (code) => Object.prototype.hasOwnProperty.call(REASONS, code);

// hidden_reason column: "spam" or "spam: the note".
const packReason = (code, note) => (note ? `${code}: ${note}` : code);

function unpackReason(stored) {
  const s = String(stored || "");
  const i = s.indexOf(": ");
  const code = i === -1 ? s : s.slice(0, i);
  return { code: isReason(code) ? code : "other", note: i === -1 ? "" : s.slice(i + 2) };
}

const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Sends the statement of reasons. Never throws: a failed send must not block
// the hide. Skips silently when the author's account is gone.
// target: { kind, title, body, author_id }
async function sendStatementOfReasons(pool, target, code, note) {
  if (!target.author_id) return false;
  try {
    const { rows } = await pool.query("SELECT email, display_name, lang FROM users WHERE id = $1", [target.author_id]);
    const author = rows[0];
    if (!author) return false;
    const tr = emailTr(author.lang);
    const name = emailSafeName(author.display_name || "");
    const what = oneLine(target.kind === "thread" ? target.title : target.body).slice(0, WHAT_EXCERPT);
    const kindWord = target.kind === "thread"
      ? tr("your discussion", "votre discussion")
      : tr("your reply", "votre réponse");
    const [reasonEn, reasonFr] = REASONS[code];
    await mailer.sendMail({
      to: author.email,
      replyTo: CONTEST_ADDRESS,
      subject: tr(
        "A post of yours was removed from the Uma's Books forum",
        "Un de vos messages a été retiré du forum d'Uma's Books"
      ),
      text:
        tr(`Hello${name ? ` ${name}` : ""},\n\n`, `Bonjour${name ? ` ${name}` : ""},\n\n`) +
        tr(
          `The association's moderators removed ${kindWord} from the members' forum:\n`,
          `Les modérateurs de l’association ont retiré ${kindWord} du forum des membres :\n`
        ) +
        `"${what}"\n\n` +
        tr(`Reason: ${reasonEn}\n`, `Motif : ${reasonFr}\n`) +
        (note ? tr(`Moderator's note: ${note}\n`, `Remarque du modérateur : ${note}\n`) : "") +
        "\n" +
        tr(
          "This decision was taken by the association's moderators (volunteers of Uma's Books), not by automated means.\n\n",
          "Cette décision a été prise par les modérateurs de l’association (des bénévoles d’Uma's Books), et non par des moyens automatisés.\n\n"
        ) +
        tr(
          `If you disagree, reply to this email or write to ${CONTEST_ADDRESS}: we will review the decision. ` +
            "You also have the right to lodge a complaint with the French Digital Services Coordinator (Arcom) or to bring the matter before a court.\n",
          `Si vous n’êtes pas d’accord, répondez à cet e-mail ou écrivez à ${CONTEST_ADDRESS} : nous réexaminerons la décision. ` +
            "Vous avez aussi le droit de déposer une plainte auprès du coordinateur français pour les services numériques (l’Arcom) ou de saisir un tribunal.\n"
        ),
    });
    return true;
  } catch (err) {
    console.error("Forum moderation email failed:", err.message);
    return false;
  }
}

module.exports = { REASONS, MAX_NOTE, isReason, packReason, unpackReason, sendStatementOfReasons };
