-- ============================================================
-- RESET COMPLET DES DONNÉES DE TEST — ChessBet
-- ============================================================
-- À exécuter dans Supabase → SQL Editor.
-- Remet tous les soldes à 0, vide les stats globales et l'historique
-- des parties/transactions/retraits. Garde les comptes utilisateurs
-- (username/email/password) pour que tout le monde puisse se reconnecter.
--
-- ⚠️ IRRÉVERSIBLE — fais une sauvegarde si besoin avant de lancer.
-- ============================================================

BEGIN;

-- 1. Remettre tous les soldes à zéro
UPDATE users SET balance = 0;

-- 2. Vider l'historique des parties, transactions et retraits
TRUNCATE TABLE games        RESTART IDENTITY CASCADE;
TRUNCATE TABLE transactions RESTART IDENTITY CASCADE;
TRUNCATE TABLE withdrawals  RESTART IDENTITY CASCADE;

-- 3. Réinitialiser les statistiques globales (volume, commission, etc.)
UPDATE admin_stats SET
  total_commission = 0,
  total_volume     = 0,
  total_games      = 0,
  total_withdrawn  = 0
WHERE id = 1;

-- (Optionnel) Décommente si tu veux aussi réinitialiser les compteurs liés
-- aux commissions retirées par l'admin, si cette colonne existe :
-- UPDATE admin_stats SET total_withdrawn_admin = 0 WHERE id = 1;

COMMIT;

-- Vérification après exécution :
SELECT id, username, balance FROM users ORDER BY id;
SELECT * FROM admin_stats;
