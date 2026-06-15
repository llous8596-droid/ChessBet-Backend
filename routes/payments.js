const router = require('express').Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const { auth, isAdmin } = require('../middleware/auth');

// ── Frais de dépôt (répercutés sur le joueur) ─────────────────
// Tu peux les augmenter depuis les variables d'env dans Render
// ex: DEPOSIT_FEE_PERCENT=5  DEPOSIT_FEE_FIXED_CENTS=50
const DEPOSIT_FEE_PERCENT     = parseFloat(process.env.DEPOSIT_FEE_PERCENT     || '3');    // 3%
const DEPOSIT_FEE_FIXED_CENTS = parseInt(process.env.DEPOSIT_FEE_FIXED_CENTS   || '50');   // 0.50€
const WITHDRAW_MIN_CENTS      = parseInt(process.env.WITHDRAW_MIN_CENTS         || '1000'); // 10€ min

// montant facturé au joueur pour qu'il reçoive exactement creditCents
function depositChargeCents(creditCents) {
  return Math.ceil((creditCents + DEPOSIT_FEE_FIXED_CENTS) / (1 - DEPOSIT_FEE_PERCENT / 100));
}

// ═══════════════════════════════════════════════════════════════
//  DÉPÔT
// ═══════════════════════════════════════════════════════════════
router.post('/deposit', auth, async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (!amount || amount < 5)  return res.status(400).json({ error: 'Minimum 5€' });
  if (amount > 5000)          return res.status(400).json({ error: 'Maximum 5000€' });

  const creditCents = Math.round(amount * 100);
  const chargeCents = depositChargeCents(creditCents);
  const feeCents    = chargeCents - creditCents;

  try {
    const r = await pool.query('SELECT stripe_customer_id,email,username FROM users WHERE id=$1', [req.user.id]);
    const user = r.rows[0];
    let cid = user.stripe_customer_id;

    // Vérifier que le customer existe encore côté Stripe (test vs live)
    if (cid) {
      try { await stripe.customers.retrieve(cid); }
      catch { cid = null; }
    }
    if (!cid) {
      const c = await stripe.customers.create({ email: user.email, name: user.username });
      cid = c.id;
      await pool.query('UPDATE users SET stripe_customer_id=$1 WHERE id=$2', [cid, req.user.id]);
    }

    const lineItems = [
      { price_data: { currency: 'eur', product_data: { name: 'Dépôt ChessBet' }, unit_amount: creditCents }, quantity: 1 },
    ];
    if (feeCents > 0) {
      lineItems.push({ price_data: { currency: 'eur', product_data: { name: 'Frais de traitement' }, unit_amount: feeCents }, quantity: 1 });
    }

    const session = await stripe.checkout.sessions.create({
      customer: cid,
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/?deposit=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/`,
      metadata: {
        user_id:      String(req.user.id),
        credit_cents: String(creditCents),  // ce que le joueur reçoit réellement
      },
    });

    // Enregistré PENDING — le webhook le passera à 'completed'
    await pool.query(
      'INSERT INTO transactions(user_id,type,amount,stripe_id,status) VALUES($1,$2,$3,$4,$5)',
      [req.user.id, 'deposit', creditCents, session.id, 'pending']
    );

    res.json({ url: session.url, creditAmount: creditCents/100, chargeAmount: chargeCents/100, feeAmount: feeCents/100 });
  } catch (e) {
    console.error('Erreur dépôt:', e.message);
    res.status(500).json({ error: e.message || 'Erreur Stripe' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  WEBHOOK STRIPE — Source de vérité absolue
//  Seul endroit où on crédite / débite en réponse à Stripe
// ═══════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
  ].filter(Boolean);

  let event;
  for (const secret of secrets) {
    try { event = stripe.webhooks.constructEvent(req.body, sig, secret); break; }
    catch {}
  }
  if (!event) return res.status(400).send('Webhook: signature invalide');

  // ── Dépôt confirmé ──────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const s      = event.data.object;
    const userId = parseInt(s.metadata.user_id);
    const cents  = parseInt(s.metadata.credit_cents);
    const sid    = s.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Idempotence : ne créditer qu'une seule fois
      const done = await client.query(
        "SELECT id FROM transactions WHERE stripe_id=$1 AND status='completed'", [sid]
      );
      if (!done.rows.length) {
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [cents, userId]);
        await client.query("UPDATE transactions SET status='completed' WHERE stripe_id=$1", [sid]);
        console.log(`✅ Dépôt ${(cents/100).toFixed(2)}€ → user ${userId}`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('Webhook dépôt erreur:', e);
      return res.status(500).end();
    } finally { client.release(); }
  }

  // ── Payout arrivé sur le compte bancaire du joueur ──────────
  if (event.type === 'payout.paid') {
    const payout = event.data.object;
    const wid    = payout.metadata?.withdrawal_id;
    if (wid) {
      await pool.query(
        "UPDATE withdrawals SET status='paid', processed_at=NOW() WHERE id=$1 AND status NOT IN ('paid','failed')",
        [parseInt(wid)]
      ).catch(e => console.error('payout.paid update:', e));
    }
  }

  // ── Payout échoué → rembourser le joueur ───────────────────
  if (event.type === 'payout.failed') {
    const payout = event.data.object;
    const wid    = payout.metadata?.withdrawal_id;
    const uid    = payout.metadata?.user_id;
    if (wid && uid) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Rembourser uniquement si pas déjà failed (idempotence)
        const wr = await client.query(
          "SELECT amount FROM withdrawals WHERE id=$1 AND status NOT IN ('failed','paid') FOR UPDATE",
          [parseInt(wid)]
        );
        if (wr.rows.length) {
          await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [wr.rows[0].amount, parseInt(uid)]);
          await client.query(
            "UPDATE withdrawals SET status='failed', failure_reason=$1, processed_at=NOW() WHERE id=$2",
            [payout.failure_message || 'Payout failed', parseInt(wid)]
          );
        }
        await client.query('COMMIT');
        console.log(`⚠️ Payout #${wid} échoué → remboursé`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('payout.failed remboursement:', e);
      } finally { client.release(); }
    }
  }

  // ── Mise à jour statut compte Connect ──────────────────────
  if (event.type === 'account.updated') {
    const acc = event.data.object;
    await pool.query(
      'UPDATE users SET payouts_enabled=$1 WHERE stripe_account_id=$2',
      [!!acc.payouts_enabled, acc.id]
    ).catch(() => {});
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════
//  STRIPE CONNECT — Onboarding (joueur connecte son compte bancaire)
// ═══════════════════════════════════════════════════════════════
async function getOrCreateConnectAccount(userId) {
  const r    = await pool.query('SELECT stripe_account_id,email,username FROM users WHERE id=$1', [userId]);
  const user = r.rows[0];
  let accId  = user.stripe_account_id;

  if (accId) {
    // Vérifier que le compte existe côté Stripe (peut différer test/live)
    try { await stripe.accounts.retrieve(accId); return accId; }
    catch {
      // Compte introuvable → en recréer un
      accId = null;
      await pool.query('UPDATE users SET stripe_account_id=NULL, payouts_enabled=FALSE WHERE id=$1', [userId]);
    }
  }

  const account = await stripe.accounts.create({
    type:          'express',
    country:       'FR',
    email:         user.email,
    capabilities:  { transfers: { requested: true } },
    business_type: 'individual',
    business_profile: {
      product_description: 'Gains de parties d\'échecs en ligne (ChessBet)',
      url: process.env.FRONTEND_URL || 'https://chessbet-y4ay.onrender.com',
    },
  });

  await pool.query('UPDATE users SET stripe_account_id=$1 WHERE id=$2', [account.id, userId]);
  return account.id;
}

router.post('/connect/onboard', auth, async (req, res) => {
  try {
    const accountId = await getOrCreateConnectAccount(req.user.id);
    const link      = await stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${process.env.FRONTEND_URL}/?connect=refresh`,
      return_url:  `${process.env.FRONTEND_URL}/?connect=success`,
      type:        'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) {
    console.error('Connect onboard:', e.message);
    res.status(500).json({ error: 'Erreur Stripe Connect : ' + e.message });
  }
});

router.get('/connect/status', auth, async (req, res) => {
  try {
    const r    = await pool.query('SELECT stripe_account_id, payouts_enabled FROM users WHERE id=$1', [req.user.id]);
    const user = r.rows[0];
    if (!user.stripe_account_id) return res.json({ configured: false, payouts_enabled: false });

    let account;
    try { account = await stripe.accounts.retrieve(user.stripe_account_id); }
    catch {
      await pool.query('UPDATE users SET stripe_account_id=NULL, payouts_enabled=FALSE WHERE id=$1', [req.user.id]);
      return res.json({ configured: false, payouts_enabled: false });
    }

    const pe = !!account.payouts_enabled;
    if (pe !== user.payouts_enabled)
      await pool.query('UPDATE users SET payouts_enabled=$1 WHERE id=$2', [pe, req.user.id]);

    res.json({
      configured:          true,
      payouts_enabled:     pe,
      details_submitted:   !!account.details_submitted,
      currently_due:       account.requirements?.currently_due       || [],
      pending_verification:account.requirements?.pending_verification || [],
    });
  } catch (e) {
    console.error('Connect status:', e.message);
    res.status(500).json({ error: 'Erreur Stripe' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  RETRAIT AUTOMATIQUE
//  Sécurité :
//  - Verrou FOR UPDATE → pas de double retrait simultané
//  - Contrainte DB CHECK(balance >= 0) → filet de sécurité
//  - Le solde est débité AVANT d'appeler Stripe
//  - En cas d'échec Stripe → remboursement immédiat
//  - En cas d'échec payout ultérieur → remboursement via webhook payout.failed
// ═══════════════════════════════════════════════════════════════
router.post('/withdraw', auth, async (req, res) => {
  const cents = Math.round(parseFloat(req.body.amount) * 100);
  if (!Number.isFinite(cents) || cents < WITHDRAW_MIN_CENTS)
    return res.status(400).json({ error: `Retrait minimum : ${WITHDRAW_MIN_CENTS/100}€` });
  if (cents > 1_000_000)
    return res.status(400).json({ error: 'Retrait maximum : 10 000€' });

  // Vérifier le compte Connect avant de toucher au solde
  const ur = await pool.query(
    'SELECT stripe_account_id, payouts_enabled, balance FROM users WHERE id=$1',
    [req.user.id]
  );
  const userRow = ur.rows[0];

  if (!userRow.stripe_account_id || !userRow.payouts_enabled)
    return res.status(400).json({ error: 'Configure d\'abord tes informations de paiement (bouton "Configurer mon compte bancaire").' });

  // ── Phase 1 : Débiter le solde de manière atomique ──────────
  const client = await pool.connect();
  let withdrawalId;
  try {
    await client.query('BEGIN');

    // FOR UPDATE verrouille la ligne → impossible de lancer 2 retraits en même temps
    const r = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    const currentBalance = r.rows[0].balance;

    if (currentBalance < cents) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Solde insuffisant — tu as ${(currentBalance/100).toFixed(2)}€` });
    }

    // La contrainte CHECK(balance >= 0) bloquera si jamais quelque chose cloche
    await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [cents, req.user.id]);

    const wr = await client.query(
      "INSERT INTO withdrawals(user_id,amount,status) VALUES($1,$2,'pending') RETURNING id",
      [req.user.id, cents]
    );
    withdrawalId = wr.rows[0].id;

    // note est maintenant bien dans la colonne (migration ajoutée dans initDB)
    await client.query(
      "INSERT INTO transactions(user_id,type,amount,status,note) VALUES($1,'withdrawal',$2,'pending',$3)",
      [req.user.id, cents, `Retrait #${withdrawalId}`]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur création retrait:', e.message);
    return res.status(500).json({ error: 'Erreur serveur lors de la création du retrait' });
  } finally { client.release(); }

  // ── Phase 2 : Transfer + Payout Stripe ──────────────────────
  // Si ça échoue ici, on rembourse immédiatement
  try {
    // Transfer : ChessBet → compte Connect du joueur
    const transfer = await stripe.transfers.create({
      amount:         cents,
      currency:       'eur',
      destination:    userRow.stripe_account_id,
      transfer_group: `withdrawal_${withdrawalId}`,
      metadata:       { withdrawal_id: String(withdrawalId), user_id: String(req.user.id) },
    });

    // Payout : compte Connect → compte bancaire du joueur
    // En mode TEST, le payout part immédiatement (Stripe simule)
    // En mode LIVE, délai de 1-2 jours ouvrés selon la banque
    const payout = await stripe.payouts.create(
      {
        amount:   cents,
        currency: 'eur',
        metadata: { withdrawal_id: String(withdrawalId), user_id: String(req.user.id) },
      },
      { stripeAccount: userRow.stripe_account_id }
    );

    // Mettre à jour le retrait avec les IDs Stripe
    await pool.query(
      "UPDATE withdrawals SET status='processing', stripe_transfer_id=$1, stripe_payout_id=$2 WHERE id=$3",
      [transfer.id, payout.id, withdrawalId]
    );
    await pool.query(
      "UPDATE transactions SET status='processing' WHERE note=$1",
      [`Retrait #${withdrawalId}`]
    );
    await pool.query('UPDATE admin_stats SET total_withdrawn=total_withdrawn+$1 WHERE id=1', [cents]);

    console.log(`✅ Retrait #${withdrawalId} — transfer ${transfer.id} — payout ${payout.id}`);
    res.json({
      ok: true,
      withdrawal_id: withdrawalId,
      message: `✓ ${(cents/100).toFixed(2)}€ en route vers ton compte ! Délai : quelques minutes à 2 jours ouvrés.`,
    });

  } catch (stripeErr) {
    // Remboursement immédiat si Stripe échoue
    console.error(`Retrait #${withdrawalId} — Stripe erreur:`, stripeErr.message);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [cents, req.user.id]);
    await pool.query(
      "UPDATE withdrawals SET status='failed', failure_reason=$1, processed_at=NOW() WHERE id=$2",
      [stripeErr.message?.slice(0, 490) || 'Erreur Stripe', withdrawalId]
    );
    await pool.query(
      "UPDATE transactions SET status='failed' WHERE note=$1",
      [`Retrait #${withdrawalId}`]
    );
    res.status(500).json({
      error: `Virement échoué (${stripeErr.message}). Ton solde a été remboursé.`,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTES DIVERSES
// ═══════════════════════════════════════════════════════════════
router.get('/balance', auth, async (req, res) => {
  const r = await pool.query('SELECT balance FROM users WHERE id=$1', [req.user.id]);
  res.json({ balance: r.rows[0].balance });
});

router.get('/history', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT type,amount,status,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [req.user.id]
  );
  res.json(r.rows);
});

router.get('/withdrawals', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id,amount,status,created_at,processed_at,failure_reason FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [req.user.id]
  );
  res.json(r.rows);
});

