// Vercel serverless function — lives at repo root: /api/verify-payment.js
// Verifies the HMAC-SHA256 signature Razorpay returns after checkout, so a
// payment is only trusted if it's provably genuine — never trust the
// frontend's word alone that a payment succeeded.
//
// Required env vars:
//   RAZORPAY_KEY_SECRET
//   RAZORPAY_KEY_ID      (new — needed to read the order back from Razorpay)

import crypto from 'crypto';

/* ===========================================================================
   CHANGES 2026-08-30. Two.

   1. The signature comparison is timing-safe.
      `expectedSignature !== razorpay_signature` compares byte by byte and
      returns as soon as it finds a difference, which leaks how much of a
      forged signature was correct. Remote timing attacks across HTTPS are
      impractical in the real world, so treat this as hardening rather than a
      live hole. It costs nothing to do properly.

   2. The AMOUNT is now checked, and this is the one that matters.
      A valid signature proves only that this payment belongs to that order.
      It says nothing about what the order was for. Paired with the old
      create-order.js, which took the price from the browser, a one rupee
      order produced a perfectly valid signature and verified cleanly. That
      hole is closed in create-order.js, but closing it in one place only
      means the next person to add a parameter reopens it.

      So this endpoint now reads the order back from Razorpay and confirms
      the amount and currency against the same server-side table, and that
      the order is actually paid. Defence in depth: create-order decides the
      price, this confirms the price that was actually charged.
   =========================================================================== */

const PLANS = {
  standard: { amount: 19900, currency: 'INR' }
};
const ACCEPTED = Object.values(PLANS);

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, so the length check has to
  // happen first. Length is not secret; the contents are.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (!keySecret) {
    console.error('RAZORPAY_KEY_SECRET missing');
    return res.status(500).json({ error: 'Server not configured' });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!safeEqualHex(expectedSignature, razorpay_signature)) {
    console.warn('Signature mismatch for order', razorpay_order_id);
    return res.status(400).json({ status: 'failed', reason: 'signature_mismatch' });
  }

  // ---- Amount confirmation -------------------------------------------------
  // If the key id is not configured we cannot read the order back. Fail open
  // on this specific check rather than blocking a genuine payer, but say so
  // loudly, because a verification that silently stops verifying is worse
  // than one that was never added.
  if (!keyId) {
    console.error('RAZORPAY_KEY_ID missing — amount check SKIPPED for order ' + razorpay_order_id);
    return res.status(200).json({
      status: 'verified',
      amount_checked: false,
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id
    });
  }

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const orderRes = await fetch('https://api.razorpay.com/v1/orders/' + encodeURIComponent(razorpay_order_id), {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!orderRes.ok) {
      // Razorpay unreachable or rate limiting. The signature already passed,
      // so this is a genuine payment we cannot fully corroborate right now.
      // Let it through and flag it: the webhook is source of truth and
      // records the real amount, so a wrong amount is still catchable there.
      console.error('Could not read order back:', orderRes.status, razorpay_order_id);
      return res.status(200).json({
        status: 'verified',
        amount_checked: false,
        order_id: razorpay_order_id,
        payment_id: razorpay_payment_id
      });
    }

    const order = await orderRes.json();
    const matches = ACCEPTED.some(p => p.amount === order.amount && p.currency === order.currency);

    if (!matches) {
      console.error('AMOUNT MISMATCH on verified signature. order:', razorpay_order_id,
                    'amount:', order.amount, order.currency);
      return res.status(400).json({ status: 'failed', reason: 'amount_mismatch' });
    }

    if (order.status !== 'paid') {
      console.warn('Order not in paid status:', razorpay_order_id, order.status);
      return res.status(400).json({ status: 'failed', reason: 'order_not_paid' });
    }

    return res.status(200).json({
      status: 'verified',
      amount_checked: true,
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id
    });
  } catch (err) {
    console.error('verify-payment order lookup error:', err.message);
    return res.status(200).json({
      status: 'verified',
      amount_checked: false,
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id
    });
  }
}

export const __test = { safeEqualHex, PLANS };