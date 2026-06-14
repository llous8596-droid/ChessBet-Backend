# Automatiser les retraits avec Stripe Connect

Ce document explique comment transformer le système de retrait actuel
(manuel : tu approuves dans le panel admin et tu fais le virement toi-même)
en un système **automatisé** où Stripe envoie l'argent directement sur le
compte bancaire du joueur.

⚠️ **C'est un chantier important.** Compte plusieurs jours de travail,
des vérifications d'identité (KYC) côté Stripe pour chaque joueur, et des
implications légales (tu deviens une plateforme de paiement / marketplace).
Avant de te lancer, vérifie aussi la conformité légale : un site d'échecs
avec paris en argent réel peut être soumis à une réglementation sur les jeux
d'argent (ANJ en France). Ce document ne couvre que l'aspect technique Stripe.

---

## 1. Le principe : Stripe Connect

Aujourd'hui, ton compte Stripe est le seul compte impliqué (le joueur paie,
toi tu reçois). Avec **Stripe Connect**, chaque joueur a son propre
"compte connecté" (Connected Account), et tu peux lui transférer de l'argent
directement, qui sera ensuite viré sur son compte bancaire par Stripe.

Il existe 3 types de comptes connectés :

- **Standard** : le joueur a un vrai dashboard Stripe, gère lui-même ses infos.
  Trop lourd pour ton cas.
- **Express** : Stripe gère un onboarding simplifié (formulaire hébergé par
  Stripe) où le joueur entre son IBAN + pièce d'identité. **C'est celui-ci
  qu'il faut utiliser.**
- **Custom** : tu gères toute l'UI toi-même (encore plus de travail, à éviter
  au début).

---

## 2. Étapes côté Stripe Dashboard

1. Va sur https://dashboard.stripe.com/connect/overview et active **Connect**.
2. Choisis le type **Express**.
3. Configure ta marque (logo, couleurs) pour l'onboarding Express — c'est ce
   que les joueurs verront.
4. Récupère ta clé secrète habituelle (`STRIPE_SECRET_KEY`), elle sert aussi
   pour Connect.

---

## 3. Flux côté code

### 3.1 Créer un compte connecté pour chaque joueur

Quand un joueur demande un retrait pour la première fois (ou à l'inscription),
crée-lui un compte Express :

```js
const account = await stripe.accounts.create({
  type: 'express',
  country: 'FR',
  email: user.email,
  capabilities: {
    transfers: { requested: true },
  },
});

// Stocke account.id dans ta table users (nouvelle colonne stripe_account_id)
await pool.query('UPDATE users SET stripe_account_id=$1 WHERE id=$2', [account.id, user.id]);
```

### 3.2 Onboarding (le joueur renseigne son IBAN + identité)

Génère un lien d'onboarding hébergé par Stripe et redirige le joueur vers ce
lien (remplace l'actuel champ IBAN custom dans `page-wallet`) :

```js
const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: `${FRONTEND_URL}/wallet`,
  return_url: `${FRONTEND_URL}/wallet`,
  type: 'account_onboarding',
});

res.json({ url: accountLink.url });
```

Le joueur est redirigé vers une page Stripe où il entre son IBAN, son nom,
parfois une pièce d'identité (selon le montant). Une fois terminé, Stripe te
notifie via webhook (`account.updated`) que le compte est `charges_enabled`
et `payouts_enabled`.

### 3.3 Alimenter le solde Stripe Connect (transferts)

Pour transférer de l'argent à un compte connecté, l'argent doit déjà être sur
ton **solde Stripe principal** (ce qui est le cas avec les dépôts par carte).

```js
const transfer = await stripe.transfers.create({
  amount: cents,           // montant en centimes, ce que le joueur retire
  currency: 'eur',
  destination: user.stripe_account_id,
});
```

### 3.4 Le virement vers la banque du joueur (payout)

Par défaut, Stripe verse automatiquement (selon un calendrier, ex: quotidien
ou hebdomadaire) le solde du compte connecté vers l'IBAN du joueur. Tu peux
aussi déclencher un virement immédiat :

```js
await stripe.payouts.create(
  { amount: cents, currency: 'eur' },
  { stripeAccount: user.stripe_account_id }
);
```

---

## 4. Adapter ton code actuel

Remplace la route `/api/payments/withdraw/approve/:id` :

```js
router.post('/withdraw/approve/:id', auth, isAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    const wr = await client.query('SELECT user_id, amount FROM withdrawals WHERE id=$1', [id]);
    const { user_id, amount } = wr.rows[0];
    const u = await client.query('SELECT stripe_account_id FROM users WHERE id=$1', [user_id]);
    const accountId = u.rows[0].stripe_account_id;

    if (!accountId) return res.status(400).json({ error: 'Le joueur n\'a pas configuré son compte de paiement' });

    // 1. Transférer du solde principal vers le compte du joueur
    await stripe.transfers.create({
      amount,
      currency: 'eur',
      destination: accountId,
    });

    // 2. (optionnel) Forcer le virement immédiat vers la banque
    await stripe.payouts.create({ amount, currency: 'eur' }, { stripeAccount: accountId });

    await client.query('BEGIN');
    await client.query("UPDATE withdrawals SET status='approved', processed_at=NOW() WHERE id=$1", [id]);
    await client.query("UPDATE transactions SET status='completed' WHERE note=$1", [`Retrait #${id}`]);
    await client.query('UPDATE admin_stats SET total_withdrawn=total_withdrawn+$1 WHERE id=1', [amount]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Erreur Stripe' });
  } finally { client.release(); }
});
```

Pour une **automatisation complète** (sans validation admin), il suffit
d'appeler cette logique directement depuis la route `/api/payments/withdraw`
au moment de la demande, sans passer par le statut `pending`.

---

## 5. Webhooks à ajouter

Écoute ces événements sur ton endpoint `/api/payments/webhook` :

- `account.updated` → mettre à jour un champ `payouts_enabled` sur l'utilisateur
  (pour savoir s'il peut retirer ou doit d'abord finir l'onboarding)
- `transfer.created` / `payout.paid` / `payout.failed` → mettre à jour le
  statut du retrait (`approved` / `failed`) et notifier le joueur

---

## 6. Frais Stripe Connect

Les transferts internes (`transfers.create`) sont gratuits. Les **payouts**
(virement SEPA vers la banque) ont un coût (généralement faible, ~0.25€-0.5€
selon le pays et la fréquence). Tu peux soit l'absorber, soit le répercuter
sur le joueur comme pour les dépôts (voir `DEPOSIT_FEE_PERCENT`).

---

## 7. Checklist de migration

- [ ] Activer Stripe Connect (mode Express) sur le dashboard
- [ ] Ajouter colonne `stripe_account_id` et `payouts_enabled` sur `users`
- [ ] Route pour générer le lien d'onboarding Express
- [ ] Remplacer le formulaire IBAN custom dans `page-wallet` par un bouton
      "Configurer mes informations de paiement" → redirige vers Stripe
- [ ] Adapter `/api/payments/withdraw` et/ou `/withdraw/approve` pour utiliser
      `transfers` + `payouts`
- [ ] Ajouter les webhooks `account.updated`, `payout.paid`, `payout.failed`
- [ ] Tester en mode test Stripe avec un IBAN de test (`FR1420041010050500013M02606`)
- [ ] Vérifier la conformité légale (jeux d'argent / ANJ en France)
