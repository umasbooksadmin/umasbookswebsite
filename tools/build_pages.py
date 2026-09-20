#!/usr/bin/env python3
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
from gen_page import render

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def p(name):
    return os.path.join(ROOT, name)

# ---------------------------------------------------------------- classes.html
classes_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="classes.kicker">Chapter Two</span>
    <h1 data-i18n="classes.title">Éveil Classes</h1>
  </div>

  <div class="section">
    <div class="wrap-narrow">
      <div class="promo-card" style="border:1px solid var(--card-border);">
        <div class="photo-block" role="img" aria-label="Photo placeholder: children's Éveil reading room" style="aspect-ratio:16/9;">
          <span class="placeholder-tag" data-i18n="promo.photo.label">Photo placeholder</span>
        </div>
        <div class="promo-body" style="text-align:center;">
          <h3 data-i18n="eveil.title">Éveil English Immersion Program</h3>
          <p data-i18n="eveil.desc">A joyful, play-based program for children 18 months &ndash; 5 years, with stories, songs and creative activities &mdash; all in English.</p>
        </div>
      </div>
      <h3 class="form-title" data-i18n="eveil.form.title">Ask About Éveil</h3>
      <form class="formcard" data-mailto="admin@umasbooks.org" data-subject="Éveil Program Interest" novalidate>
        <div class="field">
          <label for="ev-name" data-i18n="form.name.l">Name</label>
          <input id="ev-name" type="text" data-field="Name" autocomplete="name">
        </div>
        <div class="field">
          <label for="ev-email" data-i18n="form.email.l">Email</label>
          <input id="ev-email" type="email" data-field="Email" autocomplete="email">
        </div>
        <div class="field">
          <label for="ev-child-age" data-i18n="eveil.form.age.l">Child&#39;s age</label>
          <input id="ev-child-age" type="text" data-field="Child's age">
        </div>
        <div class="field">
          <label for="ev-note" data-i18n="form.note.l">Note (optional)</label>
          <textarea id="ev-note" data-field="Note"></textarea>
        </div>
        <p class="form-hint" data-i18n="form.hint">This opens your email app with the message ready to send.</p>
        <button type="submit" class="btn-submit" data-i18n="eveil.form.submit">Send</button>
      </form>
    </div>
  </div>

  <div class="section">
    <div class="wrap-narrow">
      <div class="page-hero" style="padding-top:0;">
        <h2 data-i18n="classes.other.title">Other Classes</h2>
        <span class="badge-soon" data-i18n="soon.badge">Coming soon</span>
      </div>
      <div class="prose">
        <p data-i18n="classes.intro">We&#39;re looking into offering drop-in classes alongside our existing language exchange sessions. Nothing is scheduled yet &mdash; tell us what you&#39;d be interested in and we&#39;ll keep you posted.</p>
      </div>
      <h3 class="form-title" data-i18n="notify.form.title">Get Notified When It&#39;s Ready</h3>
      <form class="formcard" data-mailto="admin@umasbooks.org" data-subject="Class Interest" novalidate>
        <div class="field">
          <label for="cls-name" data-i18n="form.name.l">Name</label>
          <input id="cls-name" type="text" data-field="Name" autocomplete="name">
        </div>
        <div class="field">
          <label for="cls-email" data-i18n="form.email.l">Email</label>
          <input id="cls-email" type="email" data-field="Email" autocomplete="email">
        </div>
        <div class="field">
          <label for="cls-note" data-i18n="form.note.l">Note (optional)</label>
          <textarea id="cls-note" data-field="Note"></textarea>
        </div>
        <p class="form-hint" data-i18n="form.hint">This opens your email app with the message ready to send.</p>
        <button type="submit" class="btn-submit" data-i18n="notify.form.submit">Notify Me</button>
      </form>
    </div>
  </div>