router.get('/stats', async (req, res) => {
  const r = await pool.query('SELECT total_commission,total_volume,total_games FROM admin_stats WHERE id=1');
  res.json(r.rows[0]);
});

router.get('/admin', auth, isAdmin, async (req, res) => {
  const stats = await pool.query('SELECT * FROM admin_stats WHERE id=1');
  const users = await pool.query('SELECT COUNT(*) FROM users');
  const recent = await pool.query(`
    SELECT w.id,w.amount,w.status,w.created_at,w.failure_reason,u.username,u.email
    FROM withdrawals w JOIN users u ON u.id=w.user_id
    ORDER BY w.created_at DESC LIMIT 30
  `);
  res.json({
    ...stats.rows[0],
    total_users:        parseInt(users.rows[0].count),
    recent_withdrawals: recent.rows,
  });
});

// ═══════════════════════════════════════════════════════════════
//  RETRAIT ADMIN — virement des commissions vers IBAN
// ═══════════════════════════════════════════════════════════════
router.post('/admin/withdraw', auth, isAdmin, async (req, res) => {
  const { iban, amount_cents } = req.body;

  if (!iban || typeof iban !== 'string' || iban.trim().length < 15)
    return res.status(400).json({ error: 'IBAN invalide' });

  // Récupérer les commissions disponibles
  const statsRow = await pool.query('SELECT total_commission, total_withdrawn_admin FROM admin_stats WHERE id=1');
  const stats = statsRow.rows[0];
  const available = parseInt(stats.total_commission) - parseInt(stats.total_withdrawn_admin || 0);

  const cents = amount_cents ? parseInt(amount_cents) : available;
  if (!cents || cents <= 0)
    return res.status(400).json({ error: 'Aucune commission disponible' });
  if (cents > available)
    return res.status(400).json({ error: `Montant demandé (${(cents/100).toFixed(2)}€) supérieur aux commissions disponibles (${(available/100).toFixed(2)}€)` });
  if (cents < 100)
    return res.status(400).json({ error: 'Minimum 1€ pour un virement' });

  try {
    // Créer un bank account token puis un payout Stripe vers l'IBAN
    const bankToken = await stripe.tokens.create({
      bank_account: {
        country:  'FR',
        currency: 'eur',
        account_number: iban.replace(/\s/g, ''),
        account_holder_name: 'ChessBet Admin',
        account_holder_type: 'individual',
      },
    });

    const payout = await stripe.payouts.create({
      amount:   cents,
      currency: 'eur',
      method:   'standard',
      destination: bankToken.id,
      description: `Commissions ChessBet — ${new Date().toLocaleDateString('fr-FR')}`,
      metadata: { type: 'admin_commission', iban_last4: iban.replace(/\s/g,'').slice(-4) },
    });

    // Marquer les commissions comme retirées
    await pool.query(
      'UPDATE admin_stats SET total_withdrawn_admin = COALESCE(total_withdrawn_admin,0) + $1 WHERE id=1',
      [cents]
    );

    console.log(`✅ Retrait admin ${(cents/100).toFixed(2)}€ → IBAN ...${iban.slice(-4)} — payout ${payout.id}`);
    res.json({
      ok: true,
      payout_id: payout.id,
      amount: cents,
      message: `✓ ${(cents/100).toFixed(2)}€ en route vers ton IBAN. Délai : 1-2 jours ouvrés.`,
    });

  } catch (err) {
    console.error('Retrait admin erreur:', err.message);
    res.status(500).json({ error: err.message || 'Erreur Stripe' });
  }
});

module.exports = router;
