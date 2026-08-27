# Updating the page on umasbooks.org (Squarespace)

The design is **already live** on umasbooks.org — a previous version was pasted
into a single **Code Block** on the one page. What's there now is the older
build: no EN | FR toggle, the cramped header, and the block is squeezed into a
narrow column (~416 px) inside a Fluid Engine section, which is why it looks
boxed-in on the live site.

This updates that block to the current version (EN | FR toggle, tightened
spacing, French translation) **and** widens it.

## 1. Replace the Code Block's contents

1. Edit the page. Click the existing **Code Block** → **Edit** (the `< >` pencil).
2. Select all inside it, delete.
3. Open **`squarespace-code-block.filled.html`** (in this folder), copy the whole
   file, paste it in. It already points at your uploaded `logo_final.png`, so
   there's nothing to find-and-replace.
   Mode stays **HTML**; leave "Display Source" unticked.
4. Apply / Save.

> `squarespace-code-block.html` is the same thing but with a `LOGO_URL`
> placeholder instead — use that one only if the logo URL ever changes.

## 2. Widen the block (this is what fixes the boxed-in look)

The design centers itself at 760 px, but only if the block is allowed to be that
wide. In the **Fluid Engine** editor:

1. Click the Code Block once to select it (don't open the editor).
2. Drag its side handles so it spans the **full width of the section** — edge to
   edge of the row.
3. Drag the bottom handle down to give it plenty of height so it doesn't scroll
   inside its own little box.
4. If the section itself is narrow, open **Edit Section → Section width** and set
   it to **Full width**.

## 3. Check the live page

Open umasbooks.org in a normal browser tab (not the editor — scripts don't run
in the editor preview, so the toggle looks dead there).

- **EN | FR** toggle, top right — switches every line of text, remembers the choice.
- No big empty band at the top; header fits on one row (EN).
- Phone layout holds.
- Logo shows in both the header and the hero.

## Notes

- **Not sticky anymore.** The in-page header (with the toggle) now scrolls away
  instead of sticking — one less thing to clash with the Squarespace site
  chrome. To restore sticky: in the block, find `position: static;` inside
  `.umas-site header.site { … }` and change it to
  `position: sticky; top: 0; z-index: 10;`.
- **Styles are scoped** under `.umas-site` now (the old paste wasn't), so the
  block can't affect the rest of the Squarespace theme. Dark mode follows the
  visitor's browser setting automatically.
- **Fonts** load via one `@import` at the top of the block's `<style>`. A brief
  fallback-serif flash on first load is possible and harmless; to avoid it, move
  that line into *Website → Website Tools → Code Injection → Header* wrapped in
  `<style> … </style>`.
- **Changing wording later:** edit `index.html` (English) **and** the matching
  `fr:` entry in its inline script, then regenerate:

  ```bash
  python3 tools/build-squarespace.py
  ```

  Then rebuild the filled copy (swap `LOGO_URL` for the logo URL) and re-paste.
