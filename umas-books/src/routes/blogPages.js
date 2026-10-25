// The public blog, rendered by the server so a search engine (and a visitor without JavaScript) gets the real text:
//
//   /blog.html           the list, 24 posts a page, real links ?page=2 ... (a script turns "Show older posts" into an in-page load)
//   /blog/<slug>         one post, whole sanitised body in the HTML, its own <title>, description, canonical, hreflang,
//                        Open Graph / Twitter tags, BlogPosting + BreadcrumbList JSON-LD, previous / next links
//   /fr/blog.html, /fr/blog/<slug>   the same in French (the language middleware strips /fr/, lib/frUrls.js)
//   /blog.html?post=<slug>           the old address: 301 to /blog/<slug> (or /fr/blog/<slug>)
//
// Which posts are public, which language a post is shown in and how a body is made safe all live in lib/blogPosts.js,
// shared with the JSON feed (routes/blog.js) and the sitemap. A post without a READY French text still has a /fr/ address:
// it shows the English text with a notice, and its canonical points at the English address (no hreflang for a version
// that does not exist), so search engines never index English under a French URL.

const express = require("express");
const { pool } = require("../db");
const blog = require("../lib/blogPosts");
const { renderMarketing } = require("../lib/pageDictionary");
const { setMarketingSeoLocals } = require("./seo");
const { seoLinks } = require("../lib/frUrls");
const { parseIntParam } = require("../lib/parseParams");
const { parisDateString } = require("../lib/tz");

const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const BRAND = "Uma's Books and Adventures";
const DESCRIPTION_MAX = 160;

const isAdminPreview = (req) => req.query.preview === "1" && Boolean(req.session && req.session.user && req.session.user.isAdmin);

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ") > 80 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:.-]+$/, "") + "…";
}

const absolute = (site, url) => (site && url ? site + url : "");

// The label of a post in a list: its text in the page's language (or English, flagged), date, picture and link.
function cardFor(p, lang, res, { eager = false } = {}) {
  const text = blog.localizedText(p, lang);
  const image = blog.postImage(p.image_url);
  return {
    href: `/blog/${p.slug}`,
    title: text.title,
    excerpt: text.excerpt,
    textLang: text.lang,
    fallback: lang === "fr" && text.lang === "en",
    date: parisDateString(p.published_at),
    dateLabel: res.locals.formatDateLong(p.published_at),
    image,
    eager,
    status: p.status,
  };
}

// Canonical + hreflang for a post. French is offered (and canonical for a French page) only when it is READY.
function postLinks(site, slug, lang, frReady) {
  if (!site) return { canonical: "", alternates: [] };
  const en = `${site}/blog/${slug}`;
  const fr = `${site}/fr/blog/${slug}`;
  if (!frReady) return { canonical: en, en, alternates: [{ hreflang: "en", href: en }, { hreflang: "x-default", href: en }] };
  return {
    canonical: lang === "fr" ? fr : en, en, fr,
    alternates: [{ hreflang: "en", href: en }, { hreflang: "fr", href: fr }, { hreflang: "x-default", href: en }],
  };
}

