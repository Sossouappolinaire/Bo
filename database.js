const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { ADMIN_EMAIL, ADMIN_PASSWORD_HASH } = require('./config/admin-bootstrap');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL,
  prenom VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  telephone VARCHAR(30) UNIQUE,
  pays VARCHAR(100) NOT NULL,
  password_hash TEXT NOT NULL,
  auth_provider VARCHAR(20),
  auth_provider_id VARCHAR(255),
  role VARCHAR(10) NOT NULL DEFAULT 'user',
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  balance NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserved NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
  ALTER TABLE users ALTER COLUMN telephone DROP NOT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider_id VARCHAR(255);
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (LOWER(email)) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS users_provider_unique ON users (auth_provider, auth_provider_id) WHERE auth_provider IS NOT NULL AND auth_provider_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  platform VARCHAR(20) NOT NULL,
  link TEXT NOT NULL,
  interaction_type VARCHAR(20) NOT NULL DEFAULT 'like',
  interactions INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  payment_method VARCHAR(20) NOT NULL DEFAULT 'api',
  mf_token VARCHAR(120),
  payment_reference VARCHAR(160),
  sebpay_transaction_id VARCHAR(120),
  link_confirmed_at TIMESTAMPTZ,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  status VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
  admin_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(160);
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20) NOT NULL DEFAULT 'api';
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS payment_provider_link TEXT;
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sebpay_transaction_id VARCHAR(120);
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_confirmed_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS interaction_type VARCHAR(20) NOT NULL DEFAULT 'like';
CREATE TABLE IF NOT EXISTS payment_locks (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  campaign_id INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_locks_expires_at_idx ON payment_locks (expires_at);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES campaigns(id),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  assigned_to INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_submissions (
  id SERIAL PRIMARY KEY,
  task_id INT NOT NULL REFERENCES tasks(id),
  user_id INT NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS proofs (
  id SERIAL PRIMARY KEY,
  submission_id INT NOT NULL REFERENCES task_submissions(id),
  kind VARCHAR(20) NOT NULL,
  image TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  campaign_id INT REFERENCES campaigns(id),
  amount NUMERIC(12,2) NOT NULL,
  mf_token VARCHAR(120),
  status VARCHAR(20) NOT NULL,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  amount NUMERIC(12,2) NOT NULL,
  country VARCHAR(60) NOT NULL,
  country_code VARCHAR(5) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  withdraw_mode VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  mf_token VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  type VARCHAR(30) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_id INT REFERENCES users(id),
  action VARCHAR(60) NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function seedAdmin() {
  const email = ADMIN_EMAIL;
  const tel = (process.env.ADMIN_TELEPHONE || '').trim() || null;
  // Le compte intégré est toujours synchronisé, même si Render ne contient
  // aucune variable ADMIN_EMAIL ou ADMIN_PASSWORD.
  const byEmail = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = $1 ORDER BY id LIMIT 1',
    [email]
  );
  const byRole = byEmail.rowCount ? byEmail : await pool.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
  );
  const password_hash = ADMIN_PASSWORD_HASH;
  if (!byRole.rowCount) {
    await pool.query(
      "INSERT INTO users (nom, prenom, email, telephone, pays, password_hash, role) VALUES ('Sossou', 'Kouamé', $1, $2, 'Bénin', $3, 'admin')",
      [email, tel, password_hash]
    );
    console.log('[init] Compte administrateur créé :', email);
  } else {
    await pool.query(
      'UPDATE users SET email = $1, password_hash = $2, role = $3, status = $4 WHERE id = $5',
      [email, password_hash, 'admin', 'active', byRole.rows[0].id]
    );
  }
}

async function seedTestUsers() {
  if (String(process.env.SEED_TEST_USERS || '').toLowerCase() !== 'true') return;

  const count = 101;
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');
    // Évite les doublons si Render démarre plusieurs instances en même temps.
    await client.query('SELECT pg_advisory_xact_lock($1)', [8142101]);
    for (let i = 1; i <= count; i += 1) {
      const suffix = String(i).padStart(3, '0');
      const email = `seed-user-${suffix}@koraboost.local`;
      const telephone = `229900${String(i).padStart(4, '0')}`;
      const existing = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = $1 OR telephone = $2 LIMIT 1',
        [email, telephone]
      );
      if (existing.rowCount) continue;

      const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      await client.query(
        `INSERT INTO users
          (nom, prenom, email, telephone, pays, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'Bénin', $5, 'user', 'active')`,
        ['Test', 'Utilisateur ' + suffix, email, telephone, passwordHash]
      );
      created += 1;
    }
    await client.query('COMMIT');
    console.log(`[init] Utilisateurs de test : ${created} créé(s), ${count} demandé(s).`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function init() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    const { seedSettings } = require('./config/settings');
    await seedSettings(pool);
    await seedAdmin();
    await seedTestUsers();
    console.log('[init] Base de données prête.');
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
