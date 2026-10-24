-- Blog posts get an optional French version (title, excerpt, body). One slug serves both languages
-- (/blog/<slug> and /fr/blog/<slug>). All three columns are nullable: a post may be published in English
-- alone, and the French pages then show the English text with a notice (lib/blogPosts.js). The French body
-- passes the same sanitize-html allowlist as the English one, when it is written and again when it is served.
-- (French texts are written in /admin/blog; see the end of this file for the three starter posts.)
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS title_fr TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS excerpt_fr TEXT;
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS body_fr TEXT;

-- The one exception: the French texts of the three starter posts already exist in the repository (the old
-- hand-edited assets/posts.js, written by the shop, not machine translated). They are attached only to a row
-- whose English text is still EXACTLY the original of migration 027 and that has no French yet, so an edited
-- post, or one with French already, is never touched. Re-running changes nothing.
UPDATE blog_posts
   SET title_fr = 'Bienvenue chez Uma’s Books & Adventures',
       excerpt_fr = 'Un petit lieu sans hâte à Albi pour les livres anglais d’occasion, les langues et un peu de chez-soi.',
       body_fr = '<p>Uma’s Books & Adventures est une librairie à but non lucratif entièrement constituée de livres qui ont déjà connu un premier foyer avant d’arriver sur nos étagères.</p><p>Tenue par des bénévoles, la boutique existe pour une raison simple : garder les bons livres en anglais abordables, en circulation et faciles à trouver, aussi loin de chez soi que l’on soit.</p><p>Autant qu’une librairie, c’est un lieu de rencontre où anglophones et francophones se croisent autour d’une étagère commune et échangent bien plus que des livres : des langues, des conseils de lecture et un peu de chez-soi. Venez nous dire bonjour rue Peyrolière.</p>'
 WHERE slug = 'welcome'
   AND title = 'Welcome to Uma’s Books & Adventures'
   AND excerpt = 'A small, unhurried space in Albi for pre-loved English books, languages and a little bit of home.'
   AND body = '<p>Uma’s Books & Adventures is a non-profit bookshop built entirely on books that already had one home before finding their way to our shelves.</p><p>Run by volunteers, the shop exists for one simple reason: to keep good English-language books affordable, in circulation, and easy to find — however far from home you happen to be.</p><p>As much as a bookshop, it is a meeting point, where anglophones and francophones cross paths over a shared shelf and swap more than books: languages, recommendations, and a little bit of home. Come and say hello on Rue Peyrolière.</p>'
   AND title_fr IS NULL AND excerpt_fr IS NULL AND body_fr IS NULL;

UPDATE blog_posts
   SET title_fr = 'Offrez une seconde vie à vos livres',
       excerpt_fr = 'Chaque étagère ici a commencé par un don. Voici comment apporter les vôtres.',
       body_fr = '<p>Chaque étagère de la boutique a commencé par un don. Apporter vos livres en anglais en bon état leur donne une seconde vie et permet de garder nos prix accessibles pour toute la communauté.</p><p>Apportez vos livres pendant nos heures d’ouverture, ou écrivez-nous à admin@umasbooks.org pour organiser un dépôt.</p>'
 WHERE slug = 'donating-books'
   AND title = 'Give your books a second life'
   AND excerpt = 'Every shelf here started as someone’s donation. Here’s how to bring yours in.'
   AND body = '<p>Every shelf in the shop started as someone’s donation. Bringing in your gently used English-language books gives them a second life and keeps our prices low for the whole community.</p><p>Bring your books by during opening hours, or get in touch at admin@umasbooks.org to arrange a drop-off.</p>'
   AND title_fr IS NULL AND excerpt_fr IS NULL AND body_fr IS NULL;

UPDATE blog_posts
   SET title_fr = 'Bénévoles recherchés',
       excerpt_fr = 'Uma’s fonctionne entièrement grâce à des bénévoles — les nouveaux venus sont toujours les bienvenus.',
       body_fr = '<p>Uma’s fonctionne entièrement grâce à des bénévoles, et les nouveaux venus, quel que soit leur niveau de langue, sont toujours les bienvenus.</p><p>Que vous puissiez donner quelques heures par mois ou tenir une permanence régulière, il y a un rôle pour vous. Découvrez les rôles et inscrivez-vous sur notre page Bénévolat.</p>'
 WHERE slug = 'volunteering'
   AND title = 'Volunteers wanted'
   AND excerpt = 'Uma’s is entirely volunteer-run — new helpers of any language level are always welcome.'
   AND body = '<p>Uma’s is entirely volunteer-run, and new helpers of any language level are always welcome.</p><p>Whether you can give a few hours a month or a regular shift, there’s a role for you. See the roles and sign up on our Volunteer page.</p>'
   AND title_fr IS NULL AND excerpt_fr IS NULL AND body_fr IS NULL;

