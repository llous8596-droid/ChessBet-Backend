const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

// Créer une session de paiement Stripe
router.post('/deposit', auth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount < 5)  return res.status(400).json({ error: 'Minimum 5€' });
  if (amount > 5000)           return res.status(400).json({ error: 'Maximum 5000€' });

  const cents = Math.round(amount * 100);
  try {
    const r = await pool.query('SELECT stripe_customer_id,email,username FROM users WHERE id=$1', [req.user.id]);
    const user = r.rows[0];
    let cid = user.stripe_customer_id;
    if (!cid) {
      const c = await stripe.customers.create({ email: user.email, name: user.username });
      cid = c.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [cid, req.user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: cid,
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'eur', product_data: { name: `Dépôt ChessBet` }, unit_amount: cents }, quantity: 1 }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/deposit-success`,
      cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}/`,
      metadata: { user_id: String(req.user.id), amount_cents: String(cents) },
    });

    await pool.query(
      'INSERT INTO transactions(user_id,type,amount,stripe_id,status) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, 'deposit', cents, session.id, 'pending']
    );

    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur Stripe' });
  }
});

// Webhook Stripe — crédite le compte quand le paiement est confirmé
router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const userId = parseInt(s.metadata.user_id);
    const cents  = parseInt(s.metadata.amount_cents);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [cents, userId]);
      await client.query('UPDATE transactions SET status=$1 WHERE stripe_id=$2', ['completed', s.id]);
      await client.query('COMMIT');
      console.log(`✅ Dépôt ${cents/100}€ crédité → user ${userId}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(e);
    } finally { client.release(); }
  }
  res.json({ received: true });
});

// Solde
router.get('/balance', auth, async (req, res) => {
  const r = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
  res.json({ balance: r.rows[0].balance });
});

// Historique
router.get('/history', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT type,amount,status,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(r.rows);
});

// Stats admin
router.get('/admin', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM admin_stats WHERE id=1');
  res.json(r.rows[0]);
});

module.exports = router;
