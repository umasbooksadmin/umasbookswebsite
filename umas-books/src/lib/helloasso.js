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

// Every outbound call gets a hard timeout: the public webhook can be
// triggered by anyone (no signature), so a hung HelloAsso connection must
// not let forged calls pile up open requests indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

// Errors carry a `kind` ("auth" | "network" | "http") so callers (the
// reconcile sweep) can tell a systemic outage from one bad request.
function taggedError(message, kind, status) {
  const err = new Error(message);
  err.kind = kind;
  if (status) err.status = status;
  return err;
}

async function guardedFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw taggedError(`HelloAsso request failed: ${err.message}`, "network");
  }
}

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error("HelloAsso is not configured (missing HELLOASSO_CLIENT_ID/SECRET/ORG_SLUG).");
  }
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const res = await guardedFetch(`${BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw taggedError(`HelloAsso auth failed: ${res.status} ${await res.text()}`, "auth", res.status);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (Number(data.expires_in) || 1800) * 1000 - 60_000;
  return cachedToken;
}

async function apiRequest(method, path, body) {
  // A 401 means the cached token is no good (expired early, secret rotated):
  // drop it and retry once with a fresh one rather than failing every call
  // until the cache would have expired on its own.
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    const res = await guardedFetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      cachedToken = null;
      cachedTokenExpiresAt = 0;
      if (attempt === 0) continue;
      throw taggedError(`HelloAsso API ${method} ${path} failed: 401 ${await res.text()}`, "auth", 401);
    }
    if (!res.ok) {
      throw taggedError(`HelloAsso API ${method} ${path} failed: ${res.status} ${await res.text()}`, "http", res.status);
    }
    return res.json();
  }
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

// Membership is sold through a HelloAsso-hosted "Adhésion" form rather
// than a checkout intent we create ourselves, so there's no local order
// to look up by id the way reconcileOrder does — the payer's email is
// the only link back to a site account. This mirrors this module's
// existing rule of never trusting a webhook body: whatever the webhook
// claims, syncMembershipForEmail (see lib/membership.js) re-verifies by
// asking HelloAsso's API for this org's actual Membership-form orders.
//
// userSearchKey is NOT an exact match — HelloAsso's own docs describe it
// as filtering "on user or payer first name, last name or email", a
// fuzzy/multi-field search. Left unchecked, a search for
// "sam@example.com" could also return an unrelated order whose payer is
// simply named Sam, misattributing a stranger's real payment to
// whichever local account holds that email. Re-verifying each result's
// own order.payer.email against the exact address requested is what
// actually enforces "this order belongs to this email", not the API call.
async function findMembershipOrdersByEmail(email) {
  const params = new URLSearchParams({
    formTypes: "Membership",
    userSearchKey: email,
    pageSize: "50",
    sortOrder: "Desc",
  });
  const data = await apiRequest("GET", `/organizations/${ORG_SLUG}/orders?${params.toString()}`);
  const orders = Array.isArray(data && data.data) ? data.data : [];
  return orders.filter((o) => o.payer && typeof o.payer.email === "string" && o.payer.email.toLowerCase() === email.toLowerCase());
}

// Most recent Membership-form orders across the whole org (one API call),
// for the periodic membership backstop in lib/membership.js — unlike
// findMembershipOrdersByEmail there's no email to filter by, since the
// point is to discover payers whose webhook never arrived.
async function listRecentMembershipOrders() {
  const params = new URLSearchParams({ formTypes: "Membership", pageSize: "50", sortOrder: "Desc" });
  const data = await apiRequest("GET", `/organizations/${ORG_SLUG}/orders?${params.toString()}`);
  return Array.isArray(data && data.data) ? data.data : [];
}

module.exports = { isConfigured, listRecentMembershipOrders, createCheckoutIntent, getCheckoutIntent, isOrderPaid, findMembershipOrdersByEmail };
