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
// Required env var: RAZORPAY_WEBHOOK_SECRET

import crypto from 'crypto';

// Body parsing must be disabled so we can verify the signature against the
// exact raw bytes Razorpay sent — a re-serialized JSON body won't match.
export const config = {
  api: { bodyParser: false }
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
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

  if (!signature || expected !== signature) {
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

  try {
    if (event.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity;
      await handlePaymentCaptured(payment);
    } else if (event.event === 'payment.failed') {
      const payment = event.payload?.payment?.entity;
      console.warn('Payment failed:', payment?.id, payment?.error_description);
      // No forward to Sheet/notify for failures yet — logged here for now.
      // Revisit if silent failures start mattering operationally.
    } else {
      console.log('Unhandled webhook event type:', event.event);
    }
  } catch (err) {
    // Never let downstream forwarding failures affect the 200 we send
    // Razorpay — an ack failure would cause Razorpay to retry the whole
    // webhook, which could double-log the payment.
    console.error('Error processing webhook event:', err.message);
  }

  return res.status(200).json({ status: 'ok' });
}

async function handlePaymentCaptured(payment) {
  if (!payment) return;

  // `notes` is where participant identity rides through Razorpay — it must
  // be set at order-creation time (see create-order.js) with name/whatsapp/
  // invite, since the webhook has no other way to know who this was.
  const notes = payment.notes || {};

  const sheetEndpoint = process.env.SHEET_ENDPOINT;
  if (!sheetEndpoint) {
    console.warn('SHEET_ENDPOINT not set — captured payment not forwarded:', payment.id);
    return;
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
    landing_page: notes.landing_page || ''
  };

  await fetch(sheetEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(data)
  });

  console.log('Forwarded captured payment to Sheet:', payment.id);
}