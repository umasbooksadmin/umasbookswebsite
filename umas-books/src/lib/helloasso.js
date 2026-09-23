// Thin client for the HelloAsso Checkout API (OAuth2 client-credentials +
// checkout-intents). Docs: https://dev.helloasso.com/docs/api-overview
// and https://dev.helloasso.com/docs/int%C3%A9grer-le-paiement-sur-votre-site
//
// HelloAsso's own return-URL "code=succeeded" query param is explicitly
// documented as unreliable (client-side, can be spoofed or missed if the
// browser tab closes) — every caller of this module must treat
// getCheckoutIntent()'s response as the only source of truth for whether
// a payment actually went through, never the redirect itself.

const BASE_URL = process.env.HELLOASSO_API_BASE || "https://api.helloasso.com/v5";
const CLIENT_ID = process.env.HELLOASSO_CLIENT_ID;
const CLIENT_SECRET = process.env.HELLOASSO_CLIENT_SECRET;
const ORG_SLUG = process.env.HELLOASSO_ORG_SLUG;

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && ORG_SLUG);
}

// Access tokens last 30 minutes (per HelloAsso's docs) — cached in memory
// and refreshed a minute early so a slow request never races the actual
// expiry. Single in-process cache is fine: this is one Node process.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error("HelloAsso is not configured (missing HELLOASSO_CLIENT_ID/SECRET/ORG_SLUG).");
  }
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const res = await fetch(`${BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`HelloAsso auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (Number(data.expires_in) || 1800) * 1000 - 60_000;
  return cachedToken;
}

async function apiRequest(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`HelloAsso API ${method} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// amountCents: total order amount in cents (HelloAsso wants integer cents,
// not a decimal). itemName is shown to the payer on HelloAsso's page.
// backUrl/errorUrl/returnUrl must all be HTTPS in production.
async function createCheckoutIntent({ amountCents, itemName, backUrl, errorUrl, returnUrl, payer, metadata }) {
  return apiRequest("POST", `/organizations/${ORG_SLUG}/checkout-intents`, {
    totalAmount: amountCents,
    initialAmount: amountCents,
    itemName,
    backUrl,
    errorUrl,
    returnUrl,
    containsDonation: false,
    payer,
    metadata,
  });
}

async function getCheckoutIntent(checkoutIntentId) {
  return apiRequest("GET", `/organizations/${ORG_SLUG}/checkout-intents/${checkoutIntentId}`);
}

// A checkout intent's order is only genuinely paid once at least one of
// its payments is in the "Authorized" state — see PaymentState in
// HelloAsso's API reference. Pending/Refused/Canceled/etc. all mean "not
// paid" as far as we're concerned.
function isOrderPaid(checkoutIntent) {
  const payments = checkoutIntent && checkoutIntent.order && checkoutIntent.order.payments;
  return Array.isArray(payments) && payments.some((p) => p.state === "Authorized");
}

module.exports = { isConfigured, createCheckoutIntent, getCheckoutIntent, isOrderPaid };
