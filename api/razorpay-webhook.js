// Vercel serverless function — /api/razorpay-webhook.js
// Source of truth for "did this payment actually go through." The frontend
// callback in verify-payment.js is good for immediate UX (show a success
// state on screen) but is NOT reliable alone — if the browser closes or
// the network drops right after payment, that callback never fires. This
// webhook is Razorpay calling us directly from their servers, so it
// doesn't depend on the participant's browser at all.
//
// Setup required in Razorpay Dashboard (do this per mode — Test and Live
// are configured separately):
//   Settings → Webhooks → Add New Webhook
//   URL: https://rhythm.srinivasdasyam.com/api/razorpay-webhook
//   Active events: payment.captured, payment.failed
//   Set a secret (you choose it) — save it as RAZORPAY_WEBHOOK_SECRET in
//   Vercel env vars. This is a DIFFERENT secret from RAZORPAY_KEY_SECRET.
//
// Required env vars: RAZORPAY_WEBHOOK_SECRET, SHEET_ENDPOINT

import crypto from 'crypto';

/* ===========================================================================
   CHANGE 2026-08-30. The failure mode this closes:

   The original caught every downstream error and still returned 200, with the
   reasoning that a non-2xx would make Razorpay retry and double-log the
   payment. The reasoning about retries was right. The consequence was not.

   If the Sheet write failed, Razorpay had the money, the customer saw a
   success page, and there was no row anywhere and no notification email. You
   would never learn that person existed, so Template 1 would never go out.
   A paid customer vanishing without trace is a worse outcome than a duplicate
   row, and the original traded the first for the second.

   Three changes, in order of importance:

   1. The Sheet forward is retried, then a persistent failure returns 500 so
      Razorpay retries the delivery itself over the following hours. This is
      ONLY safe because the Apps Script is now idempotent on
      razorpay_payment_id, so a redelivery updates rather than duplicates.
      DO NOT deploy this file without that Apps Script change.

   2. The Apps Script HTTP response is actually checked. It returns 200 with a
      JSON body even when it rejects a row, so a rejected write previously
      looked identical to a successful one.

   3. The forward has a timeout. Apps Script can hang, and a hung fetch would
      burn the whole function timeout and produce an ambiguous outcome.

   Signature verification, raw-body handling and event routing are unchanged.
   =========================================================================== */

export const config = {
  api: { bodyParser: false }
};

const SHEET_TIMEOUT_MS = 8000;
const SHEET_ATTEMPTS = 3;

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('RAZORPAY_WEBHOOK_SECRET missing');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('Failed to read webhook body:', err.message);
    return res.status(400).json({ error: 'Could not read body' });
  }

  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  if (!safeEqualHex(expected, signature)) {
    console.warn('Webhook signature mismatch — rejecting');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.error('Webhook body not valid JSON:', err.message);
    return res.status(400).json({ error: 'Invalid payload' });
  }

  console.log('Verified Razorpay webhook:', event.event);

  if (event.event === 'payment.captured') {
    const payment = event.payload?.payment?.entity;
    let forwarded;
    try {
      forwarded = await handlePaymentCaptured(payment);
    } catch (err) {
      console.error('Error processing payment.captured:', err.message);
      forwarded = false;
    }

    if (forwarded === false) {
      // Deliberate non-2xx. Razorpay will redeliver, and the Apps Script
      // deduplicates on razorpay_payment_id, so a redelivery cannot create a
      // second row or a second notification email.
      console.error('CAPTURED PAYMENT NOT RECORDED, asking Razorpay to retry:', payment?.id);
      return res.status(500).json({ status: 'retry', reason: 'sheet_forward_failed' });
    }

    return res.status(200).json({ status: 'ok' });
  }

  if (event.event === 'payment.failed') {
    const payment = event.payload?.payment?.entity;
    console.warn('Payment failed:', payment?.id, payment?.error_description);
    // No forward to Sheet/notify for failures yet — logged here for now.
    // Revisit if silent failures start mattering operationally.
    return res.status(200).json({ status: 'ok' });
  }

  console.log('Unhandled webhook event type:', event.event);
  return res.status(200).json({ status: 'ok' });
}

// Returns true when the row is recorded, false when it is not and Razorpay
// should retry. Returns true for cases where retrying cannot help, so a
// permanently broken configuration does not produce an endless retry loop.
async function handlePaymentCaptured(payment) {
  if (!payment) {
    console.error('payment.captured with no payment entity — nothing to record');
    return true; // retrying will not conjure an entity
  }

  // `notes` is where participant identity rides through Razorpay — it must
  // be set at order-creation time (see create-order.js) with name/whatsapp/
  // invite, since the webhook has no other way to know who this was.
  const notes = payment.notes || {};

  const sheetEndpoint = process.env.SHEET_ENDPOINT;
  if (!sheetEndpoint) {
    console.error('SHEET_ENDPOINT not set — captured payment NOT recorded:', payment.id);
    return true; // config problem, retrying changes nothing
  }

  const data = {
    event: 'payment_confirmed',
    name: notes.name || '',
    whatsapp: notes.whatsapp || '',
    invite: notes.invite || '',
    amount_due: payment.amount, // paise, as captured — matches what was actually charged
    discount_type: notes.discount_type || 'live_payment',
    payment_confirmed: true,
    timestamp: new Date().toISOString(),
    razorpay_payment_id: payment.id,
    razorpay_order_id: payment.order_id,
    utm_source: notes.utm_source || '',
    utm_medium: notes.utm_medium || '',
    utm_campaign: notes.utm_campaign || '',
    referrer: notes.referrer || '',
    device: notes.device || '',
    landing_page: notes.landing_page || '',
    fbclid: notes.fbclid || '',
    ref: notes.ref || ''
  };

  for (let attempt = 1; attempt <= SHEET_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SHEET_TIMEOUT_MS);
      const resp = await fetch(sheetEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(data),
        signal: controller.signal,
        redirect: 'follow' // Apps Script /exec 302s to script.googleusercontent.com
      });
      clearTimeout(timer);

      if (!resp.ok) {
        console.warn(`Sheet forward attempt ${attempt} HTTP ${resp.status}`);
        continue;
      }

      // Apps Script answers 200 even when it rejects the row, so the body is
      // the only place the outcome actually appears.
      const text = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { /* not JSON, fall through */ }

      if (parsed && parsed.status === 'ok') {
        console.log('Forwarded captured payment to Sheet:', payment.id,
                    parsed.duplicate ? '(duplicate, already recorded)' : '');
        return true;
      }

      console.warn(`Sheet forward attempt ${attempt} rejected:`,
                   (parsed && parsed.reason) || text.slice(0, 200));
    } catch (err) {
      console.warn(`Sheet forward attempt ${attempt} threw:`, err.message);
    }

    if (attempt < SHEET_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }

  return false;
}

export const __test = { safeEqualHex };