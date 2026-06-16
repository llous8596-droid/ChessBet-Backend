-- ============================================================
-- AUDIT DES CHANGEMENTS DE SOLDE — ChessBet
-- ============================================================
-- Crée une table de log + un trigger qui enregistre automatiquement
-- CHAQUE changement de balance (qui, quand, ancien/nouveau montant).
-- Permet de vérifier après coup qu'aucun crédit n'a eu lieu sans
-- transaction Stripe correspondante.
--
-- À exécuter une seule fois dans Supabase → SQL Editor.
-- ============================================================

CREATE TABLE IF NOT EXISTS balance_audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  old_balance INTEGER NOT NULL,
  new_balance INTEGER NOT NULL,
  delta       INTEGER NOT NULL,
  changed_at  TIMESTAMP DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION log_balance_change() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.balance != OLD.balance THEN
    INSERT INTO balance_audit_log(user_id, old_balance, new_balance, delta)
    VALUES (NEW.id, OLD.balance, NEW.balance, NEW.balance - OLD.balance);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_balance_audit ON users;
CREATE TRIGGER trg_balance_audit
AFTER UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION log_balance_change();

-- ============================================================
-- Requêtes utiles pour vérifier qu'il n'y a pas de crédit suspect
-- ============================================================

-- Voir tous les changements de solde positifs (crédits) d'un utilisateur,
-- pour vérifier qu'ils correspondent bien à des dépôts/remboursements légitimes :
-- SELECT * FROM balance_audit_log WHERE user_id = <ID> AND delta > 0 ORDER BY changed_at DESC;

-- Détecter des crédits sans dépôt Stripe correspondant dans `transactions` :
-- SELECT bal.* FROM balance_audit_log bal
-- WHERE bal.delta > 0
-- AND NOT EXISTS (
--   SELECT 1 FROM transactions t
--   WHERE t.user_id = bal.user_id
--   AND t.type = 'deposit'
--   AND t.status = 'completed'
--   AND t.amount = bal.delta
--   AND t.created_at BETWEEN bal.changed_at - INTERVAL '2 minutes' AND bal.changed_at + INTERVAL '2 minutes'
-- );
