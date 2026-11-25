-- The shop and the association's registered office are now 9 rue de l’Hôtel de Ville, 81000 Albi (statutes changed
-- by the extraordinary general meeting of 10 December 2026, effective 1 January 2027). The "Welcome" blog post, written
-- when the shop was in Rue Peyrolière, says where to say hello: update that one sentence in both languages.
-- Only the words are replaced, so a post the association has edited keeps its own text; running it twice changes nothing.
UPDATE blog_posts
   SET body = replace(body, 'Come and say hello on Rue Peyrolière.', 'Come and say hello at 9 rue de l’Hôtel de Ville.'),
       body_fr = replace(body_fr, 'Venez nous dire bonjour rue Peyrolière.', 'Venez nous dire bonjour au 9 rue de l’Hôtel de Ville.')
 WHERE body LIKE '%Rue Peyrolière%' OR body_fr LIKE '%rue Peyrolière%';
