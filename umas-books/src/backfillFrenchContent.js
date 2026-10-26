require("dotenv").config({ quiet: true });
const { pool } = require("./db");
const { generateBookGenres } = require("./lib/bookGenre");
const { applyRulesToBook } = require("./lib/genreRules");
const { translateGenresToFrench } = require("./lib/bookLookup");
const { translateDescriptionToFrench } = require("./lib/bookDescription");

// Repopulates every book's genre (English, via AI) and French genre
// (a deterministic translation of whatever English genre came out of
// that — see translateGenresToFrench) plus a French translation of its
// existing description — run once with `npm run backfill-french-content`.
// This supersedes the old genres-only backfill; French genre/description
// generation didn't exist yet when that one shipped.
//
// Not idempotent by design, same as the old script: it overwrites
// categories/categories_fr/description_fr every run, since most existing
// inventory predates any of this and current tags are inconsistent free
// text. Safe to re-run.

const DELAY_MS = 300; // gentle pacing between API calls, not required by rate limits but polite

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { rows: books } = await pool.query(
    "SELECT id, title, authors, description, categories FROM books ORDER BY id ASC"
  );
  console.log(`Backfilling French genre + description for ${books.length} books...`);

  let genresUpdated = 0;
  let genresSkipped = 0;
  let descriptionsUpdated = 0;
  let descriptionsSkipped = 0;

  for (const book of books) {
    const guessed = await generateBookGenres({
      title: book.title,
      author: book.authors,
      description: book.description,
      existingGenres: book.categories,
    });
    // The genre rules of Admin > Genres apply to what the AI picked too (none saved: unchanged).
    const genresEn = guessed ? (await applyRulesToBook(pool, guessed, null)).genre : guessed;

    if (!genresEn) {
      console.warn(`  [genre skip] #${book.id} "${book.title}" — no genre returned`);
      genresSkipped++;
    } else {
      const genresFr = translateGenresToFrench(genresEn);
      await pool.query(
        "UPDATE books SET categories = $1, categories_fr = $2, updated_at = now() WHERE id = $3",
        [genresEn, genresFr, book.id]
      );
      console.log(`  [genre ok]   #${book.id} "${book.title}" -> ${genresEn} / ${genresFr}`);
      genresUpdated++;
    }

    if (!book.description) {
      console.warn(`  [desc skip]  #${book.id} "${book.title}" — no English description on file to translate`);
      descriptionsSkipped++;
    } else {
      const descriptionFr = await translateDescriptionToFrench(book.description);
      if (!descriptionFr) {
        console.warn(`  [desc skip]  #${book.id} "${book.title}" — translation failed`);
        descriptionsSkipped++;
      } else {
        await pool.query("UPDATE books SET description_fr = $1, updated_at = now() WHERE id = $2", [descriptionFr, book.id]);
        console.log(`  [desc ok]    #${book.id} "${book.title}"`);
        descriptionsUpdated++;
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(`Done. Genres: ${genresUpdated} updated, ${genresSkipped} skipped. Descriptions: ${descriptionsUpdated} updated, ${descriptionsSkipped} skipped.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
