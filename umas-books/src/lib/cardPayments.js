// Card payments at the till. One interface, so the way a card is charged can
// change without touching the till screen or the sale record:
//
//   provider.startCharge(amountCents, saleToken) -> { status, reference }
//     status:    "paid" (the money was taken), "pending" (poll later), "failed" or "cancelled"
//     reference: free text for the books (last 4 digits, terminal receipt number) or null
//
// Today there is ONE implementation, ManualCard: a person charges the amount
// on the SumUp Solo reader by hand and presses "Card paid" on the till. Nothing
// is sent anywhere.
//
// TODO(SumUp Cloud API): a SumUpCloudCard implementation of the same interface
// (Readers API on a Solo: POST a checkout to the paired reader, then poll or
// receive the webhook for the result, inside the reader's 60-second window; the
// saleToken becomes the checkout's client_transaction_id so a retry cannot
// charge twice). It needs a SumUp API key and a paired reader, kept in
// environment variables that do NOT exist yet: see docs/runbook.md ("The till",
// "Later: the SumUp Cloud API"). Nothing in this file calls SumUp.

class ManualCard {
  constructor() {
    this.name = "manual";
  }

  // The person has taken the payment on the reader and confirmed it on the till.
  // `confirmed` is that confirmation; `reference` is the optional note.
  async startCharge(amountCents, saleToken, { confirmed = false, reference = null } = {}) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) return { status: "failed", reference: null };
    if (!saleToken) return { status: "failed", reference: null };
    if (!confirmed) return { status: "pending", reference: null };
    const ref = reference == null ? "" : String(reference).trim().slice(0, 40);
    return { status: "paid", reference: ref || null };
  }

  // The text the till shows before the person charges the reader.
  instruction(amountCents) {
    return `Charge €${(amountCents / 100).toFixed(2)} on the SumUp reader, then press Card paid.`;
  }
}

let provider = new ManualCard();
const getCardProvider = () => provider;
// For tests, and for the day a SumUp implementation exists.
const setCardProvider = (p) => { provider = p; };

module.exports = { ManualCard, getCardProvider, setCardProvider };
