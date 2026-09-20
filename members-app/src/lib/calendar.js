// Pure date-math helpers for rendering a month-grid calendar in EJS views.
// All dates are handled in the server's local timezone, matching the rest
// of the app (views already call `new Date(x).toLocaleString()` with no
// explicit timezone).

function dateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseMonthParam(param) {
  if (param && /^\d{4}-\d{2}$/.test(param)) {
    const [y, m] = param.split("-").map(Number);
    return { year: y, month: m - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function monthParam(year, month) {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function shiftMonth(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

function monthRange(year, month) {
  return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
}

// itemsByDate: { "YYYY-MM-DD": [item, ...] }
function monthGrid(year, month, itemsByDate) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = dateKey(new Date());

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(new Date(year, month, day));
    cells.push({ day, dateKey: key, isToday: key === today, items: itemsByDate[key] || [] });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function groupByDate(rows, dateField) {
  const itemsByDate = {};
  for (const row of rows) {
    const key = dateKey(row[dateField]);
    if (!itemsByDate[key]) itemsByDate[key] = [];
    itemsByDate[key].push(row);
  }
  return itemsByDate;
}

// Convenience bundle of everything an admin/member calendar route needs
// to hand to its view: the label, nav links, and the param for the
// currently-displayed month (so "add" forms can redirect back to it).
function monthNav(year, month) {
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  return {
    monthLabel: monthLabel(year, month),
    prevMonth: monthParam(prev.year, prev.month),
    nextMonth: monthParam(next.year, next.month),
    currentMonth: monthParam(year, month),
  };
}

module.exports = {
  dateKey,
  parseMonthParam,
  monthParam,
  shiftMonth,
  monthLabel,
  monthRange,
  monthGrid,
  groupByDate,
  monthNav,
};
