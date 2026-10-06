// Seeds online orders the way checkout and markOrderPaid leave them, for the
// refund / pickup / follow-up tests. `pool` is the app's pool.

let seq = 0;

// opts: status ('paid'), paidDaysAgo (status paid: 0), createdMinutesAgo,
// books (1), seat (false), intentId, userId, email, collected, lang
async function makeOrder(pool, opts = {}) {
  const {
    status = "paid", paidDaysAgo = 0, paidAt = null, createdMinutesAgo = null, books = 1, seat = false,
    intentId = undefined, userId = null, email = null, name = "Fixture Buyer", collected = false, lang = "en", price = 5,
  } = opts;
  seq++;
  const total = (books + (seat ? 1 : 0)) * price;
  const intent = intentId === undefined ? `fx-intent-${Date.now()}-${seq}` : intentId;
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, lang, user_id, created_at, paid_at, collected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             COALESCE($8::timestamptz, now() - make_interval(days => $9::int, mins => COALESCE($10::int, 0)) - interval '5 minutes'),
             CASE WHEN $4 IN ('paid', 'refunded') THEN COALESCE($8::timestamptz, now() - make_interval(days => $9::int)) END,
             CASE WHEN $11::boolean THEN now() END)
     RETURNING *`,
    [name, email || `fx-${Date.now()}-${seq}@example.test`, total, status, intent, lang, userId, paidAt, paidDaysAgo, createdMinutesAgo, collected]
  );
  const order = rows[0];
  const copyIds = [];
  const copyStatus = status === "paid" || status === "refunded" ? "sold" : status === "pending" ? "in_cart" : "in_stock";
  for (let i = 0; i < books; i++) {
    const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Fixture Author') RETURNING id", [`Fixture Book ${seq}-${i}`]);
    const { rows: c } = await pool.query(
      `INSERT INTO book_copies (book_id, status, price, cart_order_id, cart_added_at)
       VALUES ($1, $2, $3, CASE WHEN $2 = 'in_cart' THEN $4::int END, CASE WHEN $2 = 'in_cart' THEN now() END) RETURNING id`,
      [b[0].id, copyStatus, price, order.id]
    );
    copyIds.push(c[0].id);
    await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, $4)", [order.id, c[0].id, `Fixture Book ${seq}-${i}`, price]);
  }
  let seatId = null;
  let classId = null;
  if (seat) {
    const { rows: cl } = await pool.query(
      "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Fixture Drop-in', now() + interval '3 days', 3, $1) RETURNING id", [price]
    );
    classId = cl[0].id;
    const seatStatus = status === "paid" || status === "refunded" ? "sold" : status === "pending" ? "in_cart" : "released";
    const { rows: s } = await pool.query(
      "INSERT INTO class_dropin_seats (class_id, status, order_id, cart_added_at) VALUES ($1, $2, $3, now()) RETURNING id", [classId, seatStatus, order.id]
    );
    seatId = s[0].id;
    await pool.query("INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 'Fixture Drop-in seat', $3)", [order.id, seatId, price]);
  }
  return { order, copyIds, seatId, classId };
}

module.exports = { makeOrder };
