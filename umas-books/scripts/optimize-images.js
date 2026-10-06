#!/usr/bin/env node
// One-off image optimiser: `node scripts/optimize-images.js` (from umas-books/).
//
// The full-size originals live in <repo>/assets-src/ (NOT served: only assets/
// and /logo.png are). This script writes the right-sized files the site
// serves:
//   - a palette-quantised PNG with the SAME file name the pages already use
//     (fallback, and what the legacy pages that cannot use <picture> load), and
//   - a WebP next to it (same name, .webp) for <picture> / modern browsers.
// Re-run it after replacing an original; commit the outputs. The image-size
// test (test/unit/imageSizes.test.js) fails if any served image tops 150 KB.

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const repo = path.join(__dirname, "..", "..");
const src = (f) => path.join(repo, "assets-src", f);
const img = (f) => path.join(repo, "assets", "img", f);

// name: output width (null = keep), webp (also write a .webp), out (path override)
const JOBS = [
  // The header logo is shown at 120-220 CSS px: 440 px covers 2x screens.
  { name: "logo-wordmark-framed.png", width: 440, webp: true },
  { name: "hero-left.png", webp: true },
  { name: "hero-right.png", webp: true },
  { name: "medallion-browse.png", webp: true },
  { name: "medallion-donate.png", webp: true },
  { name: "medallion-eveil.png", webp: true },
  { name: "medallion-events.png", webp: true },
  { name: "sprig.png", webp: true },
  { name: "book-stack.png", webp: true },
  // The social-sharing image (og:image, JSON-LD) stays 1280x720.
  { name: "logo-stamp-1280x720.png", colours: 128 },
  // The root /logo.png (used outside the site): 900x900 -> 600x600.
  { name: "logo.png", width: 600, out: path.join(repo, "logo.png"), colours: 256 },
];

(async () => {
  for (const job of JOBS) {
    let pipeline = sharp(src(job.name));
    if (job.width) pipeline = pipeline.resize({ width: job.width, withoutEnlargement: true });
    const buf = await pipeline.png({ palette: true, colours: job.colours || 256, effort: 10, dither: 0.6 }).toBuffer();
    const out = job.out || img(job.name);
    fs.writeFileSync(out, buf);
    const sizes = [`png ${Math.round(buf.length / 1024)} KB`];
    if (job.webp) {
      let w = sharp(src(job.name));
      if (job.width) w = w.resize({ width: job.width, withoutEnlargement: true });
      const wb = await w.webp({ quality: 82, alphaQuality: 90, effort: 6 }).toBuffer();
      fs.writeFileSync(out.replace(/\.png$/, ".webp"), wb);
      sizes.push(`webp ${Math.round(wb.length / 1024)} KB`);
    }
    console.log(path.relative(repo, out).padEnd(44), sizes.join("  "));
  }
})().catch((e) => { console.error(e); process.exit(1); });
