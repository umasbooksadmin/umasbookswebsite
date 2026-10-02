const { emailSafeName } = require("./validation");
const { formatDate } = require("./dates");

// The shop's identity block for order emails (French consumer-law
// mentions: who sells, and that VAT does not apply).
const SELLER_LINES =
  "Uma's Books — association loi 1901, RNA W811011706, SIRET 109 441 147 00013, 5 rue Hippolyte Savary, 81000 Albi\nTVA non applicable";

// Plain-text body of the order confirmation. Pure (no I/O) so it can be tested.
function buildOrderConfirmationText(order, items, base) {
  const termsLine = base
    ? `Terms of sale and your 14-day right of withdrawal for books: ${base.replace(/\/$/, "")}/terms-of-sale.html\n\n`
    : "";
  const lines = items.map((i) => `- ${i.item_title} — €${Number(i.price).toFixed(2)}`).join("\n");
  const orderDate = formatDate(order.created_at || new Date());
  return `Hi ${emailSafeName(order.buyer_name)},\n\nThanks for your order — payment received:\n\nOrder #${order.id} — ${orderDate}\nPaid online via HelloAsso\n\n${lines}\n\nTotal: €${Number(order.total_amount).toFixed(2)}\n\nCome by Uma's Books during opening hours to pick up any books. Drop-in sessions need no pickup — just come along at the session time.\n\n${termsLine}${SELLER_LINES}`;
}

module.exports = { buildOrderConfirmationText, SELLER_LINES };
