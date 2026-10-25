// Order lines as shown to the customer. order_items.item_title is the
// accounting record written at checkout (English month names, never edited);
// for a drop-in seat the line is re-rendered at display time in the viewer's
// language from the class row (title, or title_fr for a French reader when the shop wrote one; starts_at), and falls back to the
// stored title when the class row is gone.
const { LOCALES } = require("./dates");
const { SITE_TIME_ZONE } = require("./tz");
const { normLang } = require("./lang");
const { conditionLabel } = require("./inventory");

// Selects an order's lines with the class behind each drop-in seat.
// class_title / class_title_fr / class_starts_at are NULL for books and for deleted classes.
const ORDER_ITEMS_SQL = `
  SELECT i.item_title, i.price, i.class_dropin_seat_id, c.title AS class_title, c.title_fr AS class_title_fr, c.starts_at AS class_starts_at,
         bc.condition AS copy_condition
  FROM order_items i
  LEFT JOIN book_copies bc ON bc.id = i.book_copy_id
  LEFT JOIN class_dropin_seats s ON s.id = i.class_dropin_seat_id
  LEFT JOIN classes c ON c.id = s.class_id
  WHERE i.order_id = $1
  ORDER BY i.id`;

// The same shape as the stored label ("Title — 12 Oct, 18:00"), localized,
// in Europe/Paris.
function dropinLabel(title, startsAt, lang) {
  const locale = LOCALES[normLang(lang) || "en"];
  const d = new Date(startsAt);
  const day = d.toLocaleDateString(locale, { timeZone: SITE_TIME_ZONE, day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(locale, { timeZone: SITE_TIME_ZONE, hour: "2-digit", minute: "2-digit" });
  return `${title} — ${day}, ${time}`;
}

// Accepts a row from ORDER_ITEMS_SQL (snake_case), or the account page's JSON
// (title / classTitle / classStartsAt).
function orderItemLabel(item, lang) {
  const title = item.class_title ?? item.classTitle;
  const startsAt = item.class_starts_at ?? item.classStartsAt;
  if (title != null && startsAt != null) {
    // The session's French title, when the shop wrote one, for a customer reading French (page or e-mail); else the English title.
    const titleFr = String(item.class_title_fr ?? item.classTitleFr ?? "").trim();
    return dropinLabel(normLang(lang) === "fr" && titleFr ? titleFr : title, startsAt, lang);
  }
  const label = item.item_title ?? item.title;
  // A book line carries the grade of the copy that was bought: "Title (Very Good)".
  const condition = item.copy_condition ?? item.condition;
  return condition ? `${label} (${conditionLabel(condition, lang)})` : label;
}

async function loadOrderItems(pool, orderId) {
  const { rows } = await pool.query(ORDER_ITEMS_SQL, [orderId]);
  return rows;
}

// The LAST DAY a reservation can be collected, as an instant to format. An order's
// reserved_until is the midnight that ENDS that day (Paris time), so the day to
// show is the one a minute before it.
function reservationLastDay(order) {
  return order.reserved_until ? new Date(new Date(order.reserved_until).getTime() - 60 * 1000) : null;
}

module.exports = { ORDER_ITEMS_SQL, dropinLabel, orderItemLabel, loadOrderItems, reservationLastDay };
