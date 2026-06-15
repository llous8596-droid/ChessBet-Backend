-- ============================================================
-- Active RLS sur toutes les tables publiques sans créer de policy.
-- Effet : bloque tout accès via l'API REST Supabase (clé "anon" / "authenticated"),
-- ce qui correspond aux alertes "RLS Disabled in Public" du Security Advisor.
--
-- ⚠️ Ceci NE CASSE PAS ton serveur Express : il se connecte directement à
-- Postgres via DATABASE_URL (rôle "postgres" / connexion directe), qui
-- BYPASS RLS. RLS ne s'applique qu'aux requêtes passant par l'API REST
-- Supabase (PostgREST) avec une clé anon/authenticated.
--
-- À exécuter dans Supabase → SQL Editor.
-- ============================================================

ALTER TABLE public.users        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdrawals   ENABLE ROW LEVEL SECURITY;

-- Aucune policy créée → par défaut, RLS bloque tout accès via anon/authenticated.
-- Ton backend (connexion directe Postgres) continue de fonctionner normalement.

-- ============================================================
-- (Optionnel) Empêcher tout solde négatif au niveau de la base,
-- en complément des vérifications déjà faites côté serveur Express.
-- À ne pas exécuter avant d'avoir corrigé tous les comptes négatifs
-- existants, sinon cette contrainte empêchera l'ALTER de passer.
-- ============================================================
-- ALTER TABLE public.users ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);

