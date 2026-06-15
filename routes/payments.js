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
    console.error('Erreur dépôt:', e);
    res.status(500).json({ error: e.message || 'Erreur Stripe' });
  }
});

// Webhook Stripe — crédite le compte / gère les retraits Connect
router.post('/webhook', async (req, res) => {
  let event;
  const sig = req.headers['stripe-signature'];
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean);

  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
      break;
    } catch (e) { /* essaie le secret suivant */ }
  }
  if (!event) return res.status(400).send('Webhook Error: signature invalide');

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

  // ── Stripe Connect : statut du compte (onboarding terminé) ──
  if (event.type === 'account.updated') {
    const acc = event.data.object;
    try {
      await pool.query('UPDATE users SET payouts_enabled=$1 WHERE stripe_account_id=$2', [!!acc.payouts_enabled, acc.id]);
      console.log(`ℹ️ Compte Connect ${acc.id} → payouts_enabled=${!!acc.payouts_enabled}`);
    } catch (e) { console.error(e); }
  }

  // ── Stripe Connect : un virement vers la banque du joueur a échoué après coup ──
  if (event.type === 'payout.failed') {
    const payout = event.data.object;
    const withdrawalId = payout.metadata?.withdrawal_id;
    const userId = payout.metadata?.user_id;
    if (withdrawalId && userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Ne rembourser que si pas déjà marqué failed (évite double remboursement)
        const wr = await client.query("SELECT status, amount FROM withdrawals WHERE id=$1 AND status != 'failed'", [withdrawalId]);
        if (wr.rows.length) {
          const { amount } = wr.rows[0];
          await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, userId]);
          await client.query("UPDATE withdrawals SET status='failed', failure_reason=$1 WHERE id=$2", [payout.failure_message || 'Payout failed', withdrawalId]);
          await client.query("UPDATE transactions SET status='failed' WHERE note=$1", [`Retrait #${withdrawalId}`]);
        }
        await client.query('COMMIT');
        console.log(`⚠️ Payout #${withdrawalId} échoué, remboursé`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
      } finally { client.release(); }
    }
  }

  // ── Stripe Connect : le virement est arrivé sur le compte bancaire du joueur ──
  if (event.type === 'payout.paid') {
    const payout = event.data.object;
    const withdrawalId = payout.metadata?.withdrawal_id;
    if (withdrawalId) {
      try {
        await pool.query("UPDATE withdrawals SET status='paid' WHERE id=$1 AND status != 'failed'", [withdrawalId]);
      } catch (e) { console.error(e); }
    }
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
  const w = await pool.query(`
    SELECT w.*, u.username FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY w.created_at DESC LIMIT 20
  `);
  res.json({ ...r.rows[0], total_users: parseInt(u.rows[0].count), recent_withdrawals: w.rows });
});

// ── Stripe Connect : créer/récupérer le compte connecté du joueur ──
async function getOrCreateConnectAccount(userId) {
  const r = await pool.query('SELECT stripe_account_id, email, username FROM users WHERE id=$1', [userId]);
  const user = r.rows[0];
  if (user.stripe_account_id) return user.stripe_account_id;

  const account = await stripe.accounts.create({
    type: 'express',
    country: 'FR',
    email: user.email,
    capabilities: { transfers: { requested: true } },
    business_type: 'individual',
    business_profile: {
      // Décrit l'activité de la plateforme (pas celle du joueur), pour que
      // Stripe ne demande pas de "nom d'entreprise"/"site web" au joueur.
      product_description: 'Gains de parties d\'échecs en ligne (ChessBet)',
      url: process.env.FRONTEND_URL || 'https://chessbet-y4ay.onrender.com',
      mcc: '7995', // Jeux / paris (Betting/Casino Gambling)
    },
  });
  await pool.query('UPDATE users SET stripe_account_id=$1 WHERE id=$2', [account.id, userId]);
  return account.id;
}

