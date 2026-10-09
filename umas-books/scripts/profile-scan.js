#!/usr/bin/env node
// Developer tool: times the Add-a-book path (GET /admin/inventory/lookup, then
// POST /admin/inventory the way public/scan-intake.js does it) against the REAL
// Open Library, in a throwaway database, and prints per-step timings read from the
// Server-Timing header (lib/timing.js).
//
//   DATABASE_URL=postgres://localhost:5432/some_scratch_db PGSSLMODE=disable \
//     node scripts/profile-scan.js [--rounds 2] [--sim-ai] [isbn ...]
//
//   --sim-ai   answer the Anthropic calls locally after a realistic delay (about 1.5 s for a
//              description, 1.0 s for its translation) instead of skipping them (no API key here).
//
// It writes books into the database it is pointed at: never aim it at a real one.
// Needs the test helpers (test/helpers), so it only runs from a full checkout.

const express = require("express");
const multer = require("multer");
const { buildApp, listen } = require("../test/helpers/inProcessApp");

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const rounds = Number((args[args.indexOf("--rounds") + 1]) || 1) || 1;
const isbns = args.filter((a) => /^\d{9}[\dX]$|^\d{13}$/.test(a));
const ISBNS = isbns.length ? isbns : [
  "9780142437230", "9780141439518", "9780061120084", "9780547928227", "9781400033416",
  "9780156027328", "9780679731726", "9780385490818", "9780451524935", "9780743273565",
];

if (flag("--sim-ai")) {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sim";
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.anthropic.com/")) {
      const prompt = JSON.parse(init.body).messages[0].content;
      await new Promise((r) => setTimeout(r, prompt.startsWith("Translate") ? 1000 : 1500));
      return new Response(JSON.stringify({ content: [{ text: "Une description simulee." }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
}

const parseTiming = (h) => Object.fromEntries(String(h || "").split(",").map((p) => p.trim().split(";dur=")).filter((p) => p.length === 2).map(([k, v]) => [k, Number(v)]));
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null; };

async function main() {
  const { pool } = require("../src/db");
  const { requireAdmin } = require("../src/middleware/auth");
  const upload = multer({ storage: multer.memoryStorage() });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  const server = await listen(buildApp([gate, require("../src/routes/admin/inventoryLookup"), require("../src/routes/admin/inventory")]));
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Profile Admin', true) RETURNING id", [`profile-${Date.now()}@example.test`]);
  const h = { "x-test-user": JSON.stringify({ id: rows[0].id, email: "p@example.test", displayName: "P", isAdmin: true }) };

  const samples = { lookup: [], save: [] };
  const perStep = { lookup: {}, save: {} };
  const note = (kind, ms, header) => {
    samples[kind].push(ms);
    for (const [k, v] of Object.entries(parseTiming(header))) (perStep[kind][k] = perStep[kind][k] || []).push(v);
  };

  for (let round = 1; round <= rounds; round++) {
    for (const isbn of ISBNS) {
      let t0 = performance.now();
      const res = await fetch(`${server.base}/admin/inventory/lookup?isbn=${isbn}&binding=trade`, { headers: { ...h, accept: "application/json" } });
      const j = await res.json();
      const lookupMs = performance.now() - t0;
      note("lookup", lookupMs, res.headers.get("server-timing"));
      const b = j.book || {};
      const form = new URLSearchParams({
        isbn, title: b.title || `Unknown ${isbn}`, author: b.author || "", publisher: b.publisher || "", publishedYear: b.publishedYear || "",
        description: b.description || "", coverUrl: b.coverUrl || "", genre: b.genre || "", genreFr: b.genreFr || "",
        binding: "trade", condition: "very_good", price: String(j.suggestion && j.suggestion.price != null ? j.suggestion.price : 5),
        location: "Store", source: "donation", fast: "1", acquisitionCost: "0",
      });
      t0 = performance.now();
      const sres = await fetch(`${server.base}/admin/inventory`, { method: "POST", headers: { ...h, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form });
      await sres.text();
      const saveMs = performance.now() - t0;
      note("save", saveMs, sres.headers.get("server-timing"));
      console.log(`round ${round} ${isbn} ${String(b.title || "(not found)").slice(0, 28).padEnd(28)} lookup ${lookupMs.toFixed(0).padStart(5)} ms [${res.headers.get("server-timing")}]  save ${saveMs.toFixed(0).padStart(5)} ms [${sres.headers.get("server-timing")}] status ${sres.status}`);
    }
  }

  console.log("\nstep                     n     p50      p95      max (ms)");
  for (const kind of ["lookup", "save"]) {
    for (const [name, arr] of [["total", samples[kind]], ...Object.entries(perStep[kind]).filter(([k]) => k !== "total")]) {
      console.log(`${(kind + "." + name).padEnd(22)} ${String(arr.length).padStart(4)} ${pct(arr, 50).toFixed(0).padStart(7)} ${pct(arr, 95).toFixed(0).padStart(8)} ${Math.max(...arr).toFixed(0).padStart(8)}`);
    }
  }
  await require("../src/lib/afterResponse").settled(); // the covers and texts filled in after each save
  const { rows: filled } = await pool.query("SELECT count(*) FILTER (WHERE cover_url IS NOT NULL)::int AS covers, count(*) FILTER (WHERE description IS NOT NULL)::int AS descriptions, count(*)::int AS books FROM books");
  console.log(`\nafter the background fill: ${filled[0].covers}/${filled[0].books} books have a cover, ${filled[0].descriptions}/${filled[0].books} a description`);
  await server.close();
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