"""

classes_i18n = {
    "en": {
        "classes.kicker": "For Little Readers",
        "classes.title": "Éveil Classes",
        "promo.photo.label": "Photo placeholder",
        "eveil.title": "Éveil English Immersion Program",
        "eveil.desc": "A joyful, play-based program for children 18 months – 5 years, with stories, songs and creative activities — all in English.",
        "eveil.form.title": "Ask About Éveil",
        "eveil.form.age.l": "Child's age",
        "eveil.form.submit": "Send",
        "classes.other.title": "Other Classes",
        "soon.badge": "Coming soon",
        "classes.intro": "We’re looking into offering drop-in classes alongside our existing language exchange sessions. Nothing is scheduled yet — tell us what you’d be interested in and we’ll keep you posted.",
        "notify.form.title": "Get Notified When It’s Ready",
        "notify.form.submit": "Notify Me",
        "form.name.l": "Name",
        "form.email.l": "Email",
        "form.note.l": "Note (optional)",
        "form.hint": "This opens your email app with the message ready to send.",
    },
    "fr": {
        "classes.kicker": "Pour les petits lecteurs",
        "classes.title": "Cours Éveil",
        "promo.photo.label": "Emplacement photo",
        "eveil.title": "Programme d’immersion anglaise Éveil",
        "eveil.desc": "Un programme ludique par le jeu pour les enfants de 18 mois à 5 ans, avec histoires, chansons et activités créatives — le tout en anglais.",
        "eveil.form.title": "En savoir plus sur Éveil",
        "eveil.form.age.l": "Âge de l’enfant",
        "eveil.form.submit": "Envoyer",
        "classes.other.title": "Autres cours",
        "soon.badge": "Bientôt disponible",
        "classes.intro": "Nous étudions la possibilité de proposer des cours en accès libre, en complément de nos séances d’échange linguistique existantes. Rien n’est encore programmé — dites-nous ce qui vous intéresserait et nous vous tiendrons informé·e.",
        "notify.form.title": "Être informé·e du lancement",
        "notify.form.submit": "M’informer",
        "form.name.l": "Nom",
        "form.email.l": "Email",
        "form.note.l": "Remarque (facultatif)",
        "form.hint": "Cela ouvre votre application de messagerie avec le message prêt à envoyer.",
    },
}

render(p("classes.html"), "Éveil Classes", "classes.html", classes_body, classes_i18n)

# ---------------------------------------------------------------- events.html
events_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="events.kicker">Chapter Three</span>
    <h1 data-i18n="events.title">Adventures &amp; Events</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="note-box" data-i18n-html="ev.calendar.note">
        <strong>See what's coming up &amp; sign up:</strong> <a href="https://umas-books.onrender.com/events">View the events calendar &rarr;</a> &mdash; no account needed.
      </div>
      <div class="cardlist">
        <div class="card">
          <span class="card-title" data-i18n="ev.club.t">Monthly Book Club</span>
          <span class="card-desc" data-i18n="ev.club.d">One story, discussed over tea &mdash; details posted in shop.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="ev.lang.t">Language Exchange</span>
          <span class="card-desc" data-i18n="ev.lang.d">Weekly sessions for adults, plus a dedicated children&#39;s group &mdash; conversation practice, or storytime for younger learners.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="ev.swap.t">Story Swaps</span>
          <span class="card-desc" data-i18n="ev.swap.d">Bring a book, take a book, meet fellow readers.</span>
        </div>
      </div>
      <div class="note-box" data-i18n-html="ev.rsvp.note">
        <strong>Want to join in?</strong> Drop us a line and we&#39;ll let you know the next date &mdash; <a href="mailto:admin@umasbooks.org?subject=Event%20RSVP">admin@umasbooks.org</a>.
      </div>
    </div>
  </div>
"""

