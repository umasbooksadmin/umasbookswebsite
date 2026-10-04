// Order lines as shown to the customer. order_items.item_title is the
// accounting record written at checkout (English month names, never edited);
// for a drop-in seat the line is re-rendered at display time in the viewer's
// language from the class row (title, starts_at), and falls back to the
// stored title when the class row is gone.
const { LOCALES } = require("./dates");
const { SITE_TIME_ZONE } = require("./tz");
const { normLang } = require("./lang");

// Selects an order's lines with the class behind each drop-in seat.
// class_title / class_starts_at are NULL for books and for deleted classes.
const ORDER_ITEMS_SQL = `
  SELECT i.item_title, i.price, i.class_dropin_seat_id, c.title AS class_title, c.starts_at AS class_starts_at
  FROM order_items i
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
  if (title != null && startsAt != null) return dropinLabel(title, startsAt, lang);
  return item.item_title ?? item.title;
}

async function loadOrderItems(pool, orderId) {
  const { rows } = await pool.query(ORDER_ITEMS_SQL, [orderId]);
  return rows;
}

module.exports = { ORDER_ITEMS_SQL, dropinLabel, orderItemLabel, loadOrderItems };
