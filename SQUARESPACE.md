# Putting this page on umasbooks.org (Squarespace)

Squarespace has no API to push a page in, so this is a copy‑paste job. It takes
about 10 minutes. The design goes in as **one Code Block**.

## What you need first

**A Business plan or higher.** Code Blocks need Business, Commerce, or the old
Business/Advanced tiers. To check: *Home menu → Billing & Account → Billing*, or
just try adding a Code Block (step 3) — if it's greyed out or shows an upgrade
prompt, you're on Personal and this route won't work (tell me and I'll rebuild
it with native Squarespace sections instead).

## Steps

### 1. Upload the logo

1. *Home menu → Pages*, or anywhere you can add an **Image** block, upload
   `logo.png` (in this folder).
2. Easiest reliable way to get a permanent URL: add a temporary Image block on
   any page with `logo.png`, save, then right‑click the image on the live site →
   *Copy image address*. It looks like
   `https://images.squarespace-cdn.com/content/v1/.../logo.png`.
3. Keep that URL handy. You can delete the temporary Image block afterward.

### 2. Prepare the code

1. Open `squarespace-code-block.html` (in this folder) in a text editor.
2. Find **`LOGO_URL`** — it appears **twice** — and replace both with the URL
   from step 1.
3. Select all, copy.

### 3. Paste into the page

1. Go to the page whose content you're replacing. **Edit**.
2. Delete the existing blocks/sections on that page (or add a new blank section
   at the top and delete the rest once you're happy).
3. Add a **Code** block. In its editor, clear the default contents and paste.
   Leave the mode on **HTML** (not Markdown). Do **not** tick "Display Source".
4. Save. Scripts don't run inside the Squarespace editor preview, so the
   **EN | FR** toggle will look inert there — that's expected. **View the live
   page** in a normal browser tab to test it.

### 4. Check the live page

- EN | FR toggle (top right of the block) switches every bit of text and
  remembers the choice.
- Layout holds on a phone.
- The logo shows in the header and the hero.

## Notes / tweaks

- **Fonts** (Playfair Display, EB Garamond) load via `@import` at the top of the
  block's `<style>`. If your Squarespace theme's CSS is aggressive you *may* get
  a flash of a fallback serif first — harmless. If you'd rather, move that one
  `@import ...;` line into *Website → Website Tools → Code Injection → Header*
  wrapped in `<style> ... </style>` and delete it from the block.
- **Not sticky.** The in‑page header (with the toggle) scrolls away, so it never
  fights your Squarespace site header. To make it stick instead, find
  `position: static;` inside `.umas-site header.site { ... }` in the block and
  change it back to `position: sticky; top: 0; z-index: 10;`.
- **All styles are scoped** under `.umas-site`, so nothing leaks into the rest of
  your Squarespace theme, and the block picks up dark mode from the visitor's
  browser setting on its own.
- **To change wording later:** edit `index.html` (the English default) **and**
  the matching `fr:` entry in its inline script, then regenerate the block:

  ```bash
  python3 tools/build-squarespace.py
  ```

  Re‑do the `LOGO_URL` replacement and re‑paste the Code Block.
