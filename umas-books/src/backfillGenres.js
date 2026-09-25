require("dotenv").config();
const { pool } = require("./db");
const { generateBookGenres } = require("./lib/bookGenre");

// Repopulates the genre (books.categories) of every book in inventory
// using AI — run once with `npm run backfill-genres`. Unlike a normal
// migration this isn't idempotent-by-default (it overwrites whatever
// genre is on file, including ones already set), which is the point:
// most existing inventory predates the AI-assisted ISBN lookup ever
// picking a genre at all, and current tags are inconsistent free text.
// Safe to re-run — it just re-generates every time.

const DELAY_MS = 300; // gentle pacing between API calls, not required by rate limits but polite

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { rows: books } = await pool.query(
    "SELECT id, title, authors, description, categories FROM books ORDER BY id ASC"
  );
  console.log(`Backfilling genres for ${books.length} books...`);

  let updated = 0;
  let skipped = 0;

  for (const book of books) {
    const genres = await generateBookGenres({
      title: book.title,
      author: book.authors,
      description: book.description,
      existingGenres: book.categories,
    });

    if (!genres) {
      console.warn(`  [skip] #${book.id} "${book.title}" — no genre returned`);
      skipped++;
    } else {
      await pool.query("UPDATE books SET categories = $1, updated_at = now() WHERE id = $2", [genres, book.id]);
      console.log(`  [ok]   #${book.id} "${book.title}" -> ${genres}`);
      updated++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`Done. Updated ${updated}, skipped ${skipped}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