events_i18n = {
    "en": {
        "events.kicker": "Chapter Three",
        "events.title": "Adventures & Events",
        "ev.club.t": "Monthly Book Club",
        "ev.club.d": "One story, discussed over tea — details posted in shop.",
        "ev.lang.t": "Language Exchange",
        "ev.lang.d": "Weekly sessions for adults, plus a dedicated children’s group — conversation practice, or storytime for younger learners.",
        "ev.swap.t": "Story Swaps",
        "ev.swap.d": "Bring a book, take a book, meet fellow readers.",
        "ev.calendar.note": "<strong>See what's coming up &amp; sign up:</strong> <a href=\"https://umas-books.onrender.com/events\">View the events calendar &rarr;</a> — no account needed.",
        "ev.rsvp.note": "<strong>Want to join in?</strong> Drop us a line and we’ll let you know the next date — <a href=\"mailto:admin@umasbooks.org?subject=Event%20RSVP\">admin@umasbooks.org</a>.",
    },
    "fr": {
        "events.kicker": "Chapitre trois",
        "events.title": "Aventures et événements",
        "ev.club.t": "Club de lecture mensuel",
        "ev.club.d": "Un livre, discuté autour d’un thé — détails affichés en boutique.",
        "ev.lang.t": "Échange linguistique",
        "ev.lang.d": "Séances hebdomadaires pour adultes, plus un groupe dédié aux enfants — pratique de la conversation ou lecture d’histoires pour les plus jeunes.",
        "ev.swap.t": "Trocs de livres",
        "ev.swap.d": "Apportez un livre, repartez avec un autre, rencontrez d’autres lecteurs.",
        "ev.calendar.note": "<strong>Découvrez le programme et inscrivez-vous :</strong> <a href=\"https://umas-books.onrender.com/events\">Voir le calendrier des événements &rarr;</a> — aucun compte requis.",
        "ev.rsvp.note": "<strong>Envie de nous rejoindre ?</strong> Écrivez-nous et nous vous indiquerons la prochaine date — <a href=\"mailto:admin@umasbooks.org?subject=Event%20RSVP\">admin@umasbooks.org</a>.",
    },
}

render(p("events.html"), "Events", "events.html", events_body, events_i18n)

# ---------------------------------------------------------------- about.html
about_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="about.kicker">Our Story</span>
    <h1 data-i18n="about.title">About Uma&#39;s</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="prose">
        <p data-i18n="c1.p1">Uma&#39;s Books and Adventures is a non-profit bookshop built entirely on books that already had one home before finding their way to our shelves. Every title here has been read, released, and re-shelved by someone in Albi's English-speaking community &mdash; a paperback traded in after a summer read, a donated box from someone moving on, a hardback rescued before its next stop at the recycling bin.</p>
        <p data-i18n="c1.p2">Run by volunteers and open just a few days a week, the shop exists for one simple reason: to keep good English-language books affordable, in circulation, and easy to find &mdash; however far from home you happen to be. But the shelves are only half of it. As much as a bookshop, this is a meeting point &mdash; a small, unhurried space where anglophones and francophones, longtime Albigeois and newly arrived expats, cross paths over a shared shelf and swap more than books: languages, recommendations, and a little bit of home.</p>
      </div>
    </div>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <h2 style="text-align:center;" data-i18n="about.involved.title">Get Involved</h2>
      <div class="promo-grid" style="max-width:62ch; padding:24px 0 0; grid-template-columns:1fr 1fr;">
        <div class="promo-card">
          <div class="promo-body">
            <h3 data-i18n="about.volunteer.t">Volunteer</h3>
            <p data-i18n="about.volunteer.d">Uma&#39;s is entirely volunteer-run &mdash; new helpers of any language level are always welcome.</p>
            <a class="btn btn-outline" href="volunteer.html" data-i18n="about.volunteer.cta">See Roles &amp; Sign Up</a>
          </div>
        </div>
        <div class="promo-card">
          <div class="promo-body">
            <h3 data-i18n="about.wishlist.t">Wish List</h3>
            <p data-i18n="about.wishlist.d">Have a title in mind, or know what we should be looking for? Tell us.</p>
            <a class="btn btn-outline" href="wishlist.html" data-i18n="about.wishlist.cta">Suggest a Title</a>
          </div>
        </div>
      </div>
    </div>
  </div>
