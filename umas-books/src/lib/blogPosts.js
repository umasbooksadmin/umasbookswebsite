// Blog posts as the public sees them: ONE place for "which posts are public", "which language to show" and "how a body
// is made safe", used by the JSON feed (routes/blog.js), the server-rendered pages (routes/blogPages.js), the sitemap
// (routes/seo.js) and the admin editor's French status (routes/admin/blog.js).
//
// Visibility (unchanged since the feed was written): a post is public when status = 'published' AND published_at has
// passed. A draft is never public. A scheduled post becomes public by itself when its date arrives. An ADMIN asking
// with ?preview=1 sees every post (the real page, with a note) and only an admin: anyone else gets the public rule.
//
// Language: a post has an English text and, optionally, a French one (title_fr, excerpt_fr, body_fr; one slug for
// both). The French text is used only when it is READY (frenchState): a title and a body, and an excerpt whenever the
// English post has one. A half-written French text is never shown; the English text is, labelled as English.
//
// Safety: a body is run through the same sanitize-html allowlist when it is written (routes/admin/blog.js) and again
// here when it is served, so a row that got into the table another way can never put script on a page.

const { sanitizeHtml } = require("./sanitizeHtml");
const { parisDateString } = require("./tz");
const { variantUrl } = require("./imageVariants");

const PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

// Sanitising is about 0.3 ms for a 6 KB post; the result is remembered by body text so a busy feed costs nothing
// after the first request (bounded: cleared when it grows past 300 bodies).
const SANITISED = new Map();
function safeBody(body) {
  const raw = String(body || "");
  let out = SANITISED.get(raw);
  if (out === undefined) {
    if (SANITISED.size >= 300) SANITISED.clear();
    out = sanitizeHtml(raw);
    SANITISED.set(raw, out);
  }
  return out;
}

