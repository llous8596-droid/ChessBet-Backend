const { Pool } = require('pg');

// Parse la DATABASE_URL pour forcer IPv4
// Supabase donne parfois une adresse IPv6 qui ne marche pas sur Render free tier
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Force IPv4
  family: 4,
  // Paramètres de connexion robustes
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(50) UNIQUE NOT NULL,
      email      VARCHAR(255) UNIQUE NOT NULL,
      password   VARCHAR(255) NOT NULL,
      balance    INTEGER DEFAULT 0,
      stripe_customer_id VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
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
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_stats (
      id               INTEGER PRIMARY KEY DEFAULT 1,
      total_commission INTEGER DEFAULT 0,
      total_volume     INTEGER DEFAULT 0,
      total_games      INTEGER DEFAULT 0
    );
    INSERT INTO admin_stats(id) VALUES(1) ON CONFLICT DO NOTHING;
  `);
  console.log('✅ Base de données prête');
}

module.exports = { pool, initDB };
