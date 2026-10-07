const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(
  path.join(__dirname, "../../views/marketing/privacy-policy.ejs"),
  "utf8"
);

function dict(name) {
  const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  assert.ok(m, `${name} not found`);
  return new Function(`return ${m[1]}`)();
}

const en = dict("pageI18nEn");
const fr = dict("pageI18nFr");

test("privacy policy: EN and FR have exactly the same keys", () => {
  assert.deepStrictEqual(Object.keys(fr).sort(), Object.keys(en).sort());
});

test("privacy policy: every data-i18n key used in the markup exists in both languages", () => {
  const used = [...src.matchAll(/data-i18n(?:-html)?="(pp\.[^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 20);
  for (const k of used) {
    assert.ok(k in en, `missing EN ${k}`);
    assert.ok(k in fr, `missing FR ${k}`);
  }
});

test("privacy policy: names the controller exactly as in the legal notice", () => {
  for (const d of [en, fr]) {
    assert.match(d["pp.s1.p"], /UMAS BOOKS/);
    assert.match(d["pp.s1.p"], /Uma’s Books/);
    assert.match(d["pp.s1.p"], /W811011706/);
    assert.match(d["pp.s1.p"], /109 441 147 00013/);
    assert.match(d["pp.s1.p"], /5, rue Hippolyte Savary, 81000 Albi/);
  }
});

test("privacy policy: states concrete retention periods, rights delay and CNIL", () => {
  assert.match(en["pp.s5.list"], /10 years/);
  assert.match(fr["pp.s5.list"], /10 ans/);
  assert.match(en["pp.s6.p1"], /one month/);
  assert.match(fr["pp.s6.p1"], /un mois/);
  for (const d of [en, fr]) assert.match(d["pp.s6.p2"], /CNIL/);
});

test("privacy policy: lists every processor", () => {
  for (const d of [en, fr]) {
    for (const name of ["HelloAsso", "Google", "Render", "Cloudflare", "Backblaze", "Anthropic"]) {
      assert.match(d["pp.s4.list"], new RegExp(name));
    }
    // GitHub runs the backup job and the dump passes through it: it is named as a recipient.
    assert.match(d["pp.s4.list"], /GitHub/);
  }
});

test("privacy policy: no vague retention wording remains", () => {
  assert.doesNotMatch(en["pp.s5.list"], /as long as necessary|reasonable time/i);
  assert.doesNotMatch(fr["pp.s6.p1"], /délai raisonnable/);
});

test("privacy policy: promises the inactivity warning and keeps contact-form emails 12 months", () => {
  assert.match(en["pp.s5.list"], /30 days before deleting/);
  assert.match(fr["pp.s5.list"], /30 jours avant la suppression/);
  assert.match(en["pp.s5.list"], /Messages you send us:<\/strong> emails received through the contact, volunteer sign-up and pre-registration forms are kept 12 months in our mailbox, then deleted, unless a conversation is still ongoing/);
  assert.match(fr["pp.s5.list"], /formulaires de contact, de bénévolat et de pré-inscription sont conservés 12 mois dans notre messagerie, puis supprimés, sauf si une conversation est encore en cours/);
  // The old "until you ask us to delete them" rule for volunteer/pre-registration emails is gone.
  assert.doesNotMatch(en["pp.s5.list"], /until you ask us to delete them/);
  assert.doesNotMatch(fr["pp.s5.list"], /jusqu’à ce que vous demandiez leur suppression/);
});

// Regression: the EN/FR dictionary strings once lost the space after every
// comma, semicolon and full stop ("e-mail,nom,mot de passe"), so the page read
// wrongly after the language toggle. Numbers (1,5), URLs, addresses and
// "word.tld" names are allowed; text is checked after removing markup.
function missingSpaces(value) {
  const text = value
    .replace(/<[^>]+>/g, "\u0001") // a tag boundary: judge only real text
    .replace(/https?:\/\/\S+|\S+@\S+|\b[a-z0-9-]+\.(?:fr|org|com|html)\b/gi, "x");
  return text.match(/[,;][A-Za-zÀ-ÿ]|[A-Za-zÀ-ÿ)]\.[A-ZÀ-Ý]|\)[A-Za-zÀ-ÿ]/g) || [];
}

test("privacy policy: no dictionary string lost its space after punctuation", () => {
  for (const [lang, d] of [["en", en], ["fr", fr]]) {
    for (const [k, v] of Object.entries(d)) {
      assert.deepStrictEqual(missingSpaces(v), [], `${lang} ${k} has punctuation with no following space`);
    }
  }
});

test("privacy policy: the spacing check catches the old bug and ignores numbers and addresses", () => {
  assert.ok(missingSpaces("e-mail,nom,mot de passe").length > 0);
  assert.ok(missingSpaces("<li>x</li>one,two").length > 0);
  assert.deepStrictEqual(missingSpaces("1,5 km, see cnil.fr or a@b.org, https://x.test/a,b"), []);
});