"""

about_i18n = {
    "en": {
        "about.kicker": "Our Story",
        "about.title": "About Uma's",
        "c1.p1": "Uma’s Books and Adventures is a non-profit bookshop built entirely on books that already had one home before finding their way to our shelves. Every title here has been read, released, and re-shelved by someone in Albi’s English-speaking community — a paperback traded in after a summer read, a donated box from someone moving on, a hardback rescued before its next stop at the recycling bin.",
        "c1.p2": "Run by volunteers and open just a few days a week, the shop exists for one simple reason: to keep good English-language books affordable, in circulation, and easy to find — however far from home you happen to be. But the shelves are only half of it. As much as a bookshop, this is a meeting point — a small, unhurried space where anglophones and francophones, longtime Albigeois and newly arrived expats, cross paths over a shared shelf and swap more than books: languages, recommendations, and a little bit of home.",
        "about.involved.title": "Get Involved",
        "about.volunteer.t": "Volunteer",
        "about.volunteer.d": "Uma’s is entirely volunteer-run — new helpers of any language level are always welcome.",
        "about.volunteer.cta": "See Roles & Sign Up",
        "about.wishlist.t": "Wish List",
        "about.wishlist.d": "Have a title in mind, or know what we should be looking for? Tell us.",
        "about.wishlist.cta": "Suggest a Title",
    },
    "fr": {
        "about.kicker": "Notre histoire",
        "about.title": "À propos d’Uma’s",
        "c1.p1": "Uma’s Books and Adventures est une librairie à but non lucratif entièrement constituée de livres qui ont déjà connu un premier foyer avant d’arriver sur nos étagères. Chaque titre a été lu, cédé puis remis en rayon par quelqu’un de la communauté anglophone d’Albi : un poche rapporté après une lecture d’été, un carton donné par une personne qui déménage, un beau livre relié sauvé juste avant le bac de recyclage.",
        "c1.p2": "Tenue par des bénévoles et ouverte seulement quelques jours par semaine, la boutique existe pour une raison simple : garder les bons livres en anglais abordables, en circulation et faciles à trouver, aussi loin de chez soi que l’on soit. Mais les rayons ne sont qu’une moitié de l’histoire. Autant qu’une librairie, c’est un lieu de rencontre : un petit espace sans hâte où anglophones et francophones, Albigeois de longue date et expatriés fraîchement arrivés se croisent autour d’une étagère commune et échangent bien plus que des livres — des langues, des conseils de lecture et un peu de chez-soi.",
        "about.involved.title": "S’impliquer",
        "about.volunteer.t": "Bénévolat",
        "about.volunteer.d": "Uma’s fonctionne entièrement grâce à des bénévoles — les nouveaux bénévoles, quel que soit leur niveau de langue, sont toujours les bienvenus.",
        "about.volunteer.cta": "Voir les rôles et s’inscrire",
        "about.wishlist.t": "Liste de souhaits",
        "about.wishlist.d": "Un titre en tête, ou une idée de ce que nous devrions chercher ? Dites-le-nous.",
        "about.wishlist.cta": "Suggérer un titre",
    },
}

render(p("about.html"), "About", "about.html", about_body, about_i18n)

# ---------------------------------------------------------------- visit.html
visit_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="visit.kicker">Chapter Four</span>
    <h1 data-i18n="visit.title">Visit Us</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="visit-grid">
        <div class="visit-item">
          <span class="label" data-i18n="visit.where.l">Where</span>
          <span class="value" data-i18n="visit.where.v">Rue Peyroli&egrave;re, 81000 Albi</span>
        </div>
        <div class="visit-item">
          <span class="label" data-i18n="visit.hours.l">Hours</span>
          <span class="value">
            <span class="hours-row"><span data-i18n="visit.hours.days">Tue &ndash; Sat</span><span data-i18n="visit.hours.time">10:00&ndash;19:00</span></span>
          </span>
        </div>
        <div class="visit-item">
          <span class="label" data-i18n="visit.contact.l">Contact</span>
          <span class="value"><a href="mailto:admin@umasbooks.org">admin@umasbooks.org</a></span>
        </div>
      </div>
    </div>
  </div>
"""

