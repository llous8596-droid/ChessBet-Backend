# ♟ ChessBet — Guide de déploiement complet

Suis ces étapes dans l'ordre. Chaque étape prend 5-10 minutes max.

---

## STRUCTURE DU PROJET

```
chessbet/
├── server.js              ← Serveur principal
├── db.js                  ← Base de données
├── package.json           ← Dépendances Node.js
├── .env.example           ← Modèle variables secrètes
├── middleware/
│   └── auth.js            ← Vérification connexion
├── routes/
│   ├── auth.js            ← Inscription / Connexion
│   └── payments.js        ← Stripe / Dépôts
└── public/
    └── index.html         ← Ton site complet (frontend)
```

---

## ÉTAPE 1 — Créer un compte GitHub (gratuit)

1. Va sur **github.com**
2. Clique "Sign up" → entre ton email, un mot de passe, un pseudo
3. Vérifie ton email
4. Clique "Create a new repository"
5. Nom du repo : `chessbet`
6. Laisse tout par défaut → clique **"Create repository"**

---

## ÉTAPE 2 — Installer GitHub Desktop et uploader les fichiers

1. Va sur **desktop.github.com** → télécharge et installe
2. Connecte-toi avec ton compte GitHub
3. Clique **"Clone a repository"** → sélectionne `chessbet`
4. Choisis un dossier sur ton PC où mettre les fichiers
5. **Copie tous les fichiers du projet** dans ce dossier :
   - `server.js`, `db.js`, `package.json`, `.env.example`
   - Le dossier `middleware/` avec `auth.js`
   - Le dossier `routes/` avec `auth.js` et `payments.js`
   - Le dossier `public/` avec `index.html`
6. Dans GitHub Desktop, tu vois les fichiers apparaître
7. En bas à gauche, écris `premier commit` dans le champ "Summary"
8. Clique **"Commit to main"** puis **"Push origin"**

✅ Tes fichiers sont maintenant sur GitHub.

---

## ÉTAPE 3 — Créer la base de données sur Supabase (gratuit)

1. Va sur **supabase.com** → "Start your project"
2. Connecte-toi avec GitHub
3. Clique **"New project"**
   - Nom : `chessbet`
   - Mot de passe base de données : note-le quelque part !
   - Région : **West EU (Ireland)**
4. Attends 2 minutes que ça se crée
5. Va dans **Settings** (icône engrenage en bas à gauche) → **Database**
6. Descends jusqu'à **"Connection string"** → onglet **"URI"**
7. Copie la ligne qui ressemble à :
   ```
   postgresql://postgres:[TON-MOT-DE-PASSE]@db.xxxx.supabase.co:5432/postgres
   ```
   Remplace `[TON-MOT-DE-PASSE]` par le mot de passe que tu as noté
8. **Garde cette URL, tu en auras besoin à l'étape 5**

---

## ÉTAPE 4 — Créer un compte Stripe (pour les vrais paiements)

1. Va sur **stripe.com** → "Commencer"
2. Entre ton email → crée un mot de passe
3. Vérifie ton email
4. Remplis les infos de ton entreprise (tu peux mettre "Auto-entrepreneur" ou "Particulier")
5. Va dans **Développeurs** (en haut à droite) → **Clés API**
6. Copie la **Clé secrète** (commence par `sk_test_` pour les tests)
7. **Garde cette clé pour l'étape 5**

### Créer le Webhook Stripe :
1. Toujours dans Stripe → **Développeurs** → **Webhooks**
2. Clique **"Ajouter un endpoint"**
3. URL de l'endpoint : `https://chessbet.onrender.com/api/payments/webhook`
   (tu mettras la vraie URL après l'étape 5)
4. Événements : cherche et sélectionne **`checkout.session.completed`**
5. Clique **"Ajouter l'endpoint"**
6. Clique sur ton endpoint → copie le **"Signing secret"** (`whsec_...`)

---

## ÉTAPE 5 — Déployer le serveur sur Render (gratuit)

1. Va sur **render.com** → "Get Started for Free"
2. Connecte-toi avec GitHub
3. Clique **"New +"** → **"Web Service"**
4. Sélectionne ton repo `chessbet`
5. Configure :
   - **Name** : `chessbet`
   - **Runtime** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : Free (pour commencer)
6. Clique **"Advanced"** → **"Add Environment Variable"**
   Ajoute une par une ces variables :

   | Clé | Valeur |
   |-----|--------|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | *(l'URL Supabase de l'étape 3)* |
   | `JWT_SECRET` | *(une phrase longue aléatoire, ex: `monSuperSecretChessbet2024xyz`)* |
   | `STRIPE_SECRET_KEY` | *(ta clé Stripe `sk_test_...`)* |
   | `STRIPE_WEBHOOK_SECRET` | *(le `whsec_...` de Stripe)* |
   | `FRONTEND_URL` | `https://chessbet.onrender.com` |

7. Clique **"Create Web Service"**
8. Attends 3-5 minutes que ça se déploie
9. Render te donne une URL : `https://chessbet.onrender.com`

✅ Ton serveur est en ligne !

---

## ÉTAPE 6 — Mettre à jour l'URL du Webhook Stripe

1. Retourne sur **Stripe** → Développeurs → Webhooks
2. Clique sur ton endpoint → **Modifier**
3. Change l'URL par : `https://chessbet.onrender.com/api/payments/webhook`
4. Sauvegarde

---

## ÉTAPE 7 — Tester que tout marche

1. Va sur `https://chessbet.onrender.com`
2. Tu devrais voir la page de connexion ChessBet
3. Crée un compte → connecte-toi
4. Pour tester un paiement Stripe, utilise la carte de test :
   - Numéro : **4242 4242 4242 4242**
   - Date : n'importe quelle date future (ex: 12/26)
   - CVC : n'importe (ex: 123)

---

## PASSER EN MODE PRODUCTION (vrai argent)

Quand tu veux passer aux vrais paiements :

1. Dans Stripe, complète la vérification d'identité (KYC)
2. Dans Render, change `STRIPE_SECRET_KEY` par ta clé **live** (`sk_live_...`)
3. Recrée un webhook en mode live avec la clé `whsec_` correspondante
4. Mets à jour `STRIPE_WEBHOOK_SECRET` dans Render

---

## EN CAS DE PROBLÈME

### Le site ne charge pas :
→ Dans Render, clique sur ton service → **Logs** → lis les erreurs en rouge

### "Erreur de base de données" :
→ Vérifie que `DATABASE_URL` dans Render est bien l'URL complète avec le mot de passe

### Les paiements ne fonctionnent pas :
→ Vérifie `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` dans Render

### Pour redéployer après une modification :
→ Dans GitHub Desktop : modifie ton fichier → Commit → Push
→ Render redéploie automatiquement en 2-3 minutes

---

## COMMANDES UTILES (si tu utilises le terminal)

```bash
# Installer les dépendances
npm install

# Lancer en local pour tester
node server.js

# Voir les logs en temps réel sur Render
# (dans l'interface Render → Logs)
```

---

## COMBIEN TU VAS GAGNER 💰

```
Exemple : 30 parties/jour à 20€ de mise chacune

Volume journalier : 30 × 40€ = 1 200€/jour
Commission (5%)  : 60€/jour
Commission mensuelle : ~1 800€/mois
Frais Stripe (~1.5%) : ~270€/mois
────────────────────────────────
Bénéfice net       : ~1 530€/mois
```

Plus t'as de joueurs, plus tu gagnes — et toi tu ne joues pas, tu prends juste la commission sur chaque partie.