test("privacy policy: the toggled dictionary text matches the static English markup", () => {
  const body = src.split("<% const pageI18nEn")[0];
  const squash = (h) => h.replace(/>\s+</g, "><").trim();
  const re = /<(\w+)[^>]*data-i18n-html="(pp\.[^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let n = 0;
  for (const m of body.matchAll(re)) {
    n++;
    assert.strictEqual(squash(en[m[2]]), squash(m[3]), `${m[2]}: EN dictionary differs from the static page`);
  }
  assert.ok(n >= 6);
});

test("privacy policy: says photos and videos are only taken with consent (parent or guardian for a child), in both languages", () => {
  assert.match(src, /data-i18n="pp\.photos\.h"/);
  assert.match(src, /We never take photographs or videos of customers, members or children without their consent/, "the static (server-sent) English text");
  assert.match(en["pp.photos.h"], /^Photos and videos$/);
  assert.match(fr["pp.photos.h"], /^Photos et vidéos$/);
  assert.match(en["pp.photos.p"], /never take photographs or videos of customers, members or children without their consent/);
  assert.match(en["pp.photos.p"], /parent or legal guardian/);
  assert.match(en["pp.photos.p"], /withdraw your consent at any time/);
  assert.match(fr["pp.photos.p"], /ne prenons jamais de photos ni de vidéos de clients, de membres ou d’enfants sans leur consentement/);
  assert.match(fr["pp.photos.p"], /parent ou du représentant légal/);
  assert.match(fr["pp.photos.p"], /retirer votre consentement à tout moment/);
});

test("privacy policy: Cloudflare is a named recipient that sees visitor IP addresses; covers are served from our server, so no cover host is a recipient", () => {
  assert.match(en["pp.s4.list"], /<strong>Cloudflare<\/strong>[^<]*sees visitors’ IP addresses/);
  assert.match(fr["pp.s4.list"], /<strong>Cloudflare<\/strong>[^<]*adresse IP des visiteurs/);
  for (const d of [en, fr]) {
    assert.doesNotMatch(d["pp.s4.list"], /Open Library|Internet Archive|archive\.org/i, "not a recipient of visitor data any more");
    assert.match(d["pp.s4.p2"], /Open Library/, "the server-side look-ups are still explained");
  }
  assert.match(en["pp.s4.p2"], /your browser never loads images from them/);
  assert.match(fr["pp.s4.p2"], /votre navigateur ne charge jamais d’images depuis ces services/);
  assert.match(en["pp.s3.p"], /Book covers are shown from our own server/);
  assert.match(fr["pp.s3.p"], /Les couvertures de livres sont affichées depuis notre propre serveur/);
});

test("privacy policy: discloses the language cookie, the local-storage keys, the session cookie and the click-to-load HelloAsso form", () => {
  for (const [d, show] of [[en, "Show the HelloAsso form"], [fr, "Afficher le formulaire HelloAsso"]]) {
    const p = d["pp.s3.p"];
    assert.match(p, /umasbooks_lang/);
    assert.match(p, /umasbooks\.sid/);
    assert.match(p, /umasbooks\.lang/);
    assert.match(p, /umasbooks\.favorites/);
    assert.ok(p.includes(show), show);
    assert.match(p, /EN or FR|EN ou FR/);
  }
  assert.match(en["pp.s3.p"], /language cookie \(umasbooks_lang\) for one year/);
  assert.match(fr["pp.s3.p"], /cookie de langue \(umasbooks_lang\) pour un an/);
  assert.match(en["pp.s3.p"], /no consent banner is required/);
  assert.match(en["pp.s3.p"], /not loaded until you click/);
  assert.match(fr["pp.s3.p"], /ne se charge que lorsque vous cliquez/);
  // The old "one session cookie" claim is gone from the policy.
  assert.doesNotMatch(en["pp.s3.p"], /We use one session cookie to keep/);
  assert.match(en["pp.s5.list"], /language cookie 1 year/);
  assert.match(fr["pp.s5.list"], /cookie de langue 1 an/);
});

test("privacy policy: the forms send an email, a copy stays in the outbox and backups, never ask for health information, and a child's data is a guardian's", () => {
  assert.match(en["pp.s2.list"], /These forms send us an email\. A copy stays in our outgoing-mail queue for up to 30 days \(90 if sending failed\) and in our backups \(up to 2 years\); then it is erased\./);
  assert.doesNotMatch(en["pp.s2.list"], /nothing is stored/);
  assert.match(en["pp.s2.list"], /do not enter health information/);
  assert.match(fr["pp.s2.list"], /Ces formulaires nous envoient un e-mail\. Une copie reste dans notre file d’envoi 30 jours au plus \(90 jours en cas d’échec\), puis dans nos sauvegardes \(jusqu’à 2 ans\) avant d’être effacée\./);
  assert.doesNotMatch(fr["pp.s2.list"], /rien n’est enregistré/);
  assert.match(fr["pp.s2.list"], /aucune information de santé/);
  assert.doesNotMatch(en["pp.s2.list"], /open your own email application/);
  assert.match(en["pp.s7.p"], /parent or legal guardian confirms/);
  assert.match(fr["pp.s7.p"], /parent ou représentant légal confirme/);
  assert.match(en["pp.s7.p"], /12 months in our mailbox/);
  assert.match(fr["pp.s7.p"], /12 mois dans notre messagerie/);
});