// ── Démarrer/continuer l'onboarding Stripe Connect (configuration des infos de paiement) ──
router.post('/connect/onboard', auth, async (req, res) => {
  try {
    const accountId = await getOrCreateConnectAccount(req.user.id);
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/wallet`,
      return_url:  `${process.env.FRONTEND_URL || 'http://localhost:3000'}/wallet`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur Stripe' });
  }
});

// ── Statut du compte de paiement (onboarding terminé ? payouts activés ?) ──
router.get('/connect/status', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT stripe_account_id, payouts_enabled FROM users WHERE id=$1', [req.user.id]);
    const user = r.rows[0];
    if (!user.stripe_account_id) return res.json({ configured: false, payouts_enabled: false });

    // Rafraîchir le statut depuis Stripe (au cas où le webhook n'a pas encore été reçu)
    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    const payoutsEnabled = !!account.payouts_enabled;
    if (payoutsEnabled !== user.payouts_enabled) {
      await pool.query('UPDATE users SET payouts_enabled=$1 WHERE id=$2', [payoutsEnabled, req.user.id]);
    }
    res.json({
      configured: true,
      payouts_enabled: payoutsEnabled,
      details_submitted: !!account.details_submitted,
      currently_due: account.requirements?.currently_due || [],
      pending_verification: account.requirements?.pending_verification || [],
      disabled_reason: account.requirements?.disabled_reason || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur Stripe' });
  }
});

// ── Demander un retrait : automatisé via Stripe Connect ───────
router.post('/withdraw', auth, async (req, res) => {
  const { amount } = req.body; // en euros
  const cents = Math.round(parseFloat(amount) * 100);

  if (!Number.isInteger(cents) || cents < 1000) return res.status(400).json({ error: 'Retrait minimum : 10€' });
  if (cents > 1000000) return res.status(400).json({ error: 'Retrait maximum : 10000€' });

  // 1. Vérifier que le compte de paiement Stripe est configuré et activé
  const ur = await pool.query('SELECT stripe_account_id, payouts_enabled FROM users WHERE id=$1', [req.user.id]);
  const userRow = ur.rows[0];
  if (!userRow.stripe_account_id || !userRow.payouts_enabled) {
    return res.status(400).json({ error: 'Configure d\'abord tes informations de paiement (bouton "Configurer mes infos de paiement").' });
  }

  // 2. Débiter le solde de manière atomique et verrouillée — AUCUN retrait n'est créé si le solde est insuffisant
  const client = await pool.connect();
  let withdrawalId;
  try {
    await client.query('BEGIN');

    const r = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const balance = r.rows[0].balance;

    if (balance < cents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Solde insuffisant' });
    }

    // La contrainte CHECK(balance >= 0) protège en plus contre toute race condition
    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [cents, req.user.id]);

    const wr = await client.query(
      'INSERT INTO withdrawals(user_id,amount,status) VALUES($1,$2,$3) RETURNING id',
      [req.user.id, cents, 'pending']
    );
    withdrawalId = wr.rows[0].id;

    await client.query(
      'INSERT INTO transactions(user_id,type,amount,status,note) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, 'withdrawal', cents, 'pending', `Retrait #${withdrawalId}`]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erreur création retrait:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }

  // 3. Déclencher le transfert + virement Stripe. En cas d'échec, on rembourse intégralement.
  try {
    const transfer = await stripe.transfers.create({
      amount: cents,
      currency: 'eur',
      destination: userRow.stripe_account_id,
      transfer_group: `withdrawal_${withdrawalId}`,
    });

    const payout = await stripe.payouts.create(
      { amount: cents, currency: 'eur', metadata: { withdrawal_id: String(withdrawalId), user_id: String(req.user.id) } },
      { stripeAccount: userRow.stripe_account_id }
    );

    await pool.query(
      "UPDATE withdrawals SET status='approved', processed_at=NOW(), stripe_transfer_id=$1, stripe_payout_id=$2 WHERE id=$3",
      [transfer.id, payout.id, withdrawalId]
    );
    await pool.query("UPDATE transactions SET status='completed' WHERE note=$1", [`Retrait #${withdrawalId}`]);
    await pool.query('UPDATE admin_stats SET total_withdrawn=total_withdrawn+$1 WHERE id=1', [cents]);

    res.json({ ok: true, withdrawal_id: withdrawalId, message: 'Retrait envoyé ! Il arrivera sur ton compte bancaire dans 1-2 jours ouvrés.' });
  } catch (e) {
    console.error('Erreur transfert Stripe, remboursement:', e);
    // Remboursement intégral — le retrait a échoué, l'argent reste dans le solde du joueur
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [cents, req.user.id]);
    await pool.query("UPDATE withdrawals SET status='failed', processed_at=NOW(), failure_reason=$1 WHERE id=$2", [e.message?.slice(0, 250) || 'Erreur Stripe', withdrawalId]);
    await pool.query("UPDATE transactions SET status='failed' WHERE note=$1", [`Retrait #${withdrawalId}`]);
    res.status(500).json({ error: 'Le virement a échoué, ton solde a été remboursé. Réessaie plus tard.' });
  }
});

// ── Liste des retraits du joueur ──────────────────────────────
router.get('/withdrawals', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,amount,status,created_at,processed_at,failure_reason FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json(r.rows);
});

// (Les retraits sont désormais automatisés via Stripe Connect — plus besoin d'approbation manuelle.
//  Voir POST /withdraw qui débite, transfère et paie automatiquement, avec remboursement auto en cas d'échec.)

module.exports = router;
