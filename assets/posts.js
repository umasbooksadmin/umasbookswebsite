/* Uma's Books & Adventures — blog posts.
 *
 * The home page "What's New" slider shows the 5 newest; blog.html lists all and
 * shows each one in full (blog.html?post=<slug>).
 *
 * To add a post, copy one of the blocks below to the TOP of the list and
 * change it:
 *   slug     short unique id, used in the link (letters, numbers, dashes)
 *   date     "YYYY-MM-DD" — newest first is decided by this date
 *   image    optional: a file in assets/img/ (or a full https:// link)
 *   imageFit optional: "contain" for round/transparent artwork,
 *            leave out for photos (they fill the frame)
 *   category optional small label shown above the title, e.g.
 *            { en: "Event", fr: "Événement" }
 *   title / excerpt / body   English ("en") and French ("fr");
 *            if "fr" is missing the English is shown.
 *   body     a list of paragraphs (plain text).
 *
 * The three posts below are starter posts drawn from the site's own text —
 * edit or replace them with real news.
 */
window.UMAS_POSTS = [
  {
    slug: "welcome",
    category: { en: "News", fr: "Actualités" },
    date: "2026-09-24",
    image: "assets/img/shop-interior.jpg",
    title: {
      en: "Welcome to Uma’s Books & Adventures",
      fr: "Bienvenue chez Uma’s Books & Adventures"
    },
    excerpt: {
      en: "A small, unhurried space in Albi for pre-loved English books, languages and a little bit of home.",
      fr: "Un petit lieu sans hâte à Albi pour les livres anglais d’occasion, les langues et un peu de chez-soi."
    },
    body: {
      en: [
        "Uma’s Books & Adventures is a non-profit bookshop built entirely on books that already had one home before finding their way to our shelves.",
        "Run by volunteers, the shop exists for one simple reason: to keep good English-language books affordable, in circulation, and easy to find — however far from home you happen to be.",
        "As much as a bookshop, it is a meeting point, where anglophones and francophones cross paths over a shared shelf and swap more than books: languages, recommendations, and a little bit of home. Come and say hello on Rue Peyrolière."
      ],
      fr: [
        "Uma’s Books & Adventures est une librairie à but non lucratif entièrement constituée de livres qui ont déjà connu un premier foyer avant d’arriver sur nos étagères.",
        "Tenue par des bénévoles, la boutique existe pour une raison simple : garder les bons livres en anglais abordables, en circulation et faciles à trouver, aussi loin de chez soi que l’on soit.",
        "Autant qu’une librairie, c’est un lieu de rencontre où anglophones et francophones se croisent autour d’une étagère commune et échangent bien plus que des livres : des langues, des conseils de lecture et un peu de chez-soi. Venez nous dire bonjour rue Peyrolière."
      ]
    }
  },
  {
    slug: "donating-books",
    category: { en: "Donate", fr: "Dons" },
    date: "2026-09-24",
    image: "assets/img/medallion-donate.png",
    imageFit: "contain",
    title: {
      en: "Give your books a second life",
      fr: "Offrez une seconde vie à vos livres"
    },
    excerpt: {
      en: "Every shelf here started as someone’s donation. Here’s how to bring yours in.",
      fr: "Chaque étagère ici a commencé par un don. Voici comment apporter les vôtres."
    },
    body: {
      en: [
        "Every shelf in the shop started as someone’s donation. Bringing in your gently used English-language books gives them a second life and keeps our prices low for the whole community.",
        "Bring your books by during opening hours, or get in touch at admin@umasbooks.org to arrange a drop-off."
      ],
      fr: [
        "Chaque étagère de la boutique a commencé par un don. Apporter vos livres en anglais en bon état leur donne une seconde vie et permet de garder nos prix accessibles pour toute la communauté.",
        "Apportez vos livres pendant nos heures d’ouverture, ou écrivez-nous à admin@umasbooks.org pour organiser un dépôt."
      ]
    }
  },
  {
    slug: "volunteering",
    category: { en: "Community", fr: "Communauté" },
    date: "2026-09-24",
    image: "assets/img/medallion-browse.png",
    imageFit: "contain",
    title: {
      en: "Volunteers wanted",
      fr: "Bénévoles recherchés"
    },
    excerpt: {
      en: "Uma’s is entirely volunteer-run — new helpers of any language level are always welcome.",
      fr: "Uma’s fonctionne entièrement grâce à des bénévoles — les nouveaux venus sont toujours les bienvenus."
    },
    body: {
      en: [
        "Uma’s is entirely volunteer-run, and new helpers of any language level are always welcome.",
        "Whether you can give a few hours a month or a regular shift, there’s a role for you. See the roles and sign up on our Volunteer page."
      ],
      fr: [
        "Uma’s fonctionne entièrement grâce à des bénévoles, et les nouveaux venus, quel que soit leur niveau de langue, sont toujours les bienvenus.",
        "Que vous puissiez donner quelques heures par mois ou tenir une permanence régulière, il y a un rôle pour vous. Découvrez les rôles et inscrivez-vous sur notre page Bénévolat."
      ]
    }
  }
];
