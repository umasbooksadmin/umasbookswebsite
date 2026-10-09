// Report "Book lookup sources used" (/admin/reports/lookup-sources): how often each ISBN catalog was asked, how
// often it supplied the title, and what it cost in time. Built from lookup_source_stats (counts per Paris day and
// source, written by lib/lookupStats.js). Counts only: no ISBN, title or person. English only (admin area).

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "all", label: "All time" },
];
const DEFAULT_PERIOD = "30d";

const SOURCE_LABELS = {
  openlibrary: "Open Library",
  bnf: "BnF (French National Library)",
  google: "Google Books",
  "openlibrary-data": "Open Library data API",
  isbndb: "ISBNdb (paid)",
  cache: "Answered from memory (cache)",
  none: "Not found: filled by hand",
};
const CATALOGS = ["openlibrary", "bnf", "google", "openlibrary-data", "isbndb"];
const ORDER = [...CATALOGS, "cache", "none"];

const SHOWN = ["asked", "won", "filled", "redundant", "empty", "errors", "limited", "cancelled"];
const COLUMN_LABELS = {
  asked: "Asked", won: "Supplied the title", filled: "Only filled missing fields", redundant: "Answered, nothing new",
  empty: "Found nothing", errors: "Errors / timeouts", limited: "Refused (429/401/403)", cancelled: "Cut short",
};

// -> { key, label, from, to } (Paris days; from/to null = no limit). Unknown values mean the default.
function parsePeriod(value, today) {
  const { addDays } = require("./reports");
  const key = PERIODS.some((p) => p.key === value) ? value : DEFAULT_PERIOD;
  const label = PERIODS.find((p) => p.key === key).label;
  switch (key) {
    case "today": return { key, label, from: today, to: today };
    case "7d": return { key, label, from: addDays(today, -6), to: today };
    case "month": return { key, label, from: `${today.slice(0, 7)}-01`, to: today };
    case "all": return { key, label, from: null, to: null };
    default: return { key, label, from: addDays(today, -29), to: today };
  }
}

const num = (v) => Number(v || 0);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);

function blank() {
  const o = { paid_calls: 0, ms_sum: 0, ms_n: 0 };
  for (const c of SHOWN) o[c] = 0;
  return o;
}
function addInto(target, r) {
  for (const c of [...SHOWN, "paid_calls", "ms_sum", "ms_n"]) target[c] += num(r[c]);
}
// One output row for a source: the catalogs get every column, "cache" and "none" only their count.
function shape(source, t, extra = {}) {
  const row = { ...extra, source: SOURCE_LABELS[source] || source };
  if (source === "cache" || source === "none") return { ...row, asked: t.asked };
  for (const c of SHOWN) row[c] = t[c];
  row.avg_ms = t.ms_n ? Math.round(t.ms_sum / t.ms_n) : null;
  return row;
}
const sortKey = (s) => { const i = ORDER.indexOf(s); return i < 0 ? ORDER.length : i; };