visit_i18n = {
    "en": {
        "visit.kicker": "Chapter Four",
        "visit.title": "Visit Us",
        "visit.where.l": "Where",
        "visit.where.v": "Rue Peyrolière, 81000 Albi",
        "visit.hours.l": "Hours",
        "visit.hours.days": "Tue – Sat",
        "visit.hours.time": "10:00–19:00",
        "visit.contact.l": "Contact",
    },
    "fr": {
        "visit.kicker": "Chapitre quatre",
        "visit.title": "Nous rendre visite",
        "visit.where.l": "Où",
        "visit.where.v": "Rue Peyrolière, 81000 Albi",
        "visit.hours.l": "Horaires",
        "visit.hours.days": "Mar – Sam",
        "visit.hours.time": "10h00–19h00",
        "visit.contact.l": "Contact",
    },
}

render(p("visit.html"), "Visit", "visit.html", visit_body, visit_i18n)

# ---------------------------------------------------------------- volunteer.html (not in main nav; linked from About/footer)
volunteer_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="volunteer.kicker">Get Involved</span>
    <h1 data-i18n="volunteer.title">Volunteer With Us</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="prose">
        <p data-i18n="volunteer.intro">Uma&#39;s is entirely volunteer-run &mdash; every hour on the shop floor, every sorted donation, every event, is someone giving their time. New volunteers, at any language level, are always welcome.</p>
      </div>
      <div class="cardlist" style="margin-top: 28px;">
        <div class="card">
          <span class="card-title" data-i18n="volunteer.shop.t">Shop Floor</span>
          <span class="card-desc" data-i18n="volunteer.shop.d">Welcome visitors and mind the till during opening hours.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="volunteer.sorting.t">Sorting &amp; Shelving</span>
          <span class="card-desc" data-i18n="volunteer.sorting.d">Sort donations and keep the collection organised.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="volunteer.events.t">Events &amp; Language Exchange</span>
          <span class="card-desc" data-i18n="volunteer.events.d">Help run book club, language exchange, or story swaps.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="volunteer.translation.t">Bilingual Support</span>
          <span class="card-desc" data-i18n="volunteer.translation.d">Help visitors and paperwork move smoothly between English and French.</span>
        </div>
      </div>
      <h3 class="form-title" data-i18n="volunteer.schedule.title">Shop Shifts</h3>
      <table class="scheduletable">
        <thead>
          <tr><th data-i18n="volunteer.schedule.day">Days</th><th data-i18n="volunteer.schedule.time">Time</th></tr>
        </thead>
        <tbody>
          <tr><td data-i18n="visit.hours.days">Tue &ndash; Sat</td><td data-i18n="visit.hours.time">10:00&ndash;19:00</td></tr>
        </tbody>
      </table>
      <p class="form-hint" data-i18n="volunteer.schedule.note">Shifts typically run 2&ndash;3 hours within opening hours &mdash; tell us what works for you below.</p>
      <h3 class="form-title" data-i18n="volunteer.form.title">Volunteer Sign-up</h3>
      <form class="formcard" data-mailto="admin@umasbooks.org" data-subject="Volunteer Sign-up" novalidate>
        <div class="field">
          <label for="vol-name" data-i18n="form.name.l">Name</label>
          <input id="vol-name" type="text" data-field="Name" autocomplete="name">
        </div>
        <div class="field">
          <label for="vol-email" data-i18n="form.email.l">Email</label>
          <input id="vol-email" type="email" data-field="Email" autocomplete="email">
        </div>
        <div class="field">
          <label for="vol-avail" data-i18n="volunteer.form.avail.l">Availability</label>
          <input id="vol-avail" type="text" data-field="Availability">
        </div>
        <div class="field">
          <label for="vol-note" data-i18n="form.note.l">Note (optional)</label>
          <textarea id="vol-note" data-field="Note"></textarea>
        </div>
        <p class="form-hint" data-i18n="form.hint">This opens your email app with the message ready to send.</p>
        <button type="submit" class="btn-submit" data-i18n="volunteer.form.submit">Send Sign-up</button>
      </form>
    </div>
  </div>
