// French typography for server-rendered HTML (lang=fr only; see
// middleware/lang.js, which runs this on every rendered page).
//
// The tr("English", "Français") strings in the app's views are written with a
// plain space before ; : ! ? and », a plain space after «, and straight
// apostrophes. In French those spaces must not wrap onto the next line and the
// apostrophe is the curly one. The marketing dictionaries already do this by
// hand (U+00A0); this applies the same rules to everything else, ONLY inside
// text nodes:
//   - " ;"  " :"  " !"  " ?"  " »"  and "« "  -> a no-break space (U+00A0)
//   - ' (also &#39; / &apos;)                   -> ’ (U+2019)
//   - in headings (h1-h3), a hyphenated imperative like "Demandez-nous" is
//     kept on one line (wrapped in <span class="nobr">), so a title never
//     breaks as "Demandez-" / "nous".
// Attributes: only the spoken ones (aria-label, alt, title, placeholder) get the apostrophe and no-break fixes.
// Never touched: other attributes (href, value, data-*...), <script>, <style>, <textarea>,
// <pre>, <code>, comments (so URLs, JSON, JS and form values stay exact).

const NBSP = " ";

// One opening/closing tag; quoted attribute values may contain ">".
const TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\/?>/y;
// Elements whose content is code or form data: copy through untouched.
const RAW = /<(script|style|textarea|pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/iy;
// Elements whose content is text only: fix the text but add no markup.
const PLAIN_TEXT = /<(title|option)\b[^>]*>([\s\S]*?)<\/\1\s*>/iy;
const COMMENT = /<!--[\s\S]*?-->/y;

const ENCLITIC = /\b([A-Za-zÀ-ÖØ-öø-ÿ]{2,}-(?:nous|vous|moi|toi|lui|leur|leurs|le|la|les|y|en|je|tu|il|elle|on|ils|elles|ci|là))(?![A-Za-zÀ-ÖØ-öø-ÿ-])/g;

function fixText(text, wrapHyphenated) { // wrapHyphenated: only inside headings
  let t = text
    .replace(/&#0?39;|&apos;|&#x27;|'/g, "’")
    .replace(/ +([;:!?»])/g, NBSP + "$1")
    .replace(/«[ ]+/g, "«" + NBSP);
  if (wrapHyphenated) t = t.replace(ENCLITIC, '<span class="nobr">$1</span>');
  return t;
}

// Words that screen readers speak and tooltips show: the same apostrophe and no-break-space rules as the
// text, so a book called L'Étranger reads «Ajouter L’Étranger aux favoris». Only these attributes, only
// double-quoted values (a URL, a form value or a data-* attribute is never touched).
const SPOKEN_ATTR = /(\s(?:aria-label|aria-description|alt|title|placeholder)=")([^"]*)(")/gi;
function fixAttributes(tag) {
  return tag.replace(SPOKEN_ATTR, (_, a, v, z) => a + fixText(v, false) + z);
}

// The same no-break-space rules for a plain-text French email (subject or body): no HTML, so no
// tags to avoid. The apostrophe is left as written (names typed by people are not touched).
function frenchPlainText(text) {
  return String(text)
    .replace(/ +([;:!?»])/g, NBSP + "$1")
    .replace(/«[ ]+/g, "«" + NBSP);
}

function frenchTypography(html) {
  const s = String(html);
  let out = "";
  let text = "";
  let inHeading = false;
  const flush = () => { if (text) { out += fixText(text, inHeading); text = ""; } };
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "<") {
      const next = s.indexOf("<", i);
      const end = next === -1 ? s.length : next;
      text += s.slice(i, end);
      i = end;
      continue;
    }
    let m = null;
    for (const [re, kind] of [[COMMENT, "raw"], [RAW, "raw"], [PLAIN_TEXT, "plain"], [TAG, "tag"]]) {
      re.lastIndex = i;
      m = re.exec(s);
      if (m) {
        flush();
        if (kind === "plain") {
          const open = m[0].slice(0, m[0].indexOf(">") + 1);
          const close = m[0].slice(m[0].lastIndexOf("</"));
          out += open + fixText(m[2], false) + close;
        } else {
          if (kind === "tag") { const h = /^<(\/?)h[1-3]\b/i.exec(m[0]); if (h) inHeading = !h[1]; }
          out += kind === "tag" ? fixAttributes(m[0]) : m[0];
        }
        i += m[0].length;
        break;
      }
    }
    if (!m) { text += s[i]; i++; } // a stray "<" in text
  }
  flush();
  return out;
}

// Wraps res.render so a French page goes through frenchTypography before it is
// sent. Works with every call shape: render(view), render(view, options),
// render(view, callback), render(view, options, callback).
function installFrenchRender(res) {
  const render = res.render;
  res.render = function (view, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? undefined : options;
    return render.call(this, view, opts, (err, html) => {
      if (err) return cb ? cb(err) : this.req.next(err);
      const fixed = frenchTypography(html);
      return cb ? cb(null, fixed) : this.send(fixed);
    });
  };
}

module.exports = { frenchTypography, frenchPlainText, installFrenchRender, NBSP };
