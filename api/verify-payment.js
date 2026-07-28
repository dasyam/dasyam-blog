// Vercel serverless function — lives at repo root: /api/verify-payment.js
// Verifies the HMAC-SHA256 signature Razorpay returns after checkout, so a
// payment is only trusted if it's provably genuine — never trust the
// frontend's word alone that a payment succeeded.
//
// Required env var:
//   RAZORPAY_KEY_SECRET

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
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

  if (expectedSignature !== razorpay_signature) {
    console.warn('Signature mismatch for order', razorpay_order_id);
    return res.status(400).json({ status: 'failed', reason: 'signature_mismatch' });
  }

  // Test-mode: just confirming the signature here. Once this proves out,
  // the cutover into pay.html will also POST to the Apps Script endpoint
  // (or a separate log) so a verified payment lands in Notion-visible data,
  // same as payment_confirmed does today.
  return res.status(200).json({
    status: 'verified',
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id
  });
}