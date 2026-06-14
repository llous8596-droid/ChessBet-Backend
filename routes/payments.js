const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const { auth, isAdmin } = require('../middleware/auth');

// ── Frais de traitement répercutés sur le joueur lors d'un dépôt ──
// Couvre approximativement les frais Stripe (≈1.5% + 0.25€ pour les cartes EU).
// Le joueur est crédité du montant qu'il choisit ; le montant facturé est légèrement supérieur.
const DEPOSIT_FEE_PERCENT = parseFloat(process.env.DEPOSIT_FEE_PERCENT || '1.5'); // en %
const DEPOSIT_FEE_FIXED_CENTS = parseInt(process.env.DEPOSIT_FEE_FIXED_CENTS || '25'); // en centimes

function depositChargeCents(creditCents) {
  // montant_facturé = (montant_crédité + frais_fixe) / (1 - frais_pourcentage)
  const charge = (creditCents + DEPOSIT_FEE_FIXED_CENTS) / (1 - DEPOSIT_FEE_PERCENT / 100);
  return Math.ceil(charge);
}

// Créer une session de paiement Stripe
router.post('/deposit', auth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount < 5)  return res.status(400).json({ error: 'Minimum 5€' });
  if (amount > 5000)           return res.status(400).json({ error: 'Maximum 5000€' });

  const creditCents = Math.round(amount * 100);
  const chargeCents = depositChargeCents(creditCents);
  const feeCents    = chargeCents - creditCents;

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
      line_items: [
        { price_data: { currency: 'eur', product_data: { name: `Dépôt ChessBet` }, unit_amount: creditCents }, quantity: 1 },
        { price_data: { currency: 'eur', product_data: { name: `Frais de traitement` }, unit_amount: feeCents }, quantity: 1 },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/deposit-success`,
      cancel_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}/`,
      metadata: { user_id: String(req.user.id), amount_cents: String(creditCents), fee_cents: String(feeCents) },
    });

    await pool.query(
      'INSERT INTO transactions(user_id,type,amount,stripe_id,status) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, 'deposit', creditCents, session.id, 'pending']
    );

    res.json({ url: session.url, creditAmount: creditCents / 100, chargeAmount: chargeCents / 100, feeAmount: feeCents / 100 });
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

// Stats publiques pour le lobby (volume / commissions totales)
router.get('/stats', async (req, res) => {
  const r = await pool.query('SELECT total_commission, total_volume, total_games FROM admin_stats WHERE id=1');
  res.json(r.rows[0]);
});

// Stats admin
router.get('/admin', auth, isAdmin, async (req, res) => {
  const r = await pool.query('SELECT * FROM admin_stats WHERE id=1');
  const u = await pool.query('SELECT COUNT(*) FROM users');
  const w = await pool.query("SELECT * FROM withdrawals WHERE status='pending' ORDER BY created_at DESC");
  res.json({ ...r.rows[0], total_users: parseInt(u.rows[0].count), pending_withdrawals: w.rows });
});

// ── Sauvegarder l'IBAN du joueur ─────────────────────────────
router.post('/iban', auth, async (req, res) => {
  const { iban, iban_name } = req.body;
  if (!iban || !iban_name) return res.status(400).json({ error: 'IBAN et nom requis' });
  // Validation basique IBAN
  const clean = iban.replace(/\s/g, '').toUpperCase();
  if (clean.length < 15 || clean.length > 34) return res.status(400).json({ error: 'IBAN invalide' });
  await pool.query('UPDATE users SET iban=$1, iban_name=$2 WHERE id=$3', [clean, iban_name.trim(), req.user.id]);
  res.json({ ok: true });
});

// ── Demander un retrait ───────────────────────────────────────
router.post('/withdraw', auth, async (req, res) => {
  const { amount } = req.body; // en euros
  const cents = Math.round(parseFloat(amount) * 100);

  if (!cents || cents < 1000) return res.status(400).json({ error: 'Retrait minimum : 10€' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Récupérer le solde et l'IBAN
    const r = await client.query('SELECT balance, iban, iban_name FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const user = r.rows[0];

    if (!user.iban) return res.status(400).json({ error: 'Aucun IBAN enregistré. Ajoute ton IBAN d\'abord.' });
    if (user.balance < cents) return res.status(400).json({ error: 'Solde insuffisant' });

    // Débiter le solde
    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [cents, req.user.id]);

    // Créer la demande de retrait
    const wr = await client.query(
      'INSERT INTO withdrawals(user_id,amount,iban,iban_name,status) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [req.user.id, cents, user.iban, user.iban_name, 'pending']
    );

    // Enregistrer la transaction
    await client.query(
      'INSERT INTO transactions(user_id,type,amount,status,note) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, 'withdrawal', cents, 'pending', `Retrait #${wr.rows[0].id}`]
    );

    await client.query('COMMIT');
    res.json({ ok: true, withdrawal_id: wr.rows[0].id, message: 'Retrait en cours de traitement (1-3 jours ouvrés)' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// ── Liste des retraits du joueur ──────────────────────────────
router.get('/withdrawals', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,amount,iban,status,created_at,processed_at FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json(r.rows);
});

// ── Admin : approuver un retrait ──────────────────────────────
router.post('/withdraw/approve/:id', auth, isAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "UPDATE withdrawals SET status='approved', processed_at=NOW() WHERE id=$1",
      [id]
    );
    await client.query(
      "UPDATE transactions SET status='completed' WHERE note=$1",
      [`Retrait #${id}`]
    );
    await client.query('UPDATE admin_stats SET total_withdrawn=total_withdrawn+(SELECT amount FROM withdrawals WHERE id=$1) WHERE id=1',[id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erreur' });
  } finally { client.release(); }
});

// ── Admin : rejeter un retrait (rembourse le joueur) ──────────
router.post('/withdraw/reject/:id', auth, isAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT user_id,amount FROM withdrawals WHERE id=$1', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Introuvable' });
    const { user_id, amount } = r.rows[0];
    // Rembourser
    await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, user_id]);
    await client.query("UPDATE withdrawals SET status='rejected', processed_at=NOW() WHERE id=$1", [id]);
    await client.query("UPDATE transactions SET status='rejected' WHERE note=$1", [`Retrait #${id}`]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erreur' });
  } finally { client.release(); }
});

module.exports = router;
