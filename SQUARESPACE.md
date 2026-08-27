# umasbooks.org — the Squarespace Code Block

**Status: live.** The whole site is one **Code Block** on the Home page of the
Squarespace site (`bullfrog-watermelon-zrtr.squarespace.com`, custom domain
`umasbooks.org`). Block id `block-yui_3_17_2_1_1787578335295_4914`, in a Fluid
Engine section.

Last update (2026-08-27) put in the current build: tightened header spacing, the
**EN | FR** toggle + full French translation, page pulled to the top of the
section, block widened to full width.

## What's in the block

`squarespace-paste-payload.html` in this repo is the exact content of the block,
in three parts:

1. **Fluid-Engine fix** — `<style>` that forces this block to `grid-column: 1 / -1`
   and `grid-row-start: 1` (top-left, full width), zeroes `.content-wrapper`
   padding-top, and clears the section `min-height`. This is what removes the big
   empty band that used to sit above the design.
2. **Page takeover** — `<style>` that hides the Squarespace site header
   (`#header { display: none }`) and paints `body` / `.section-background` the
   paper colour so nothing shows through.
3. **The site itself** — `squarespace-code-block.filled.html`: the design with all
   CSS scoped under `.umas-site`, the logo pointing at the uploaded
   `logo_final.png` on the Squarespace CDN, and the i18n `<script>`.

## Updating it later

1. Edit `index.html` (English copy) **and** the matching `fr:` entry in its inline
   script.
2. Regenerate:
   ```bash
   python3 tools/build-squarespace.py      # -> squarespace-code-block[.filled].html
   ```
   then rebuild `squarespace-paste-payload.html` (prepend the two `<style>` blocks
   above — the fluid-fix `grid-*` selector is tied to that block id, keep it).
3. In Squarespace: Home page → **Edit** → click the Code Block → pencil (`< >`) →
   select all, paste the new payload → **Apply** → **Save**.
4. The **EN | FR** toggle looks dead inside the Squarespace editor (scripts are
   disabled there) — check the **live** page in a normal browser tab.

## Notes

- Fonts load via one `@import` at the top of the design's `<style>`.
- The in-page header is **not** sticky (avoids clashing with Squarespace). To make
  it sticky, change `position: static` back to `position: sticky; top: 0;
  z-index: 10;` in `.umas-site header.site` inside the block.
- If the logo URL ever changes, update `LIVE_LOGO_URL` in
  `tools/build-squarespace.py` and rebuild.
- The fluid-fix selector names the block id. If the block is ever deleted and
  re-added, grab the new `fe-block-...` id from the live page and update it.