// An editor with only empty paragraphs and line breaks counts as empty.
function hasText(html) {
  return Boolean(String(html || "").replace(/<[^>]*>/g, "").replace(/&nbsp;|[\s\u00a0]/g, ""));
}
function plainText(html) {
  return String(html || "")
    .replace(/<\/(p|div|li|blockquote)>|<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// The same test in SQL, so a list can tell "has a French body" without shipping the bodies.
const FR_COLUMNS = `title_fr, excerpt_fr,
  (regexp_replace(COALESCE(body_fr, ''), '<[^>]*>|&nbsp;|[\\s\\u00a0]', '', 'g') <> '') AS has_body_fr`;

// "missing": no French text at all. "ready": a title and a body, and an excerpt when the English post has one.
// "draft": some French text, not enough to show. `row` needs title, excerpt, title_fr, excerpt_fr and has_body_fr
// (FR_COLUMNS) or body_fr.
function frenchState(row) {
  const title = String(row.title_fr || "").trim();
  const excerpt = String(row.excerpt_fr || "").trim();
  const body = row.has_body_fr !== undefined ? Boolean(row.has_body_fr) : hasText(row.body_fr);
  if (!title && !excerpt && !body) return "missing";
  const needsExcerpt = Boolean(String(row.excerpt || "").trim());
  return title && body && (excerpt || !needsExcerpt) ? "ready" : "draft";
}

// The text to show in `lang`: { lang: the language of the text actually returned, title, excerpt, body (sanitised,
// only when the row carries a body) }. French only when it is ready; otherwise the English text with lang "en".
function localizedText(row, lang) {
  const fr = lang === "fr" && frenchState(row) === "ready";
  const body = fr ? row.body_fr : row.body;
  return {
    lang: fr ? "fr" : "en",
    title: fr ? String(row.title_fr).trim() : row.title,
    excerpt: fr ? String(row.excerpt_fr || "").trim() : row.excerpt || "",
    ...(body === undefined ? {} : { body: safeBody(body) }),
  };
}

const normLang = (v) => (v === "fr" ? "fr" : "en");

// A post's picture: "/img/<hash>.jpg" (stored by the admin editor, 800x500) gets smaller copies for phones; an older
// "assets/img/..." path is only given a leading slash.
const STORED = /^\/img\/[0-9a-f]{64}\.jpg$/;
function postImage(url) {
  if (!url) return null;
  const src = /^(\/|[a-z][a-z0-9+.-]*:)/i.test(url) ? url : `/${url}`;
  if (!STORED.test(src)) return { src, srcset: "" };
  return { src, srcset: `${variantUrl(src, 300)} 300w, ${variantUrl(src, 450)} 450w, ${variantUrl(src, 600)} 600w, ${src} 800w` };
}

// ---- queries ----

const PUBLIC = "status = 'published' AND published_at <= now()";

// A page of posts, newest first. Light: no bodies.
async function listPosts(pool, { adminPreview = false, limit = PAGE_SIZE, offset = 0 } = {}) {
  const { rows } = await pool.query(
    adminPreview
      ? `SELECT slug, title, excerpt, category, image_url, status, ${FR_COLUMNS},
                COALESCE(published_at, created_at) AS published_at
         FROM blog_posts ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT $1 OFFSET $2`
      : `SELECT slug, title, excerpt, category, image_url, status, published_at, ${FR_COLUMNS}
         FROM blog_posts WHERE ${PUBLIC}
         ORDER BY published_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

async function countPosts(pool, { adminPreview = false } = {}) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM blog_posts${adminPreview ? "" : ` WHERE ${PUBLIC}`}`);
  return rows[0].n;
}

// One post with its body, or undefined. The visibility rule of the list.
async function getPost(pool, slug, { adminPreview = false } = {}) {
  const { rows } = await pool.query(
    adminPreview
      ? `SELECT id, slug, title, excerpt, body, body_fr, category, image_url, status, ${FR_COLUMNS}, updated_at,
                COALESCE(published_at, created_at) AS published_at
         FROM blog_posts WHERE slug = $1`
      : `SELECT id, slug, title, excerpt, body, body_fr, category, image_url, status, ${FR_COLUMNS}, updated_at, published_at
         FROM blog_posts WHERE slug = $1 AND ${PUBLIC}`,
    [String(slug).slice(0, 200)]
  );
  return rows[0];
}

// The public post published just before and just after `post` (undefined at either end). Compared inside the database
// (a JavaScript Date has milliseconds, the column has microseconds: a post would otherwise be its own "next").
async function neighbours(pool, post) {
  const cols = `slug, title, excerpt, ${FR_COLUMNS}`;
  const here = "(SELECT published_at, id FROM blog_posts WHERE id = $1)";
  const [prev, next] = await Promise.all([
    pool.query(`SELECT ${cols} FROM blog_posts WHERE ${PUBLIC} AND (published_at, id) < ${here} ORDER BY published_at DESC, id DESC LIMIT 1`, [post.id]),
    pool.query(`SELECT ${cols} FROM blog_posts WHERE ${PUBLIC} AND (published_at, id) > ${here} ORDER BY published_at ASC, id ASC LIMIT 1`, [post.id]),
  ]);
  return { prev: prev.rows[0], next: next.rows[0] };
}

// For the sitemap: public posts (newest first) with what it needs to say which languages exist.
async function listForSitemap(pool, limit) {
  const { rows } = await pool.query(
    `SELECT slug, title, excerpt, ${FR_COLUMNS}, updated_at FROM blog_posts WHERE ${PUBLIC}
     ORDER BY published_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// Is this post live right now (what the feed calls `live` for an admin's preview)?
const isLive = (row) => row.status === "published" && row.published_at <= new Date();

// The JSON the feed and the post endpoint send.
function shapePost(p, lang, { adminPreview = false, withBody = false } = {}) {
  const text = localizedText(p, lang);
  return {
    slug: p.slug,
    title: text.title,
    excerpt: text.excerpt,
    ...(withBody ? { body: text.body } : {}),
    lang: text.lang, // the language of the text above: "en" when French was asked for but is not ready
    category: p.category || undefined,
    image: p.image_url || undefined,
    date: parisDateString(p.published_at), // the Paris calendar day, not the UTC one
    ...(adminPreview ? { status: p.status, live: isLive(p), french: frenchState(p) } : {}),
  };
}

module.exports = {
  PAGE_SIZE, MAX_PAGE_SIZE, FR_COLUMNS, safeBody, hasText, plainText, frenchState, localizedText, normLang, postImage,
  listPosts, countPosts, getPost, neighbours, listForSitemap, isLive, shapePost,
};
