#!/usr/bin/env python3
"""One-off generator used to scaffold the multi-page site's sub-pages
consistently (shared header/footer, per-page content + i18n dict).
Not part of the build process; safe to delete once pages are stable."""
import json
import sys

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title} &mdash; Uma's Books and Adventures</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,900;1,500;1,600&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/site.css">
</head>
<body>
"""

def header(active):
    navs = [
        ("books.html", "nav.books", "Books"),
        ("classes.html", "nav.classes", "Éveil Classes"),
        ("events.html", "nav.events", "Events"),
        ("about.html", "nav.about", "About"),
        ("visit.html", "nav.visit", "Visit"),
    ]
    links = []
    for href, key, text in navs:
        cls = ' class="is-active"' if href == active else ""
        links.append(f'      <a href="{href}"{cls} data-i18n="{key}">{text}</a>')
    links_html = "\n".join(links)
    return f"""
<header class="site">
  <div class="nav-row">
    <a class="brandmark" href="index.html">
      <img src="logo.png" alt="Uma's Books and Adventures logo">
      <span class="brand-text">
        <span class="brand-name">Uma's Books</span>
        <span class="brand-tag" data-i18n="brand.tag">English Pre-Loved Books</span>
      </span>
    </a>
    <nav class="mainlinks">
{links_html}
    </nav>
    <div class="header-tools">
      <div class="langtoggle" role="group" aria-label="Language / Langue">
        <button type="button" data-lang="en" class="is-active" aria-pressed="true">EN</button>
        <span aria-hidden="true">|</span>
        <button type="button" data-lang="fr" aria-pressed="false">FR</button>
      </div>
      <a class="icon-btn" href="books.html" data-i18n-attr="title:icon.search;aria-label:icon.search" title="Search" aria-label="Search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </a>
      <a class="icon-btn" href="membership.html" data-i18n-attr="title:icon.account;aria-label:icon.account" title="Account / Membership" aria-label="Account / Membership">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>
      </a>
      <a class="icon-btn" href="wishlist.html" data-i18n-attr="title:icon.wishlist;aria-label:icon.wishlist" title="Wish List" aria-label="Wish List">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 20s-7-4.4-9.5-8.8C.8 7.8 2.4 4.5 5.8 4c2-.3 3.7.7 4.8 2.4L12 8l1.4-1.6C14.5 4.7 16.2 3.7 18.2 4c3.4.5 5 3.8 3.3 7.2C19 15.6 12 20 12 20z"/></svg>
      </a>
      <!-- TODO: confirm this is the live Squarespace shop page URL before publishing -->
      <a class="icon-btn" href="https://umasbooks.org/shop" data-i18n-attr="title:icon.cart;aria-label:icon.cart" title="Shop" aria-label="Shop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>
      </a>
    </div>
  </div>
</header>
"""

FOOTER = """
<footer class="site">
  <div class="footer-grid">
    <div>
      <div class="fname">Uma's Books &amp; Adventures</div>
      <div class="faddr" data-i18n="footer.addr">Rue Peyroli&egrave;re, 81000 Albi</div>
      <div class="fhours" data-i18n="footer.hours.l">Tuesday &ndash; Saturday, 10:00&ndash;19:00</div>
    </div>
    <div class="footer-links">
      <a href="mailto:admin@umasbooks.org" data-i18n="footer.contact">Contact</a>
      <a href="wishlist.html" data-i18n="footer.wishlist">Wish List</a>
      <a href="volunteer.html" data-i18n="footer.volunteer">Volunteer</a>
      <a href="membership.html" data-i18n="footer.membership">Membership</a>
    </div>
    <div class="footer-social">
      <!-- TODO: add real social links when available -->
      <a href="#" aria-label="Instagram" title="Instagram (coming soon)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg></a>
      <a href="#" aria-label="Facebook" title="Facebook (coming soon)"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5 21v-8h2.7l.4-3.1h-3.1V8c0-.9.25-1.5 1.55-1.5H17V3.7C16.7 3.6 15.7 3.5 14.5 3.5c-2.4 0-4 1.5-4 4.1v2.3H8v3.1h2.5V21h3z"/></svg></a>
    </div>
  </div>
  <div class="footer-bottom">
    <span data-i18n="footer.tagline">Good books. Brighter lives.</span>
  </div>
</footer>
"""

def render(out_path, title, active, body_html, i18n):
    parts = [HEAD.format(title=title), header(active), '<main>', body_html, '</main>', FOOTER]
    parts.append('\n<script>\nwindow.PAGE_I18N = ' + json.dumps(i18n, indent=2, ensure_ascii=False) + ';\n</script>\n')
    parts.append('<script src="assets/site.js"></script>\n</body>\n</html>\n')
    html = "".join(parts)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote", out_path)
