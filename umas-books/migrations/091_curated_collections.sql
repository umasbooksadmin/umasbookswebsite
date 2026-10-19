-- Curated collections: hand-picked shelves of books ("Paris Is Always a Good Idea", "Bedtime Stories for Little
-- Daydreamers" ...) shown as a row of buttons on the Browse page and as a page of their own (/collections/<slug>,
-- /fr/collections/<slug>).
--
-- curated_collections: the collection itself, in English and French, plus the prompt the AI helper uses to suggest
--   books for it (admin only: /admin/collections). A collection is shown to customers only when published = true,
--   and the 19 seeded here are ALL unpublished: an admin reviews and publishes each one.
-- curated_collection_books: the books of a collection and what the admin decided about each. The AI only ever
--   writes status 'suggested'. Customers see only 'approved' books that are in stock at that moment (read live,
--   never copied), so a sold book silently leaves the page.
-- icon_path: the round picture on the Browse button: a seeded file under assets/img/collections (made by
--   scripts/crop-collection-art.js) or an image an admin uploaded (/img/<hash>.png, lib/imageStore.js); NULL gives a plain
--   text button. banner_path: an optional wide picture at the top of the collection page (an uploaded /img/<hash>.jpg),
--   with its English and French alternative text (empty = purely decorative).

CREATE TABLE IF NOT EXISTS curated_collections (
  id                SERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title_en          TEXT NOT NULL,
  description_en    TEXT NOT NULL DEFAULT '',
  title_fr          TEXT NOT NULL DEFAULT '',
  description_fr    TEXT NOT NULL DEFAULT '',
  curation_prompt   TEXT NOT NULL DEFAULT '',
  icon_path         TEXT,
  banner_path       TEXT,
  header_alt_en     TEXT NOT NULL DEFAULT '',
  header_alt_fr     TEXT NOT NULL DEFAULT '',
  sort_order        INTEGER NOT NULL DEFAULT 0,
  published         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_generated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS curated_collection_books (
  collection_id INTEGER NOT NULL REFERENCES curated_collections(id) ON DELETE CASCADE,
  book_id       INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'rejected')),
  reason        TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, book_id)
);

CREATE INDEX IF NOT EXISTS idx_curated_collection_books_book ON curated_collection_books(book_id);
CREATE INDEX IF NOT EXISTS idx_curated_collection_books_status ON curated_collection_books(collection_id, status);

INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt, icon_path, sort_order, published) VALUES
  ($q$love-in-a-foreign-language$q$, $q$Love, in a Foreign Language$q$, $q$Falling in love far from home, crossing cultural boundaries, and discovering that sometimes the greatest adventure is another person.$q$,
   $q$L’amour dans une langue étrangère$q$, $q$Tomber amoureux loin de chez soi, franchir les frontières culturelles, et découvrir que parfois la plus belle des aventures est une autre personne.$q$,
   $q$Select novels and memoirs where love unfolds across countries, cultures, languages, or unfamiliar places. Prioritise emotional depth, a strong sense of place, and relationships shaped by cultural difference.$q$,
   '/assets/img/collections/love-in-a-foreign-language.png', 10, FALSE),
  ($q$women-who-refuse-to-behave$q$, $q$Women Who Refuse to Behave$q$, $q$Unruly heroines, inconvenient ambitions, and women who choose to write their own rules.$q$,
   $q$Des femmes qui refusent d’être sages$q$, $q$Des héroïnes indociles, des ambitions dérangeantes et des femmes qui choisissent d’écrire leurs propres règles.$q$,
   $q$Choose fiction and biography featuring complex women who challenge social expectations. Include different eras and perspectives, and distinguish genuine agency from stories that simply punish unconventional women.$q$,
   '/assets/img/collections/women-who-refuse-to-behave.png', 20, FALSE),
  ($q$the-art-of-a-smaller-life$q$, $q$The Art of a Smaller Life$q$, $q$A garden, a long lunch, a familiar village, and the quiet possibility that a good life need not be a grand one.$q$,
   $q$L’art d’une vie à taille humaine$q$, $q$Un jardin, un long déjeuner, un village familier, et la douce idée qu’une belle vie n’a pas besoin d’être grandiose.$q$,
   $q$Curate reflective fiction, memoirs, and nature writing about slower living, everyday rituals, contentment, and meaningful community. Avoid simplistic lifestyle manuals.$q$,
   '/assets/img/collections/the-art-of-a-smaller-life.png', 30, FALSE),
  ($q$paris-is-always-a-good-idea$q$, $q$Paris Is Always a Good Idea$q$, $q$A city of possibility, tiny cafés, artistic ambitions, unexpected encounters, and lives reinvented over coffee.$q$,
   $q$Paris est toujours une bonne idée$q$, $q$Une ville pleine de possibles, de petits cafés, d’ambitions artistiques, de rencontres inattendues et de vies réinventées autour d’un café.$q$,
   $q$Select fiction, memoirs, and travel writing with a meaningful Paris setting. Include varied experiences of the city rather than relying exclusively on romantic clichés.$q$,
   '/assets/img/collections/paris-is-always-a-good-idea.png', 40, FALSE),
  ($q$the-magic-we-never-outgrew$q$, $q$The Magic We Never Outgrew$q$, $q$Wizards, goblins, enchanted forests, and the great fantasy classics that remind us that wonder never goes out of style.$q$,
   $q$La magie que l’on n’a jamais quittée$q$, $q$Des sorciers, des gobelins, des forêts enchantées et les grands classiques de la fantasy, qui nous rappellent que l’émerveillement ne se démode jamais.$q$,
   $q$Choose great fantasy classics and enduring favourites: sorcery, goblins and other creatures, quests, and imagined worlds. Prioritise lasting literary and imaginative merit, from epic sagas to gentle fairy tales, across different eras and for children, young adults and grown-ups. Avoid forgettable, formulaic series filler.$q$,
   '/assets/img/collections/the-magic-we-never-outgrew.png', 50, FALSE),
  ($q$a-little-bit-of-emotional-damage$q$, $q$A Little Bit of Emotional Damage$q$, $q$For readers who want a beautiful book, a broken heart, and absolutely no emotional recovery plan.$q$,
   $q$Un petit peu de dégâts émotionnels$q$, $q$Pour les lecteurs qui veulent un beau livre, un cœur brisé et absolument aucun plan de rétablissement émotionnel.$q$,
   $q$Select powerful, emotionally challenging novels about grief, loss, love, sacrifice, or regret. Require literary merit and emotional substance; avoid equating sadness with quality.$q$,
   '/assets/img/collections/a-little-bit-of-emotional-damage.png', 60, FALSE),
  ($q$the-art-of-getting-lost$q$, $q$The Art of Getting Lost$q$, $q$Sometimes the wrong turn is the beginning of the right story.$q$,
   $q$L’art de se perdre$q$, $q$Parfois, le mauvais virage est le début de la bonne histoire.$q$,
   $q$Select travel writing, adventure memoirs, and fiction about unexpected journeys, uncertainty, and personal transformation. Include literal and metaphorical journeys.$q$,
   '/assets/img/collections/the-art-of-getting-lost.png', 70, FALSE),
  ($q$books-that-make-you-insufferable-at-dinner$q$, $q$Books That Make You Insufferable at Dinner$q$, $q$Ideas so fascinating, arguments so provocative, and facts so extraordinary that you simply cannot keep them to yourself.$q$,
   $q$Des livres qui vous rendent insupportable au dîner$q$, $q$Des idées si fascinantes, des arguments si provocants et des faits si extraordinaires que vous ne pourrez tout simplement pas les garder pour vous.$q$,
   $q$Select accessible philosophy, psychology, cultural criticism, and social science that challenges assumptions or inspires debate. Prioritise credible authors and clear, engaging arguments.$q$,
   '/assets/img/collections/books-that-make-you-insufferable-at-dinner.png', 80, FALSE),
  ($q$the-world-is-stranger-than-fiction$q$, $q$The World Is Stranger Than Fiction$q$, $q$True stories so astonishing that you would reject them as unbelievable if someone invented them.$q$,
   $q$La réalité dépasse la fiction$q$, $q$Des histoires vraies si étonnantes que vous les jugeriez invraisemblables si quelqu’un les avait inventées.$q$,
   $q$Find well-researched popular science, history, investigative nonfiction, and extraordinary true stories. Verify factual credibility and favour surprising but substantiated accounts.$q$,
   '/assets/img/collections/the-world-is-stranger-than-fiction.png', 90, FALSE),
  ($q$for-the-chronically-curious$q$, $q$For the Chronically Curious$q$, $q$For those who follow one question down a rabbit hole and emerge three hours later with twelve new obsessions.$q$,
   $q$Pour les éternels curieux$q$, $q$Pour ceux qui suivent une question jusqu’au terrier du lapin et en ressortent trois heures plus tard avec douze nouvelles passions.$q$,
   $q$Select engaging nonfiction across science, history, nature, culture, and technology. Choose books that reward curiosity and explain complex subjects accessibly.$q$,
   '/assets/img/collections/for-the-chronically-curious.png', 100, FALSE),
  ($q$historys-most-interesting-bad-decisions$q$, $q$History's Most Interesting Bad Decisions$q$, $q$Disastrous plans, eccentric rulers, doomed expeditions, and the small decisions that produced spectacular consequences.$q$,
   $q$Les mauvaises décisions les plus fascinantes de l’Histoire$q$, $q$Des plans désastreux, des souverains excentriques, des expéditions vouées à l’échec et ces petites décisions aux conséquences spectaculaires.$q$,
   $q$Select credible historical narratives and biographies centred on failed decisions, unintended consequences, political miscalculations, or ambitious disasters. Prefer engaging storytelling grounded in evidence.$q$,
   '/assets/img/collections/historys-most-interesting-bad-decisions.png', 110, FALSE),
  ($q$the-books-that-raised-us$q$, $q$The Books That Raised Us$q$, $q$The childhood favourites we remember, the stories that shaped our imaginations, and the books we cannot wait to share.$q$,
   $q$Les livres qui nous ont fait grandir$q$, $q$Les favoris de notre enfance, les histoires qui ont façonné notre imaginaire et les livres que nous avons hâte de faire découvrir.$q$,
   $q$Select enduring children's classics and culturally influential books across generations. Consider nostalgia, literary quality, accessibility, and opportunities for shared family reading.$q$,
   '/assets/img/collections/the-books-that-raised-us.png', 120, FALSE),
  ($q$bedtime-stories-for-little-daydreamers$q$, $q$Bedtime Stories for Little Daydreamers$q$, $q$Gentle adventures, dreamy illustrations, and stories that make the transition from a busy day to a peaceful night feel magical.$q$,
   $q$Histoires du soir pour petits rêveurs$q$, $q$Des aventures tout en douceur, des illustrations rêveuses et des histoires qui font du passage d’une journée bien remplie à une nuit paisible un moment magique.$q$,
   $q$Choose soothing picture books, gentle poetry, and bedtime stories with calming pacing, reassuring themes, and age-appropriate language. Avoid overstimulating plots.$q$,
   '/assets/img/collections/bedtime-stories-for-little-daydreamers.png', 130, FALSE),
  ($q$main-character-energy$q$, $q$Main Character Energy$q$, $q$For the days when life needs a little more drama, a better soundtrack, and the confidence to take up space.$q$,
   $q$Une énergie de personnage principal$q$, $q$Pour les jours où la vie réclame un peu plus de drame, une meilleure bande-son et la confiance nécessaire pour prendre sa place.$q$,
   $q$Choose fiction with memorable protagonists, transformative journeys, bold decisions, and a strong sense of personal agency. Include diverse personalities and genres.$q$,
   '/assets/img/collections/main-character-energy.png', 140, FALSE),
  ($q$red-flags-but-make-them-fictional$q$, $q$Red Flags, but Make Them Fictional$q$, $q$Terrible decisions, irresistible villains, toxic romances, and characters we love precisely because we would never invite them into our real lives.$q$,
   $q$Des drapeaux rouges, mais de fiction$q$, $q$Des décisions désastreuses, des méchants irrésistibles, des amours toxiques et des personnages que l’on adore précisément parce qu’on ne les inviterait jamais dans notre vraie vie.$q$,
   $q$Choose fiction featuring morally dubious characters, destructive relationships, or charismatic antagonists. Preserve the entertainment value without presenting harmful relationship dynamics as healthy ideals.$q$,
   '/assets/img/collections/red-flags-but-make-them-fictional.png', 150, FALSE),
  ($q$i-read-it-before-it-was-a-film$q$, $q$I Read It Before It Was a Film$q$, $q$The original stories behind famous adaptations—and the books that make everyone argue about which version got it right.$q$,
   $q$Je l’ai lu avant le film$q$, $q$Les histoires originales derrière les adaptations célèbres, et les livres qui font débattre tout le monde pour savoir quelle version est la meilleure.$q$,
   $q$Identify books adapted for film or television, including classics and contemporary titles. Verify adaptation details, select genuinely engaging books, and avoid revealing key plot twists.$q$,
   '/assets/img/collections/i-read-it-before-it-was-a-film.png', 160, FALSE),
  ($q$a-field-guide-to-being-human$q$, $q$A Field Guide to Being Human$q$, $q$Coming-of-age classics about growing up, getting it wrong, and slowly working out who we are.$q$,
   $q$Petit guide pour être humain$q$, $q$Des classiques du passage à l’âge adulte : grandir, se tromper et découvrir peu à peu qui l’on est.$q$,
   $q$Curate coming-of-age classics: novels and memoirs about adolescence, first love, loss of innocence, identity, and the passage into adulthood. Favour enduring, widely loved titles across eras and cultures, and include voices beyond a single background.$q$,
   '/assets/img/collections/a-field-guide-to-being-human.png', 170, FALSE),
  ($q$the-literary-apothecary$q$, $q$The Literary Apothecary$q$, $q$A book for every affliction of the human condition: a broken heart, a restless mind, a life in transition, or the simple need to believe again.$q$,
   $q$L’apothicaire littéraire$q$, $q$Un livre pour chaque tourment de la condition humaine : un cœur brisé, un esprit agité, une vie en transition, ou simplement l’envie de croire à nouveau.$q$,
   $q$Match books to specific emotional reading needs, such as comfort, courage, wonder, heartbreak, or renewal. Include fiction and nonfiction, explain why each book fits, and avoid presenting books as medical treatment.$q$,
   '/assets/img/collections/the-literary-apothecary.png', 180, FALSE),
  ($q$the-armchair-passport$q$, $q$The Armchair Passport$q$, $q$Travel the world through stories, crossing borders and cultures without ever leaving your favourite reading chair.$q$,
   $q$Le passeport du fauteuil$q$, $q$Voyagez à travers le monde grâce aux histoires, franchissez les frontières et les cultures sans jamais quitter votre fauteuil de lecture préféré.$q$,
   $q$Build place-based collections combining novels, memoirs, travel writing, food, and history. Verify the setting and cultural context; aim for a range of voices rather than a single romanticised perspective.$q$,
   '/assets/img/collections/the-armchair-passport.png', 190, FALSE)
ON CONFLICT (slug) DO NOTHING;
