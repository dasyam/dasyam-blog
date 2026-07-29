// Vercel serverless function — lives at repo root: /api/create-order.js
// Deploys independently of the Astro build. Not linked from any live-facing
// page. Reads credentials from env vars only — never hardcode here.
//
// Required env vars (set in Vercel dashboard → Settings → Environment Variables):
//   RAZORPAY_KEY_ID
//   RAZORPAY_KEY_SECRET

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
    const { amount, currency = 'INR', receipt, notes } = req.body || {};

    if (!amount || typeof amount !== 'number' || amount < 100) {
      return res.status(400).json({ error: 'Amount must be an integer >= 100 (paise)' });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    // `notes` rides through Razorpay unchanged and comes back attached to
    // the payment object in the webhook payload — this is how the webhook
    // (which has no other context) knows which participant this was.
    // Keep it optional so pay-test.html (no participant identity) still works.
    const orderPayload = {
      amount,
      currency,
      receipt: receipt || `receipt_${Date.now()}`
    };
    if (notes && typeof notes === 'object') {
      orderPayload.notes = notes;
    }

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