test("privacy policy: requests need no account (write to us, we may ask for proof of the address) and the audit-log retention line is stated, EN and FR", () => {
  assert.match(en["pp.s6.p1"], /write to us at/);
  assert.match(en["pp.s6.p1"], /prove you own the address/);
  assert.doesNotMatch(en["pp.s6.p1"], /from the address on your account/);
  assert.match(fr["pp.s6.p1"], /écrivez-nous à/);
  assert.match(fr["pp.s6.p1"], /prouver que cette adresse est bien la vôtre/);
  assert.doesNotMatch(fr["pp.s6.p1"], /depuis l’adresse de votre compte/);
  assert.match(en["pp.s5.list"], /Administrator action log:<\/strong> 12 months; the free-text note[^.]*erased after 6 months/);
  assert.match(fr["pp.s5.list"], /Journal des actions des administrateurs\s*:<\/strong> 12 mois\u202f; le texte libre[^.]*effacé au bout de 6 mois/);
  // French punctuation: typographic apostrophe, no straight one in the new French text.
  assert.doesNotMatch(fr["pp.s6.p1"], /écrivez-nous[^<]*'/);
});

test("privacy policy: GitHub is a named recipient (backup job), the cookie, retention and photo lines are accurate", () => {
  assert.match(en["pp.s4.list"], /<strong>GitHub<\/strong> \(United States\) — runs our automatic backup job; the database copy passes through it briefly before it is stored at Backblaze\./);
  assert.match(fr["pp.s4.list"], /<strong>GitHub<\/strong> \(États-Unis\) — exécute notre sauvegarde automatique\u00a0; la copie de la base y transite brièvement avant d’être stockée chez Backblaze\./);
  assert.match(en["pp.s3.p"], /keep you logged in, remember your cart and protect forms/);
  assert.match(en["pp.s3.p"], /cart and login pages/);
  assert.match(fr["pp.s3.p"], /mémoriser votre panier et protéger les formulaires/);
  assert.match(en["pp.s5.list"], /Accounts with a current membership are not deleted automatically/);
  assert.match(fr["pp.s5.list"], /Les comptes ayant une adhésion en cours ne sont pas supprimés automatiquement/);
  assert.match(en["pp.s5.list"], /Render keeps platform logs for 14 days/);
  assert.match(fr["pp.s5.list"], /Render conserve les journaux de la plateforme 14 jours/);
  assert.doesNotMatch(en["pp.s5.list"], /a few weeks/);
  assert.match(en["pp.photos.p"], /consent is the legal basis/);
  assert.match(fr["pp.photos.p"], /le consentement est la base juridique/);
  // Where photos are kept and for how long are NOT invented here: they are TODOs in docs/legal-todos.md.
  assert.doesNotMatch(en["pp.photos.p"], /stored (on|at|in)|kept for/);
  const todos = fs.readFileSync(path.join(__dirname, "../../../docs/legal-todos.md"), "utf8");
  assert.match(todos, /Photos and videos[\s\S]*TODO\(the association\)[\s\S]*where they are stored/);
});

test("privacy policy: books and seats are paid in the shop, only the membership is paid online (HelloAsso), and no IP address is kept with an order", () => {
  assert.match(en["pp.s2.list"], /books and drop-in seats are not paid online/);
  assert.match(en["pp.s2.list"], /Only the membership is paid online, through our payment provider HelloAsso/);
  assert.match(fr["pp.s2.list"], /ne se paient pas en ligne/);
  assert.match(fr["pp.s2.list"], /Seule l’adhésion se paie en ligne, via notre prestataire HelloAsso/);
  assert.match(en["pp.s4.list"], /<strong>HelloAsso<\/strong>/, "HelloAsso stays in the list of recipients");
  assert.match(en["pp.s5.list"], /held for 14 days \(21 if the shop extends the hold once\)/);
  assert.match(fr["pp.s5.list"], /14 jours \(21 si la boutique prolonge/);
  for (const d of [en, fr]) {
    assert.doesNotMatch(d["pp.s2.list"], /abuse of the checkout|abus lors du paiement/);
    assert.doesNotMatch(d["pp.s5.list"], /IP address kept with an order|Adresse IP conservée avec une commande/);
  }
});
