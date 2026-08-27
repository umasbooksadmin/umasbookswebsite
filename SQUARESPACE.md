# Putting this page on umasbooks.org (Squarespace)

Squarespace has no API to push a page in, so this is a copy‑paste job. It takes
about 10 minutes. The design goes in as **one Code Block**.

## What you need first

**A Business plan or higher.** Code Blocks need Business, Commerce, or the old
Business/Advanced tiers. To check: *Home menu → Billing & Account → Billing*, or
just try adding a Code Block (step 3) — if it's greyed out or shows an upgrade
prompt, you're on Personal and this route won't work (tell me and I'll rebuild
it with native Squarespace sections instead).

The site is a single page, so you're replacing that one page's contents wholesale.

## Steps

### 1. Get a URL for the logo

1. On your one page, hit **Edit** and add a temporary **Image** block anywhere.
   Upload `logo.png` (in this folder). Save / publish.
2. Open the live page in a normal tab, right‑click the logo → *Copy image
   address*. It looks like
   `https://images.squarespace-cdn.com/content/v1/.../logo.png`.
3. Keep that URL. You'll delete this temporary Image block in step 3.

### 2. Prepare the code

1. Open `squarespace-code-block.html` (in this folder) in a text editor.
2. Find **`LOGO_URL`** — it appears **twice** — and replace both with the URL
   from step 1.
3. Select all, copy.

### 3. Put it on the page

1. **Edit** the page again.
2. Delete every existing block/section — including the temporary Image block
   from step 1 — so the page is empty.
3. Add one **Code** block. Clear its default contents, paste. Leave the mode on
   **HTML** (not Markdown). Do **not** tick "Display Source".
4. Save. Scripts don't run in the Squarespace editor preview, so the
   **EN | FR** toggle will look inert there — that's expected. **Open the live
   page** in a normal browser tab to test it.

If the page has a title/announcement area from the theme you can't delete, that's
fine — the block sits below it and still looks right (the in‑page header isn't
sticky, so there's no clash).

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
