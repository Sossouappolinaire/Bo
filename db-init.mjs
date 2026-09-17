import pg from "pg";

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL est obligatoire pour initialiser PostgreSQL.");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  nom VARCHAR(100) NOT NULL,
  prenom VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  telephone VARCHAR(30),
  pays VARCHAR(100) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'user',
  status VARCHAR(12) NOT NULL DEFAULT 'active',
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reserved NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (telephone);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash VARCHAR(128) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  platform VARCHAR(20) NOT NULL,
  link TEXT NOT NULL,
  interactions INTEGER NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  status VARCHAR(24) NOT NULL DEFAULT 'pending_payment',
  payment_mode VARCHAR(20) NOT NULL DEFAULT 'none',
  payment_transaction_id VARCHAR(160),
  payment_url TEXT,
  payment_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  assigned_to INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_submissions (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason TEXT,
  like_proof TEXT NOT NULL,
  comment_proofs JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC(12, 2) NOT NULL,
  country VARCHAR(80) NOT NULL,
  country_code VARCHAR(4) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  operator VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  provider_token VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER REFERENCES campaigns(id),
  withdrawal_id INTEGER REFERENCES withdrawals(id),
  external_reference VARCHAR(160) NOT NULL,
  provider_transaction_id VARCHAR(160),
  type VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type VARCHAR(40) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_configs (
  id SERIAL PRIMARY KEY,
  mode VARCHAR(20) NOT NULL DEFAULT 'none',
  sebpay_base_url TEXT NOT NULL DEFAULT 'https://newapi.sebpay.bj',
  public_key TEXT,
  secret_key_encrypted TEXT,
  payment_link TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES users(id),
  action VARCHAR(60) NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(80) NOT NULL UNIQUE,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
`;

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(schema);
  await client.query(
    "INSERT INTO payment_configs (mode) SELECT 'none' WHERE NOT EXISTS (SELECT 1 FROM payment_configs)",
  );
  await client.query("COMMIT");
  console.log("KoraBoost: schéma PostgreSQL prêt.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}