async function run(db, ctx) {
  const { SITE_TIME_ZONE } = require("./tz");
  try { await require("./lookupStats").getStats().flush(); } catch { /* what is in memory is simply not counted yet */ }
  const period = parsePeriod(ctx.query && ctx.query.period, ctx.today);

  const { rows } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, source, asked, won, filled, redundant, empty, errors, limited, cancelled, paid_calls, ms_sum::float8 AS ms_sum, ms_n
     FROM lookup_source_stats
     WHERE ($1::date IS NULL OR day >= $1::date) AND ($2::date IS NULL OR day <= $2::date)
     ORDER BY day, source`,
    [period.from, period.to]
  );
  const paid = await db.query(
    `SELECT COALESCE(SUM(paid_calls), 0)::int AS n FROM lookup_source_stats
     WHERE source = 'isbndb' AND day >= date_trunc('month', (now() AT TIME ZONE $1))::date`,
    [SITE_TIME_ZONE]
  );

  const bySource = new Map();
  const byMonth = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, blank());
    addInto(bySource.get(r.source), r);
    const mk = `${r.day.slice(0, 7)}|${r.source}`;
    if (!byMonth.has(mk)) byMonth.set(mk, blank());
    addInto(byMonth.get(mk), r);
  }
  const get = (s, c) => (bySource.get(s) ? bySource.get(s)[c] : 0);

  const sourceRows = ORDER.filter((s) => CATALOGS.includes(s) || bySource.has(s)).map((s) => shape(s, bySource.get(s) || blank()));
  const monthRows = [...byMonth.entries()].map(([k, t]) => { const [month, source] = k.split("|"); return { s: source, row: shape(source, t, { month }) }; })
    .sort((a, b) => (a.row.month < b.row.month ? -1 : a.row.month > b.row.month ? 1 : sortKey(a.s) - sortKey(b.s))).map((x) => x.row);
  let dayRows = rows.slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : sortKey(a.source) - sortKey(b.source)))
    .map((r) => shape(r.source, { ...blank(), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])) }, { day: r.day }));
  const dailyTotal = dayRows.length;
  const LIMIT = require("./reports").LIST_LIMIT;
  if (!ctx.csv && dayRows.length > LIMIT) dayRows = dayRows.slice(0, LIMIT);

  const lookups = get("lookup", "asked") + get("cache", "asked");
  const found = get("lookup", "won") + get("cache", "won");
  const overview = [
    { measure: "Period", value: period.label + (period.from ? ` (${period.from} to ${period.to})` : "") },
    { measure: "Lookups (ISBNs looked up)", value: String(lookups) },
    { measure: "Found with a title", value: lookups ? `${found} (${pct(found, lookups)}%)` : "–" },
    { measure: "Answered from memory (cache hits)", value: lookups ? `${get("cache", "asked")} (${pct(get("cache", "asked"), lookups)}%)` : "–" },
    { measure: "Not found: filled by hand", value: String(get("none", "asked")) },
    { measure: "ISBNdb paid calls this calendar month", value: String(paid.rows[0].n) },
  ];

  const cols = (first) => [
    ...first,
    ...SHOWN.map((c) => ({ key: c, label: COLUMN_LABELS[c], type: "int" })),
    { key: "avg_ms", label: "Average response (ms)", type: "int" },
  ];
  const ai = await require("./aiUsageReport").build(db, period, { csv: ctx.csv });
  return {
    banner: ai.banner,
    sections: [
      {
        key: "sources", title: `Per source: ${period.label.toLowerCase()}`, columns: cols([{ key: "source", label: "Source", type: "text" }]), rows: sourceRows,
        note: "For the memory (cache) row, Asked is the number of lookups answered without asking any catalog; for the not-found row it is the number of lookups where no catalog gave a title.",
      },
      { key: "overview", title: "Totals", columns: [{ key: "measure", label: "Measure", type: "text" }, { key: "value", label: "Value", type: "text" }], rows: overview,
        note: "ISBNdb is paid: check your ISBNdb plan quota. The paid-call count is the number of requests sent to ISBNdb (a request it refuses may or may not be billed), counted for the whole calendar month whatever period is chosen." },
      { key: "monthly", title: "Per month", columns: cols([{ key: "month", label: "Month", type: "text" }, { key: "source", label: "Source", type: "text" }]), rows: monthRows },
      {
        key: "daily", title: "Per day", columns: cols([{ key: "day", label: "Day (Paris)", type: "text" }, { key: "source", label: "Source", type: "text" }]), rows: dayRows,
        note: dailyTotal > dayRows.length ? `The latest ${dayRows.length} of ${dailyTotal} rows are shown here; the CSV has all of them.` : undefined,
      },
      ...ai.sections,
    ],
    notes: [
      "How to read this: each time someone scans or saves an ISBN, the site asks several book catalogs at the same time. \"Asked\" is how many times a catalog was asked. \"Supplied the title\" means its answer was the one whose title was used (the first catalog in priority order that had one). \"Only filled missing fields\" means another catalog gave the title but this one added something it lacked (author, publisher, year, description...). \"Answered, nothing new\" means it had the book but nothing of it was needed. \"Found nothing\" means it does not know the ISBN. \"Errors / timeouts\" are failures, \"Refused\" are answers like quota reached or key refused, and \"Cut short\" means the answer was already given and the site stopped waiting for it. The average is the time the catalog took to answer. Use this to decide whether Google Books or ISBNdb is worth keeping: a catalog that rarely supplies the title or fills a gap costs time or money for nothing.",
      "No ISBNs, titles or people are recorded: only counts per day and catalog. Counts are saved about every 30 seconds. Rows older than 36 months are deleted.",
      ...ai.notes,
    ],
  };
}

module.exports = { run, parsePeriod, PERIODS, DEFAULT_PERIOD, SOURCE_LABELS };