"""

volunteer_i18n = {
    "en": {
        "visit.hours.days": "Tue – Sat",
        "visit.hours.time": "10:00–19:00",
        "volunteer.kicker": "Get Involved",
        "volunteer.title": "Volunteer With Us",
        "volunteer.intro": "Uma’s is entirely volunteer-run — every hour on the shop floor, every sorted donation, every event, is someone giving their time. New volunteers, at any language level, are always welcome.",
        "volunteer.shop.t": "Shop Floor",
        "volunteer.shop.d": "Welcome visitors and mind the till during opening hours.",
        "volunteer.sorting.t": "Sorting & Shelving",
        "volunteer.sorting.d": "Sort donations and keep the collection organised.",
        "volunteer.events.t": "Events & Language Exchange",
        "volunteer.events.d": "Help run book club, language exchange, or story swaps.",
        "volunteer.translation.t": "Bilingual Support",
        "volunteer.translation.d": "Help visitors and paperwork move smoothly between English and French.",
        "volunteer.schedule.title": "Shop Shifts",
        "volunteer.schedule.day": "Days",
        "volunteer.schedule.time": "Time",
        "volunteer.schedule.note": "Shifts typically run 2–3 hours within opening hours — tell us what works for you below.",
        "volunteer.form.title": "Volunteer Sign-up",
        "volunteer.form.avail.l": "Availability",
        "volunteer.form.submit": "Send Sign-up",
        "form.name.l": "Name",
        "form.email.l": "Email",
        "form.note.l": "Note (optional)",
        "form.hint": "This opens your email app with the message ready to send.",
    },
    "fr": {
        "visit.hours.days": "Mar – Sam",
        "visit.hours.time": "10h00–19h00",
        "volunteer.kicker": "S’impliquer",
        "volunteer.title": "Devenir bénévole",
        "volunteer.intro": "Uma’s fonctionne entièrement grâce à des bénévoles — chaque heure en boutique, chaque don trié, chaque événement, c’est quelqu’un qui donne de son temps. Les nouveaux bénévoles, quel que soit leur niveau de langue, sont toujours les bienvenus.",
        "volunteer.shop.t": "En boutique",
        "volunteer.shop.d": "Accueillir les visiteurs et tenir la caisse pendant les heures d’ouverture.",
        "volunteer.sorting.t": "Tri et rangement",
        "volunteer.sorting.d": "Trier les dons et garder la collection organisée.",
        "volunteer.events.t": "Événements et échange linguistique",
        "volunteer.events.d": "Aider à animer le club de lecture, l’échange linguistique ou les trocs de livres.",
        "volunteer.translation.t": "Soutien bilingue",
        "volunteer.translation.d": "Aider les visiteurs et les démarches à circuler facilement entre l’anglais et le français.",
        "volunteer.schedule.title": "Créneaux en boutique",
        "volunteer.schedule.day": "Jours",
        "volunteer.schedule.time": "Horaire",
        "volunteer.schedule.note": "Les créneaux durent généralement 2 à 3 heures pendant les heures d’ouverture — indiquez-nous vos disponibilités ci-dessous.",
        "volunteer.form.title": "Formulaire de bénévolat",
        "volunteer.form.avail.l": "Disponibilités",
        "volunteer.form.submit": "Envoyer ma candidature",
        "form.name.l": "Nom",
        "form.email.l": "Email",
        "form.note.l": "Remarque (facultatif)",
        "form.hint": "Cela ouvre votre application de messagerie avec le message prêt à envoyer.",
    },
}

render(p("volunteer.html"), "Volunteer", "", volunteer_body, volunteer_i18n)

# ---------------------------------------------------------------- wishlist.html (not in main nav; linked from About/footer/header heart icon)
wishlist_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="wishlist.kicker">For Our Shelves</span>
    <h1 data-i18n="wishlist.title">The Wish List</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="prose">
        <p data-i18n="wishlist.intro">Every shelf here started as someone&#39;s wish list. If there&#39;s a title you&#39;re hoping to find, or a kind of book we should keep an eye out for, tell us &mdash; we&#39;ll watch for it as new donations come in.</p>
      </div>
      <div class="cardlist" style="margin-top: 28px;">
        <div class="card">
          <span class="card-title" data-i18n="wishlist.ya.t">Young Adult &amp; Teen</span>
          <span class="card-desc" data-i18n="wishlist.ya.d">Contemporary and classic YA in English &mdash; always in demand, always short on shelf space.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="wishlist.langlearn.t">Language Learners</span>
          <span class="card-desc" data-i18n="wishlist.langlearn.d">Graded readers and simple English titles for francophone readers building confidence.</span>
        </div>
        <div class="card">
          <span class="card-title" data-i18n="wishlist.large.t">Large Print &amp; Audio</span>
          <span class="card-desc" data-i18n="wishlist.large.d">Large-print editions and English-language audiobooks, for readers who need them.</span>
        </div>
      </div>
      <h3 class="form-title" data-i18n="wishlist.form.title">Suggest a Title</h3>
      <form class="formcard" data-mailto="admin@umasbooks.org" data-subject="Book Wish List Suggestion" novalidate>
        <div class="field">
          <label for="wl-name" data-i18n="form.name.l">Name</label>
          <input id="wl-name" type="text" data-field="Name" autocomplete="name">
        </div>
        <div class="field">
          <label for="wl-email" data-i18n="form.email.l">Email</label>
          <input id="wl-email" type="email" data-field="Email" autocomplete="email">
        </div>
        <div class="field">
          <label for="wl-book" data-i18n="wishlist.form.book.l">Title &amp; author</label>
          <input id="wl-book" type="text" data-field="Title/Author">
        </div>
        <div class="field">
          <label for="wl-note" data-i18n="form.note.l">Note (optional)</label>
          <textarea id="wl-note" data-field="Note"></textarea>
        </div>
        <p class="form-hint" data-i18n="form.hint">This opens your email app with the message ready to send.</p>
        <button type="submit" class="btn-submit" data-i18n="wishlist.form.submit">Send Suggestion</button>
      </form>
    </div>
  </div>
"""

