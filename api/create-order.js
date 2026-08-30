// Vercel serverless function — lives at repo root: /api/create-order.js
// Deploys independently of the Astro build. Not linked from any live-facing
// page. Reads credentials from env vars only — never hardcode here.
//
// Required env vars (set in Vercel dashboard → Settings → Environment Variables):
//   RAZORPAY_KEY_ID
//   RAZORPAY_KEY_SECRET

/* ===========================================================================
   CHANGE 2026-08-30. The price is no longer taken from the browser.

   Previously the handler destructured `amount` out of req.body and passed it
   to Razorpay after checking only that it was a number >= 100 paise. This is
   a public endpoint. Anyone could POST amount: 100, receive a genuine order
   for one rupee, pay it, and pass verify-payment.js cleanly, because the
   signature Razorpay returns is authentic for whatever order was created.
   Nothing downstream would object: the webhook records whatever was charged.

   The price now comes from the PLANS table below and the client's number is
   ignored entirely. A mismatched amount is rejected rather than silently
   corrected, so a genuine client/server drift shows up as a visible failure
   instead of a wrong charge.

   `currency` is pinned for the same reason: it was client-controlled with an
   INR default, and there is no case where this endpoint should mint an order
   in anything else.

   PLANS exists rather than a bare constant so the continuing-participant
   discount, when it is decided, has somewhere to land that does not involve
   reopening this hole. Add a plan, do not add a parameter.
   =========================================================================== */

const PLANS = {
  standard: { amount: 19900, currency: 'INR' } // ₹199 early bird, the only live path
};

// Razorpay rejects any note VALUE over 256 chars and allows at most 15 pairs.
// A rejected order is a blocked payment, so this is a payment-path check, not
// hygiene. pay.html truncates the three Meta identifiers but not name,
// whatsapp, utm_*, referrer or landing_page, and referrer in particular can
// carry a long URL. Truncating here covers every field rather than the three
// the client remembered to handle.
const NOTE_VALUE_MAX = 255;
const NOTE_PAIRS_MAX = 15;

function sanitizeNotes(notes) {
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return null;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(notes)) {
    if (count >= NOTE_PAIRS_MAX) break;
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, NOTE_VALUE_MAX);
    count++;
  }
  return Object.keys(out).length ? out : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error('Razorpay env vars missing');
    return res.status(500).json({ error: 'Server not configured' });
  }

  try {
    const { amount, plan = 'standard', receipt, notes } = req.body || {};

    const chosen = PLANS[plan];
    if (!chosen) {
      console.warn('Unknown plan requested:', plan);
      return res.status(400).json({ error: 'Unknown plan' });
    }

    // The client still sends an amount so the two can be cross-checked. It is
    // never used as the charge. A mismatch means pay.html and this table have
    // drifted, which is a deploy error worth surfacing loudly rather than
    // quietly charging one of the two numbers.
    if (amount !== undefined && amount !== chosen.amount) {
      console.error('Amount mismatch. client:', amount, 'server:', chosen.amount, 'plan:', plan);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    const orderPayload = {
      amount: chosen.amount,
      currency: chosen.currency,
      // Razorpay caps receipt at 40 chars.
      receipt: String(receipt || `receipt_${Date.now()}`).slice(0, 40)
    };

    // `notes` rides through Razorpay unchanged and comes back attached to the
    // payment object in the webhook payload — this is how the webhook (which
    // has no other context) knows which participant this was.
    const safeNotes = sanitizeNotes(notes);
    if (safeNotes) orderPayload.notes = safeNotes;

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rzpResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    });

    if (!rzpResponse.ok) {
      const errText = await rzpResponse.text();
      console.error('Razorpay order creation failed:', rzpResponse.status, errText);
      return res.status(rzpResponse.status === 401 ? 401 : 500).json({
        error: 'Order creation failed'
      });
    }

    const order = await rzpResponse.json();
    return res.status(200).json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (err) {
    console.error('create-order error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Exported for tests only. Not part of the HTTP surface.
export const __test = { PLANS, sanitizeNotes };