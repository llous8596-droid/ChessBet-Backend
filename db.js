const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

async function initDB() {
  // ── Tables principales ──────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                 SERIAL PRIMARY KEY,
      username           VARCHAR(50) UNIQUE NOT NULL,
      email              VARCHAR(255) UNIQUE NOT NULL,
      password           VARCHAR(255) NOT NULL,
      balance            INTEGER DEFAULT 0,
      is_admin           BOOLEAN DEFAULT FALSE,
      stripe_customer_id VARCHAR(255),
      stripe_account_id  VARCHAR(255),
      payouts_enabled    BOOLEAN DEFAULT FALSE,
      created_at         TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS games (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      white_id     INTEGER REFERENCES users(id),
      black_id     INTEGER REFERENCES users(id),
      bet          INTEGER NOT NULL,
      pot          INTEGER NOT NULL,
      time_control INTEGER NOT NULL,
      result       VARCHAR(10),
      reason       VARCHAR(30),
      commission   INTEGER DEFAULT 0,
      winner_id    INTEGER REFERENCES users(id),
      finished     BOOLEAN DEFAULT FALSE,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      type       VARCHAR(20) NOT NULL,
      amount     INTEGER NOT NULL,
      stripe_id  VARCHAR(255),
      status     VARCHAR(20) DEFAULT 'pending',
      note       VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER REFERENCES users(id),
      amount              INTEGER NOT NULL,
      status              VARCHAR(20) DEFAULT 'pending',
      stripe_transfer_id  VARCHAR(255),
      stripe_payout_id    VARCHAR(255),
      failure_reason      VARCHAR(500),
      processed_at        TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admin_stats (
      id               INTEGER PRIMARY KEY DEFAULT 1,
      total_commission INTEGER DEFAULT 0,
      total_volume     INTEGER DEFAULT 0,
      total_games      INTEGER DEFAULT 0,
      total_withdrawn  INTEGER DEFAULT 0
    );

    INSERT INTO admin_stats(id) VALUES(1) ON CONFLICT DO NOTHING;
  `);

  // ── Migrations — colonnes ajoutées progressivement ──────────
  // Ces ALTER TABLE sont idempotents grâce à IF NOT EXISTS
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin          BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS payouts_enabled   BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);

    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note       VARCHAR(255);

    ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS stripe_transfer_id VARCHAR(255);
    ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS stripe_payout_id   VARCHAR(255);
    ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS failure_reason     VARCHAR(500);

    -- Rendre iban/iban_name optionnels (ancienne version les avait NOT NULL)
    ALTER TABLE withdrawals ALTER COLUMN iban     DROP NOT NULL;
    ALTER TABLE withdrawals ALTER COLUMN iban_name DROP NOT NULL;

    ALTER TABLE admin_stats ADD COLUMN IF NOT EXISTS total_withdrawn INTEGER DEFAULT 0;
    ALTER TABLE admin_stats ADD COLUMN IF NOT EXISTS total_withdrawn_admin INTEGER DEFAULT 0;
  `);

  // ── Contrainte anti-solde-négatif (filet de sécurité) ───────
  await pool.query(`UPDATE users SET balance = 0 WHERE balance < 0;`);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'balance_non_negative'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT balance_non_negative CHECK (balance >= 0);
      END IF;
    END $$;
  `);

  console.log('✅ Base de données prête');
}

module.exports = { pool, initDB };