wishlist_i18n = {
    "en": {
        "wishlist.kicker": "For Our Shelves",
        "wishlist.title": "The Wish List",
        "wishlist.intro": "Every shelf here started as someone’s wish list. If there’s a title you’re hoping to find, or a kind of book we should keep an eye out for, tell us — we’ll watch for it as new donations come in.",
        "wishlist.ya.t": "Young Adult & Teen",
        "wishlist.ya.d": "Contemporary and classic YA in English — always in demand, always short on shelf space.",
        "wishlist.langlearn.t": "Language Learners",
        "wishlist.langlearn.d": "Graded readers and simple English titles for francophone readers building confidence.",
        "wishlist.large.t": "Large Print & Audio",
        "wishlist.large.d": "Large-print editions and English-language audiobooks, for readers who need them.",
        "wishlist.form.title": "Suggest a Title",
        "wishlist.form.book.l": "Title & author",
        "wishlist.form.submit": "Send Suggestion",
        "form.name.l": "Name",
        "form.email.l": "Email",
        "form.note.l": "Note (optional)",
        "form.hint": "This opens your email app with the message ready to send.",
    },
    "fr": {
        "wishlist.kicker": "Pour nos étagères",
        "wishlist.title": "La liste de souhaits",
        "wishlist.intro": "Chaque étagère ici a commencé comme la liste de souhaits de quelqu’un. S’il y a un titre que vous espérez trouver, ou un genre de livre que nous devrions rechercher, dites-le-nous — nous y prêterons attention à l’arrivée des nouveaux dons.",
        "wishlist.ya.t": "Jeunes adultes et adolescents",
        "wishlist.ya.d": "Romans jeunesse contemporains et classiques en anglais — toujours demandés, toujours à court de place sur nos rayons.",
        "wishlist.langlearn.t": "Apprenants de langue",
        "wishlist.langlearn.d": "Livres gradués et titres en anglais simple pour les lecteurs francophones qui gagnent en confiance.",
        "wishlist.large.t": "Gros caractères et audio",
        "wishlist.large.d": "Éditions en gros caractères et livres audio en anglais, pour les lecteurs qui en ont besoin.",
        "wishlist.form.title": "Suggérer un titre",
        "wishlist.form.book.l": "Titre et auteur",
        "wishlist.form.submit": "Envoyer la suggestion",
        "form.name.l": "Nom",
        "form.email.l": "Email",
        "form.note.l": "Remarque (facultatif)",
        "form.hint": "Cela ouvre votre application de messagerie avec le message prêt à envoyer.",
    },
}

