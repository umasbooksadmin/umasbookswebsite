#!/usr/bin/env node
// Cuts the maintainer's artwork sheet (assets-src/collections-sheet.webp: 19 circular illustrations on a
// light background, with English captions printed under them) into one square, transparent-cornered image per
// collection, WITHOUT the printed caption (the captions are real HTML text so they work in English and French).
//
//   node scripts/crop-collection-art.js            writes assets/img/collections/<slug>.webp and .png (204 px)
//   node scripts/crop-collection-art.js --check    only checks that 19 circles are found (exit 1 otherwise)
//
// Circles are found as the big connected blobs of non-background pixels (a printed letter is a small blob, so
// captions are ignored), sorted into reading order, and matched to SLUGS below (the order of the sheet is the
// order of the collections in migrations/091_curated_collections.sql). Each blob's bounding box is cropped, then a
// circular alpha mask a pixel inside the edge removes the pale outline and any neighbouring colour.
// The outputs are committed; this script only needs to be run again if the sheet changes.

const path = require("node:path");
const fs = require("node:fs");
const sharp = require("sharp");

const SLUGS = require("../src/lib/collectionSlugs");

const SHEET = path.join(__dirname, "..", "..", "assets-src", "collections-sheet.webp");
const OUT = path.join(__dirname, "..", "..", "assets", "img", "collections");
const MIN_BLOB = 12000; // pixels: a circle is ~30,000; a letter a few hundred, a caption line far less than this
const BG_DISTANCE = 28; // colour distance from the background that counts as "ink"

async function findCircles() {
  const { data, info } = await sharp(SHEET).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const px = (i) => [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
  const bg = px(0);
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = px(i);
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > BG_DISTANCE) ink[i] = 1;
  }
  // Connected components (4-neighbour, iterative flood fill).
  const seen = new Uint8Array(W * H);
  const blobs = [];
  const stack = [];
  for (let start = 0; start < W * H; start++) {
    if (!ink[start] || seen[start]) continue;
    let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p - x) / W;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && ink[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && ink[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
      if (y < H - 1 && ink[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
    }
    if (count >= MIN_BLOB) blobs.push({ minX, minY, maxX, maxY, count });
  }
  // Reading order: rows (by centre y, 80 px tolerance), then left to right.
  blobs.sort((a, b) => {
    const ay = (a.minY + a.maxY) / 2, by = (b.minY + b.maxY) / 2;
    return Math.abs(ay - by) > 80 ? ay - by : a.minX - b.minX;
  });
  if (process.env.DEBUG_BLOBS) console.log(blobs.map((b) => [b.minX, b.minY, b.maxX - b.minX + 1, b.maxY - b.minY + 1].join(",")).join("\n"));
  return blobs;
}

async function main() {
  const blobs = await findCircles();
  if (blobs.length !== SLUGS.length) {
    console.error(`Found ${blobs.length} circles, expected ${SLUGS.length}.`);
    process.exit(1);
  }
  if (process.argv.includes("--check")) { console.log(`OK: ${blobs.length} circles`); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const SIZE = 204; // shown at about 100 px: 2x for a sharp phone screen
  // The circles on the sheet are very slightly oval (the first row is about 205 x 192 px), so each one is cut out
  // at its own width and height and scaled to a true square (at most 7% taller): a perfect circle, none of its
  // art cut off. The last circle is pale (its edge fades into the page, so no threshold finds all of it) and
  // its caption touches it: it is cut by hand (position read from the sheet), a little short of its bottom edge.
  for (let i = 0; i < blobs.length; i++) {
    let { minX: left, minY: top, maxX, maxY } = blobs[i];
    let width = maxX - left + 1, height = maxY - top + 1;
    if (i === blobs.length - 1) { left = 677; top = 797; width = 182; height = 170; } // stops just above "The Armchair"
    const square = await sharp(SHEET).extract({ left, top, width, height }).ensureAlpha()
      .resize(SIZE, SIZE, { fit: "fill", kernel: "lanczos3" }).toBuffer();
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 1.5}" fill="#fff"/></svg>`);
    const circle = await sharp(square).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
    await sharp(circle).webp({ quality: 88, alphaQuality: 100 }).toFile(path.join(OUT, `${SLUGS[i]}.webp`));
    await sharp(circle).png({ compressionLevel: 9, palette: false }).toFile(path.join(OUT, `${SLUGS[i]}.png`));
  }
  console.log(`Wrote ${blobs.length} circles to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