function createBlogPagesRouter({ marketingCsp }) {
  const router = express.Router();

  // ---- the list ----
  router.get("/blog.html", async (req, res, next) => {
    // The old address of a post.
    const legacy = typeof req.query.post === "string" ? req.query.post.trim().toLowerCase() : "";
    if (legacy) {
      if (!SLUG.test(legacy)) return res.status(404).render("404");
      return res.redirect(301, `/blog/${legacy}${req.query.preview === "1" ? "?preview=1" : ""}`);
    }

    const adminPreview = isAdminPreview(req);
    const total = await blog.countPosts(pool, { adminPreview });
    const pages = Math.max(1, Math.ceil(total / blog.PAGE_SIZE));
    const page = parseIntParam(req.query.page, { min: 1, max: 1000000, default: 1 });
    const hrefFor = (n) => {
      const q = [n > 1 ? `page=${n}` : "", adminPreview ? "preview=1" : ""].filter(Boolean).join("&");
      return `/blog.html${q ? `?${q}` : ""}`;
    };
    if (page > pages) return res.redirect(302, hrefFor(pages)); // a bookmarked page that no longer exists

    const rows = await blog.listPosts(pool, { adminPreview, limit: blog.PAGE_SIZE, offset: (page - 1) * blog.PAGE_SIZE });
    const lang = req.lang;
    res.set("Content-Security-Policy", marketingCsp);
    setMarketingSeoLocals(req, res, "/blog.html");
    // Page 2 and later are their own pages: each is its own canonical (?page=N), in both languages.
    res.locals.seoUrls = () => {
      const s = seoLinks(res.locals.siteUrl, "/blog.html", res.locals.lang);
      if (page <= 1 || !s.canonical) return s;
      const q = `?page=${page}`;
      return { ...s, canonical: s.canonical + q, en: s.en + q, fr: s.fr + q, alternates: s.alternates.map((a) => ({ ...a, href: a.href + q })) };
    };
    if (adminPreview) {
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex, nofollow");
    }
    Object.assign(res.locals, {
      cards: rows.map((p, i) => cardFor(p, lang, res, { eager: i === 0 })),
      page, pages, total, hrefFor, adminPreview,
      robots: adminPreview ? "noindex, nofollow" : "",
    });
    renderMarketing(req, res, next, "marketing/blog");
  });

  // ---- one post ----
  router.get("/blog/:slug", async (req, res, next) => {
    const slug = req.params.slug;
    const notFound = () => res.status(404).set("Cache-Control", "no-store").render("404");
    if (!SLUG.test(slug)) return notFound();
    const adminPreview = isAdminPreview(req);
    const post = await blog.getPost(pool, slug, { adminPreview });
    if (!post) return notFound();

    const lang = req.lang;
    const live = blog.isLive(post);
    const frReady = blog.frenchState(post) === "ready";
    const text = blog.localizedText(post, lang);
    const fallback = lang === "fr" && text.lang === "en";
    const { prev, next: following } = live ? await blog.neighbours(pool, post) : {};
    const neighbour = (n) => n && { href: `/blog/${n.slug}`, ...blog.localizedText(n, lang), fallback: lang === "fr" && blog.localizedText(n, lang).lang === "en" };

    setMarketingSeoLocals(req, res, `/blog/${post.slug}`);
    res.set("Content-Security-Policy", marketingCsp);
    const site = res.locals.siteUrl;
    const links = postLinks(site, post.slug, lang, frReady);
    res.locals.seoUrls = () => links;
    if (adminPreview || !live) {
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex, nofollow");
    }

    const image = blog.postImage(post.image_url);
    const pageUrl = links.canonical;
    const ogImage = !image ? "" : image.src.startsWith("/") ? absolute(site, image.src) : /^https?:\/\//i.test(image.src) ? image.src : "";
    const description = text.excerpt || truncate(blog.plainText(text.body), DESCRIPTION_MAX);
    const published = post.published_at instanceof Date ? post.published_at : new Date(post.published_at);
    const modified = post.updated_at ? new Date(post.updated_at) : published;
    const orgLogo = site ? `${site}/assets/img/logo-stamp-1280x720.png` : "";
    const org = { "@type": "Organization", name: BRAND, ...(site ? { url: site } : {}) };
    const homeName = lang === "fr" ? "Accueil" : "Home";
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "BlogPosting",
          headline: text.title,
          ...(description ? { description } : {}),
          inLanguage: text.lang,
          datePublished: published.toISOString(),
          dateModified: (modified > published ? modified : published).toISOString(),
          ...(pageUrl ? { mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl }, url: pageUrl } : {}),
          ...(ogImage || orgLogo ? { image: [ogImage || orgLogo] } : {}),
          author: org,
          publisher: { ...org, ...(orgLogo ? { logo: { "@type": "ImageObject", url: orgLogo } } : {}) },
        },
        ...(site ? [{
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: homeName, item: `${site}${lang === "fr" ? "/fr/" : "/"}` },
            { "@type": "ListItem", position: 2, name: "Blog", item: `${site}${lang === "fr" ? "/fr" : ""}/blog.html` },
            { "@type": "ListItem", position: 3, name: text.title, item: pageUrl },
          ],
        }] : []),
      ],
    };

    Object.assign(res.locals, {
      post, postText: text, fallback, live, adminPreview,
      pageTitle: `${text.title} — ${BRAND}`,
      pageDescription: description,
      postDate: parisDateString(post.published_at),
      postDateLabel: res.locals.formatDateLong(post.published_at),
      postImage: image,
      ogImage, jsonLd,
      ogLocale: text.lang === "fr" ? "fr_FR" : "en_GB",
      metaProps: [
        { property: "article:published_time", content: published.toISOString() },
        { property: "article:modified_time", content: (modified > published ? modified : published).toISOString() },
        ...(post.category ? [{ property: "article:section", content: post.category }] : []),
      ],
      robots: adminPreview || !live ? "noindex, nofollow" : "",
      prevPost: neighbour(prev),
      nextPost: neighbour(following),
    });
    renderMarketing(req, res, next, "marketing/blog_post");
  });

  return router;
}

module.exports = { createBlogPagesRouter, postLinks, SLUG };
