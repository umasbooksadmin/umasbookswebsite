// Genres shown to customers: books have English genres only (Sharon, 2026-10-28). The French site shows the same
// English genre names (books have no French genre).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { genreLabel, genresLabel } = require("../../src/lib/genres");

test("genre labels are the English genres in both languages; a leftover French copy is never shown", () => {
  assert.equal(genreLabel("Mystery", "en"), "Mystery");
  assert.equal(genreLabel("Mystery", "fr"), "Mystery");
  assert.equal(genreLabel("Zymurgy", "fr"), "Zymurgy");
  assert.equal(genreLabel(null, "fr"), "");
  assert.equal(genresLabel("Mystery, Science Fiction", "en"), "Mystery, Science Fiction");
  assert.equal(genresLabel("Mystery, Science Fiction", "fr"), "Mystery, Science Fiction");
  assert.equal(genresLabel("Mystery, Science Fiction", "fr", "Policier, Science-fiction"), "Mystery, Science Fiction", "a stored French copy is ignored");
  assert.equal(genresLabel(null, "fr"), "");
  assert.equal(genresLabel(undefined), "");
});
