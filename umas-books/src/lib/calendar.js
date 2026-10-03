// Pure date-math helpers for rendering a month-grid calendar in EJS views.
// All dates are handled in the server's local timezone, which lib/tz.js
// pins to Europe/Paris, matching the display helpers in lib/dates.js.
require("./tz");

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

// lang: "fr" gives "Octobre 2026"; anything else the original "October 2026".
function monthLabel(year, month, lang) {
  if (lang === "fr") return capitalize(new Date(year, month, 1).toLocaleString("fr-FR", { month: "long", year: "numeric" }));
  return new Date(year, month, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
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

// monthGrid builds Sunday-first weeks; the floral calendar pages
// (/sessions and others sharing its partial) display Monday-first. Re-chunking the
// flattened days is the only correct way to do that — rotating each
// Sunday-first row in place would pair every Saturday with the
// *previous* Sunday instead of the following one.
function mondayFirstWeeks(weeks) {
  const flatDays = weeks.flat().filter(Boolean);
  const leadingSunFirst = weeks[0].findIndex((c) => c !== null);
  const leadingMonFirst = (leadingSunFirst + 6) % 7;
  const cells = new Array(leadingMonFirst).fill(null).concat(flatDays);
  while (cells.length % 7 !== 0) cells.push(null);
  const result = [];
  for (let i = 0; i < cells.length; i += 7) result.push(cells.slice(i, i + 7));
  return result;
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
function monthNav(year, month, lang) {
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  return {
    monthLabel: monthLabel(year, month, lang),
    prevMonth: monthParam(prev.year, prev.month),
    nextMonth: monthParam(next.year, next.month),
    currentMonth: monthParam(year, month),
  };
}

// ---------- Week view ----------
// weekStartsOn: 0 = Sunday (admin calendars), 1 = Monday (public
// "floral calendar" pages, which already display Monday-first — see
// mondayFirstWeeks above). Unlike monthGrid, a week's 7 cells are always
// real days, never padding, so there's no null-cell bookkeeping here.

function startOfWeek(date, weekStartsOn) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return d;
}

function parseWeekParam(param, weekStartsOn) {
  let base = new Date();
  if (param && /^\d{4}-\d{2}-\d{2}$/.test(param)) {
    const [y, m, day] = param.split("-").map(Number);
    base = new Date(y, m - 1, day);
  }
  return startOfWeek(base, weekStartsOn);
}

function shiftWeek(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta * 7);
  return d;
}

function weekRange(startDate) {
  const start = new Date(startDate);
  const end = new Date(startDate);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

function weekLabel(startDate, lang) {
  const start = new Date(startDate);
  const end = new Date(startDate);
  end.setDate(end.getDate() + 6);
  if (lang === "fr") {
    const m = (d) => d.toLocaleString("fr-FR", { month: "long" });
    if (start.getFullYear() !== end.getFullYear()) {
      return `${start.getDate()} ${m(start)} ${start.getFullYear()} – ${end.getDate()} ${m(end)} ${end.getFullYear()}`;
    }
    if (m(start) !== m(end)) return `${start.getDate()} ${m(start)} – ${end.getDate()} ${m(end)} ${start.getFullYear()}`;
    return `${start.getDate()}–${end.getDate()} ${m(start)} ${start.getFullYear()}`;
  }
  const startMonth = start.toLocaleString("en-US", { month: "long" });
  const endMonth = end.toLocaleString("en-US", { month: "long" });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${startMonth} ${start.getDate()}, ${start.getFullYear()} – ${endMonth} ${end.getDate()}, ${end.getFullYear()}`;
  }
  if (startMonth !== endMonth) {
    return `${startMonth} ${start.getDate()} – ${endMonth} ${end.getDate()}, ${start.getFullYear()}`;
  }
  return `${startMonth} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
}

// Flat array of 7 day-cells, same shape as one row of monthGrid's output,
// so a view's existing `weeks.forEach(week => week.forEach(day => ...))`
// loop renders a week view unchanged — see resolveCalendarRange below.
function weekGrid(startDate, itemsByDate) {
  const today = dateKey(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = dateKey(d);
    days.push({ day: d.getDate(), dateKey: key, isToday: key === today, items: itemsByDate[key] || [] });
  }
  return days;
}

function weekNav(startDate, lang) {
  const prev = shiftWeek(startDate, -1);
  const next = shiftWeek(startDate, 1);
  return {
    weekLabel: weekLabel(startDate, lang),
    prevWeek: dateKey(prev),
    nextWeek: dateKey(next),
    currentWeek: dateKey(startDate),
  };
}

// Shared by every calendar route (admin events/sessions/volunteer/
// meetings, public events/sessions/immersion-calendar/meetings/
// volunteer): resolves ?view=week&week=YYYY-MM-DD or the existing
// ?month=YYYY-MM into the DB date range to query, a buildWeeks(itemsByDate)
// to call once the query's rows are grouped, and the nav fields the view
// needs. Keeps month-view's existing field names (monthLabel, prevMonth,
// ...) untouched — week view adds its own (weekLabel, prevWeek, ...)
// alongside a `view` flag, rather than renaming anything. `lang` ("fr")
// makes the month/week labels French; omitted means English (admin).
function resolveCalendarRange(query, weekStartsOn, lang) {
  if (query.view === "week") {
    const weekStart = parseWeekParam(query.week, weekStartsOn);
    const { start, end } = weekRange(weekStart);
    return {
      view: "week",
      start,
      end,
      buildWeeks: (itemsByDate) => [weekGrid(weekStart, itemsByDate)],
      nav: weekNav(weekStart, lang),
    };
  }
  const { year, month } = parseMonthParam(query.month);
  const { start, end } = monthRange(year, month);
  return {
    view: "month",
    start,
    end,
    buildWeeks: (itemsByDate) => monthGrid(year, month, itemsByDate),
    nav: monthNav(year, month, lang),
  };
}

// Reconstructs the ?month=... or ?view=week&week=... query string a
// calendar route redirects back to after a POST, from whichever of
// req.body/req.query carried the current view (see the hidden view/week
// fields alongside the existing month one in each calendar template).
function calendarBackQuery(source) {
  if (source.view === "week" && source.week) return `view=week&week=${source.week}`;
  if (source.month) return `month=${source.month}`;
  return "";
}

module.exports = {
  dateKey,
  parseMonthParam,
  monthParam,
  shiftMonth,
  monthLabel,
  monthRange,
  monthGrid,
  mondayFirstWeeks,
  groupByDate,
  monthNav,
  parseWeekParam,
  shiftWeek,
  weekRange,
  weekLabel,
  weekGrid,
  weekNav,
  resolveCalendarRange,
  calendarBackQuery,
};