render(p("wishlist.html"), "Wish List", "", wishlist_body, wishlist_i18n)

# ---------------------------------------------------------------- membership.html (linked from header account icon / footer)
membership_body = """
  <div class="page-hero">
    <span class="kicker" data-i18n="membership.kicker">Support the Shop</span>
    <h1 data-i18n="membership.title">Become a Member</h1>
  </div>
  <div class="section">
    <div class="wrap-narrow">
      <div class="prose">
        <p data-i18n="membership.intro">Membership accounts are open &mdash; log in or create yours to support the shop directly.</p>
      </div>
      <div class="cta-row">
        <!-- TODO: confirm this is the live Squarespace member login/join page URL before publishing -->
        <a class="btn btn-maroon" href="https://umasbooks.org/member-login" data-i18n="membership.cta">Log In / Join</a>
      </div>
      <div class="note-box" data-i18n-html="membership.contact.note">
        Trouble logging in? Email us at <a href="mailto:admin@umasbooks.org">admin@umasbooks.org</a>.
      </div>
    </div>
  </div>
"""

membership_i18n = {
    "en": {
        "membership.kicker": "Support the Shop",
        "membership.title": "Become a Member",
        "membership.intro": "Membership accounts are open — log in or create yours to support the shop directly.",
        "membership.cta": "Log In / Join",
        "membership.contact.note": "Trouble logging in? Email us at <a href=\"mailto:admin@umasbooks.org\">admin@umasbooks.org</a>.",
    },
    "fr": {
        "membership.kicker": "Soutenir la boutique",
        "membership.title": "Devenir membre",
        "membership.intro": "Les comptes d’adhésion sont ouverts — connectez-vous ou créez le vôtre pour soutenir la boutique directement.",
        "membership.cta": "Se connecter / Adhérer",
        "membership.contact.note": "Un souci de connexion ? Écrivez-nous à <a href=\"mailto:admin@umasbooks.org\">admin@umasbooks.org</a>.",
    },
}

render(p("membership.html"), "Membership", "", membership_body, membership_i18n)

print("done")
