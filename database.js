const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

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
  interactions INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
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
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sebpay_transaction_id VARCHAR(120);
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS link_confirmed_at TIMESTAMPTZ;
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
`;

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const tel = (process.env.ADMIN_TELEPHONE || '').trim() || null;
  const pwd = process.env.ADMIN_PASSWORD || '';
  if (!email || !pwd) {
    console.error('[init] ADMIN_EMAIL ou ADMIN_PASSWORD manque : compte administrateur non synchronisé.');
    return;
  }
  const r = await pool.query(
    "SELECT id FROM users WHERE LOWER(email) = $1 OR ($2::text IS NOT NULL AND telephone = $2) OR role = 'admin' ORDER BY id LIMIT 1",
    [email, tel]
  );
  const password_hash = await bcrypt.hash(pwd, 10);
  if (!r.rowCount) {
    await pool.query(
      "INSERT INTO users (nom, prenom, email, telephone, pays, password_hash, role) VALUES ('Sossou', 'Kouamé', $1, $2, 'Bénin', $3, 'admin')",
      [email, tel, password_hash]
    );
    console.log('[init] Compte administrateur créé :', email);
  } else {
    await pool.query(
      'UPDATE users SET email = $1, password_hash = $2, role = $3, status = $4 WHERE id = $5',
      [email, password_hash, 'admin', 'active', r.rows[0].id]
    );
  }
}

async function init() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    await seedAdmin();
    console.log('[init] Base de données prête.');
  } finally {
    client.release();
  }
}

module.exports = { pool, init };
