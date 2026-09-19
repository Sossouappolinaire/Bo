const express = require('express');
const crypto = require('crypto');
const { pool } = require('./database');
const { hash, compare, sign, authRequired, adminRequired, publicUser, parseCookies } = require('./auth');
const { publicUrl } = require('./config/runtime');
const oauth = require('./config/oauth');
const { configured: emailConfigured, sendWelcomeEmail } = require('./config/mailer');
const catalog = require('./config/sebpay-catalog');
const { DEFAULT_SETTINGS, loadSettings } = require('./config/settings');
const { ADMIN_EMAIL } = require('./config/admin-bootstrap');

const router = express.Router();
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

// Les règles sont persistées en base afin que l'administrateur puisse les
// modifier sans redéployer. Les variables d'environnement restent les valeurs
// initiales de secours.
const PUBLIC_URL = publicUrl;
const SEBPAY_API = (process.env.SEBPAY_API_URL || 'https://newapi.sebpay.bj/api/v1').replace(/\/+$/, '');
const SEBPAY_PUBLIC_KEY = process.env.SEBPAY_PUBLIC_KEY || '';
const SEBPAY_SECRET_KEY = process.env.SEBPAY_SECRET_KEY || '';
const SEBPAY_CURRENCY = process.env.SEBPAY_CURRENCY || 'XOF';
const SEBPAY_DEFAULT_OPERATOR = process.env.SEBPAY_DEFAULT_OPERATOR || 'mtn-bj';
const currentSettings = () => loadSettings(pool);
const fallbackSettings = () => ({
  billingMode: DEFAULT_SETTINGS.billing_mode === 'free' ? 'free' : 'paid',
  paymentMethod: DEFAULT_SETTINGS.payment_method === 'link' ? 'link' : 'api',
  sebpayPaymentLink: String(DEFAULT_SETTINGS.sebpay_payment_link || ''),
  taskReward: Number(DEFAULT_SETTINGS.task_reward),
  pricePerInteraction: Number(DEFAULT_SETTINGS.price_per_interaction),
  minCampaignAmount: Number(DEFAULT_SETTINGS.min_campaign_amount),
  minWithdrawal: Number(DEFAULT_SETTINGS.min_withdrawal),
  groqApiKey: String(DEFAULT_SETTINGS.groq_api_key || ''),
  groqModel: String(DEFAULT_SETTINGS.groq_model)
});
const effectiveReward = (settings) => settings.billingMode === 'free' ? 0 : settings.taskReward;
const effectivePrice = (settings) => settings.billingMode === 'free' ? 0 : settings.pricePerInteraction;
const PAYMENT_LOCK_SECONDS = 180;
const PAYMENT_LOCK_ADVISORY_KEY = 8142102;
const isHttpUrl = (value) => {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
};
const paymentLinkFor = (base, params) => {
  const url = new URL(String(base));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
};

const detectPlatform = (link) => {
  const l = (link || '').toLowerCase();
  if (l.includes('tiktok.com') || l.includes('vt.tiktok') || l.includes('vm.tiktok')) return 'tiktok';
  if (l.includes('facebook.com') || l.includes('fb.com') || l.includes('fb.watch') || l.includes('fb.me')) return 'facebook';
  return null;
};

const logAction = (adminId, action, target, detail) =>
  pool.query('INSERT INTO admin_actions (admin_id, action, target, detail) VALUES ($1,$2,$3,$4)',
    [adminId, action, String(target), detail ? String(detail).slice(0, 500) : null]).catch(() => {});

// Le verrou est persistant en PostgreSQL pour rester fiable avec plusieurs
// instances Render. L'advisory lock protège uniquement la transaction de
// création et évite deux paiements simultanés.
async function createPaymentCampaignWithLock({ userId, platform, link, interactionType, amount, paymentMethod, paymentReference }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [PAYMENT_LOCK_ADVISORY_KEY]);
    await client.query('DELETE FROM payment_locks WHERE expires_at <= now()');
    const active = await client.query(
      `SELECT campaign_id, user_id, started_at, expires_at
       FROM payment_locks
       WHERE expires_at > now()
       LIMIT 1`
    );
    if (active.rowCount) {
      await client.query('ROLLBACK');
      const lock = active.rows[0];
      return {
        busy: true,
        sameUser: Number(lock.user_id) === Number(userId),
        campaignId: Number(lock.campaign_id),
        expiresAt: lock.expires_at,
        waitSeconds: Math.max(1, Math.ceil((new Date(lock.expires_at).getTime() - Date.now()) / 1000))
      };
    }

    const inserted = await client.query(
      `INSERT INTO campaigns
        (user_id, platform, link, interaction_type, interactions, amount, payment_method, payment_reference, payment_status, status)
       VALUES ($1,$2,$3,$4,1,$5,$6,$7,'pending','pending_payment')
       RETURNING id`,
      [userId, platform, link, interactionType, amount, paymentMethod, paymentReference]
    );
    const campaignId = inserted.rows[0].id;
    // Une demande de lien représente toujours une seule tâche. Elle reste
    // invisible des exécutants tant que l'administrateur ne l'a pas validée.
    await client.query(
      "INSERT INTO tasks (campaign_id, status) VALUES ($1, 'pending_admin')",
      [campaignId]
    );
    await client.query(
      `INSERT INTO payment_locks (id, campaign_id, user_id, started_at, expires_at)
       VALUES (1, $1, $2, now(), now() + ($3 * interval '1 second'))`,
      [campaignId, userId, PAYMENT_LOCK_SECONDS]
    );
    await client.query('COMMIT');
    return { busy: false, campaignId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const releasePaymentLock = (campaignId) =>
  pool.query('DELETE FROM payment_locks WHERE campaign_id=$1', [campaignId]).catch(() => {});

// Toutes les reponses SebPay sont enveloppees : { success, data, message }
async function sebpayJson(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(SEBPAY_PUBLIC_KEY ? { 'X-Public-Key': SEBPAY_PUBLIC_KEY } : {}),
      ...(SEBPAY_SECRET_KEY ? { 'X-Secret-Key': SEBPAY_SECRET_KEY } : {})
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(endpoint.startsWith('http') ? endpoint : SEBPAY_API + endpoint, opts);
  const envelope = await r.json().catch(() => ({}));
  const wrapped = envelope && typeof envelope === 'object' && envelope.data !== undefined;
  const payload = wrapped ? envelope.data : envelope;
  const success = envelope && envelope.success !== undefined ? Boolean(envelope.success) : r.ok;
  return {
    ok: r.ok && success !== false,
    status: r.status,
    data: (payload && typeof payload === 'object') ? payload : {},
    message: (envelope && envelope.message) || (payload && payload.message) || ''
  };
}

// L'API SebPay documente une réponse enveloppée, mais certaines versions
// renvoient la liste sous data.operators ou data.data. On accepte ces formes
// sans jamais considérer une réponse d'erreur comme une liste live.
function operatorArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['operators', 'data', 'results', 'items']) {
    const found = operatorArray(value[key]);
    if (found.length) return found;
  }
  return [];
}

// Devise par pays : le catalogue fait autorite (zone CEMAC en XAF, CDF, GNF...)
const sebpayCurrencyFor = (countryCode) =>
  catalog.byCode(countryCode) ? catalog.currencyFor(countryCode) : SEBPAY_CURRENCY;

// SebPay renvoie actuellement `country` comme un objet (avec notamment
// `code`/`country_code` et `country_name`). Certaines anciennes réponses
// renvoyaient directement "BJ". On accepte les deux formats afin de ne pas
// retomber silencieusement sur un slug local qui n'est pas configuré chez
// SebPay.
function operatorCountryCode(operator) {
  if (!operator || typeof operator !== 'object') return '';
  const country = operator.country;
  const values = [
    country,
    operator.country_code,
    operator.countryCode,
    operator.iso_code,
    operator.iso
  ];
  for (const value of values) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
      const byName = catalog.codeFromName(text);
      if (byName) return byName;
    }
  }
  if (country && typeof country === 'object') {
    const nestedValues = [
      country.code,
      country.country_code,
      country.countryCode,
      country.iso_code,
      country.iso,
      country.country_name,
      country.name,
      country.label
    ];
    for (const value of nestedValues) {
      if (typeof value !== 'string') continue;
      const text = value.trim();
      if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
      const byName = catalog.codeFromName(text);
      if (byName) return byName;
    }
  }
  return '';
}

function normalizeSebpayOperator(operator) {
  if (!operator || typeof operator !== 'object') return null;
  const slug = String(operator.slug || operator.code || operator.operator || '').trim().toLowerCase();
  if (!slug) return null;
  const documentedSlug = String(operator.api_slug || operator.apiSlug || '').trim().toLowerCase();
  // Certaines réponses live renvoient encore un identifiant localisé
  // (`mobicash-ml`, `moov-bj`, etc.) sans fournir api_slug. SebPay attend
  // alors le slug réseau générique (`mobicash`, `moov`, ...).
  const apiSlug = documentedSlug || slug.replace(/-[a-z]{2}$/, '');
  return {
    ...operator,
    slug,
    country: operatorCountryCode(operator),
    // Les slugs d'affichage historiques (moov-bj, mtn-ci...) ne sont pas
    // ceux attendus par la documentation SebPay (moov, mtn, orange...).
    api_slug: apiSlug
  };
}

// Cache court de GET /operators : la liste LIVE est prioritaire, le catalogue
// local sert uniquement de repli si l'API SebPay est injoignable. `live`
// permet d'éviter d'afficher des opérateurs du catalogue quand SebPay a bien
// répondu mais ne les propose pas pour le compte/pays demandé.
let operatorsCache = { at: 0, list: [], live: false };
async function sebpayOperators() {
  if (Date.now() - operatorsCache.at < 10 * 60 * 1000 && operatorsCache.list.length) return operatorsCache.list;
  const resp = await sebpayJson('GET', '/operators').catch(() => ({ ok: false, data: {} }));
  const rawList = operatorArray(resp.data);
  const list = rawList.map(normalizeSebpayOperator).filter(Boolean);
  if (resp.ok && list.length) {
    operatorsCache = { at: Date.now(), list, live: true };
    return list;
  }
  return operatorsCache.live && operatorsCache.list.length ? operatorsCache.list : catalog.OPERATORS;
}

function sameOperator(o, wanted) {
  const target = String(wanted || '').trim().toLowerCase();
  const candidates = [o && o.slug, o && o.code, o && o.api_slug]
    .filter(Boolean)
    .map(v => String(v).trim().toLowerCase());
  if (candidates.includes(target)) return true;
  // Compatibilité avec l'ancien catalogue local : moov-bj == moov pour BJ.
  return candidates.some(candidate => candidate === target.replace(/-[a-z]{2}$/, ''));
}

async function sebpayOperator(slug) {
  const wanted = String(slug || '').trim().toLowerCase();
  const list = await sebpayOperators().catch(() => catalog.OPERATORS);
  const liveMatch = list.find((o) => sameOperator(o, wanted));
  if (liveMatch) return liveMatch;
  return operatorsCache.live ? null : (catalog.OPERATORS.find((o) => sameOperator(o, wanted)) || null);
}
// Opérateurs d'un pays donné (live si possible, sinon catalogue)
async function sebpayOperatorsByCountry(countryCode) {
  const code = String(countryCode || '').trim().toUpperCase();
  const list = await sebpayOperators().catch(() => catalog.OPERATORS);
  const filtered = list.filter((o) => operatorCountryCode(o) === code);
  return filtered.length ? filtered : (operatorsCache.live ? [] : catalog.operatorsFor(code));
}

// SebPay exige un numero international SANS "+" : on prefixe avec l'indicatif du pays.
function normalizePhone(phone, countryCode) {
  const raw = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (!raw) return '';
  if (!countryCode) return raw;
  return catalog.toInternational(raw, countryCode) || raw;
}

function sebpayCountryCode(countryCode, country) {
  const normalized = String(countryCode || '').trim().toUpperCase();
  if (normalized.length === 2 && catalog.byCode(normalized)) return normalized;
  return catalog.codeFromName(country) || '';
}

function sebpaySignatureIsValid(req) {
  if (!SEBPAY_SECRET_KEY) return false;
  const received = String(req.get('X-SebPay-Signature') || '').trim().toLowerCase();
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = crypto.createHmac('sha256', SEBPAY_SECRET_KEY).update(raw).digest('hex');
  return Boolean(received) && received.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function cookieOptions() {
  return `HttpOnly; Path=/; SameSite=Lax${PUBLIC_URL.startsWith('https://') ? '; Secure' : ''}`;
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `tr_token=${encodeURIComponent(token)}; ${cookieOptions()}`);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `tr_token=; Max-Age=0; ${cookieOptions()}`);
}

function setOAuthState(res, provider, state) {
  res.setHeader('Set-Cookie', `oauth_state_${provider}=${encodeURIComponent(state)}; Max-Age=600; ${cookieOptions()}`);
}

function validOAuthState(req, provider, state) {
  const saved = parseCookies(req.headers.cookie || '')['oauth_state_' + provider];
  return Boolean(saved && state && saved.length === state.length
    && crypto.timingSafeEqual(Buffer.from(saved), Buffer.from(state)));
}

function oauthError(res, message) {
  res.redirect('/?oauth=error&reason=' + encodeURIComponent(message || 'Connexion annulée.'));
}

function socialName(profile) {
  const fullName = String(profile.name || '').trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    prenom: String(profile.given_name || parts.shift() || 'Utilisateur').slice(0, 100),
    nom: String(profile.family_name || parts.join(' ') || 'KoraBoost').slice(0, 100)
  };
}

async function findOrCreateSocialUser(provider, profile) {
  const email = String(profile.email || '').trim().toLowerCase();
  const providerId = String(profile.id || '').trim();
  if (!email || !providerId) throw httpError(400, 'Le fournisseur n’a pas retourné d’adresse e-mail.');
  const names = socialName(profile);
  const found = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = $1 OR (auth_provider = $2 AND auth_provider_id = $3) ORDER BY id LIMIT 1',
    [email, provider, providerId]
  );
  if (found.rowCount) {
    const updated = await pool.query(
      "UPDATE users SET email=$1, auth_provider=$2, auth_provider_id=$3, prenom=COALESCE(NULLIF(prenom, ''), $4), nom=COALESCE(NULLIF(nom, ''), $5) WHERE id=$6 RETURNING *",
      [email, provider, providerId, names.prenom, names.nom, found.rows[0].id]
    );
    return { user: updated.rows[0], created: false };
  }
  const generatedPassword = crypto.randomBytes(32).toString('hex');
  const passwordHash = await hash(generatedPassword);
  const inserted = await pool.query(
    `INSERT INTO users (nom, prenom, email, telephone, pays, password_hash, auth_provider, auth_provider_id)
     VALUES ($1,$2,$3,NULL,'Bénin',$4,$5,$6) RETURNING *`,
    [names.nom, names.prenom, email, passwordHash, provider, providerId]
  );
  return { user: inserted.rows[0], created: true };
}

async function oauthJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw httpError(502, 'Le fournisseur de connexion a refusé la demande.');
  return data;
}

// Confirmation idempotente du paiement d'une campagne -> passage a la validation admin
async function confirmCampaignPayment(campaignId, token, raw) {
  const c = await pool.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (!c.rowCount) return;
  const camp = c.rows[0];
  if (camp.payment_status === 'paid') return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      "UPDATE campaigns SET payment_status='paid', status='pending_admin', mf_token=$2, sebpay_transaction_id=COALESCE($2, sebpay_transaction_id) WHERE id=$1 AND payment_status <> 'paid'",
      [campaignId, token || camp.mf_token]
    );
    if (upd.rowCount) {
      await client.query(
        "INSERT INTO payments (campaign_id, amount, mf_token, status, raw) VALUES ($1,$2,$3,'paid',$4)",
        [campaignId, camp.amount, token || camp.mf_token, JSON.stringify(raw || {})]
      );
      await client.query('DELETE FROM payment_locks WHERE campaign_id=$1', [campaignId]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// ============================ AUTH ============================
router.post('/auth/register', h(async (req, res) => {
  const { nom, prenom, pays, password, confirmation } = req.body || {};
  const email = String((req.body || {}).email || '').trim().toLowerCase() || null;
  const telephone = String((req.body || {}).telephone || '').trim() || null;
  if (!nom || !prenom || !pays || (!telephone && !email) || !password)
    return res.status(400).json({ error: 'Nom, prénom, pays, téléphone ou e-mail et mot de passe sont obligatoires.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Mot de passe : 6 caractères minimum.' });
  if (password !== confirmation) return res.status(400).json({ error: 'Les mots de passe ne correspondent pas.' });
  const exists = await pool.query(
    'SELECT id FROM users WHERE ($1::text IS NOT NULL AND LOWER(email) = $1) OR ($2::text IS NOT NULL AND telephone = $2)',
    [email, telephone]
  );
  if (exists.rowCount) return res.status(409).json({ error: 'Ce numéro de téléphone ou e-mail est déjà utilisé.' });
  const password_hash = await hash(password);
  const r = await pool.query(
    'INSERT INTO users (nom, prenom, email, telephone, pays, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [nom.trim(), prenom.trim(), email, telephone, pays.trim(), password_hash]
  );
  const user = r.rows[0];
  // L'e-mail est une notification : il ne doit jamais bloquer l'inscription.
  void sendWelcomeEmail(user, 'inscription');
  res.json({ token: sign(user), user: publicUser(user) });
}));

router.post('/auth/login', h(async (req, res) => {
  const identifier = String((req.body || {}).identifier || (req.body || {}).telephone || '').trim();
  const { password } = req.body || {};
  const r = await pool.query(
    'SELECT * FROM users WHERE telephone = $1 OR LOWER(email) = LOWER($1) ORDER BY id LIMIT 1',
    [identifier]
  );
  if (!r.rowCount) return res.status(401).json({ error: 'Identifiants incorrects.' });
  const u = r.rows[0];
  if (!(await compare(password || '', u.password_hash))) return res.status(401).json({ error: 'Identifiants incorrects.' });
  if (u.status !== 'active') return res.status(403).json({ error: 'Compte suspendu. Contactez l\'administrateur.' });
  res.json({ token: sign(u), user: publicUser(u) });
}));

router.get('/auth/:provider(google|facebook)', h(async (req, res) => {
  const provider = req.params.provider;
  const settings = oauth[provider];
  const configured = provider === 'google'
    ? settings.clientId && settings.clientSecret
    : settings.appId && settings.appSecret;
  if (!configured) return oauthError(res, provider + ' n’est pas encore configuré.');
  const state = crypto.randomBytes(24).toString('hex');
  setOAuthState(res, provider, state);
  const params = new URLSearchParams({
    client_id: provider === 'google' ? settings.clientId : settings.appId,
    redirect_uri: settings.callbackUrl,
    response_type: 'code',
    state
  });
  if (provider === 'google') params.set('scope', 'openid email profile');
  else {
    params.set('scope', 'email,public_profile');
    params.set('auth_type', 'rerequest');
  }
  const url = provider === 'google'
    ? 'https://accounts.google.com/o/oauth2/v2/auth?' + params
    : 'https://www.facebook.com/v20.0/dialog/oauth?' + params;
  res.redirect(url);
}));

router.get('/auth/:provider(google|facebook)/callback', h(async (req, res) => {
  const provider = req.params.provider;
  const settings = oauth[provider];
  if (req.query.error) return oauthError(res, 'Connexion annulée.');
  if (!validOAuthState(req, provider, req.query.state)) return oauthError(res, 'Vérification de sécurité invalide.');
  if (!req.query.code) return oauthError(res, 'Code de connexion manquant.');

  let profile;
  if (provider === 'google') {
    const tokenData = await oauthJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        redirect_uri: settings.callbackUrl,
        grant_type: 'authorization_code'
      })
    });
    profile = await oauthJson('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenData.access_token }
    });
  } else {
    const tokenParams = new URLSearchParams({
      client_id: settings.appId,
      client_secret: settings.appSecret,
      redirect_uri: settings.callbackUrl,
      code: req.query.code
    });
    const tokenData = await oauthJson('https://graph.facebook.com/v20.0/oauth/access_token?' + tokenParams);
    profile = await oauthJson('https://graph.facebook.com/me?fields=id,name,email&access_token=' + encodeURIComponent(tokenData.access_token));
  }
  const result = await findOrCreateSocialUser(provider, profile);
  const user = result.user;
  if (result.created) void sendWelcomeEmail(user, provider);
  setAuthCookie(res, sign(user));
  res.redirect('/?oauth=success');
}));

router.get('/auth/session', authRequired, h(async (req, res) => {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const token = parseCookies(req.headers.cookie || '').tr_token;
  clearAuthCookie(res);
  res.json({ token: token || null, user: publicUser(r.rows[0]) });
}));

router.get('/auth/me', authRequired, h(async (req, res) => {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const stats = await pool.query(
    `SELECT
      (SELECT count(*) FROM tasks t JOIN campaigns c ON c.id=t.campaign_id
        WHERE t.status='open' AND c.status='active'
        AND NOT EXISTS (SELECT 1 FROM task_submissions s WHERE s.task_id=t.id AND s.user_id=$1))::int AS disponibles,
      (SELECT count(*) FROM task_submissions WHERE user_id=$1 AND status='approved')::int AS validees,
      (SELECT count(*) FROM task_submissions WHERE user_id=$1 AND status='pending')::int AS en_attente,
      (SELECT count(*) FROM task_submissions WHERE user_id=$1 AND status='rejected')::int AS refusees`,
    [req.user.id]
  );
  const settings = await currentSettings();
  res.json({
    user: publicUser(r.rows[0]),
    stats: stats.rows[0],
    rules: { taskReward: effectiveReward(settings), minWithdrawal: settings.minWithdrawal, billingMode: settings.billingMode }
  });
}));

// ===================== META / CAPACITE ========================
router.get('/meta', h(async (req, res) => {
  const settings = await currentSettings();
  res.json({
    billingMode: settings.billingMode,
    paymentMethod: settings.paymentMethod,
    paymentLinkConfigured: Boolean(settings.sebpayPaymentLink),
    taskReward: effectiveReward(settings),
    pricePerInteraction: effectivePrice(settings),
    configuredTaskReward: settings.taskReward,
    configuredPricePerInteraction: settings.pricePerInteraction,
    minCampaignAmount: settings.billingMode === 'free' ? 0 : settings.minCampaignAmount,
    minWithdrawal: settings.minWithdrawal
  });
}));

// ==================== SANTE DU DEPLOIEMENT =====================
const envSet = (value) => typeof value === 'string' && value.trim().length > 0;
const check = (name, configured, status, detail, required = true) => ({
  name, configured, status, detail, required
});

async function deploymentHealth() {
  const settings = await currentSettings().catch(() => fallbackSettings());
  const checks = [];
  const databaseConfigured = envSet(process.env.DATABASE_URL);
  if (!databaseConfigured) {
    checks.push(check('PostgreSQL', false, 'error', 'DATABASE_URL est manquante.'));
  } else {
    try {
      await pool.query('SELECT 1');
      checks.push(check('PostgreSQL', true, 'ok', 'Connexion à la base réussie.'));
    } catch (e) {
      checks.push(check('PostgreSQL', true, 'error', 'DATABASE_URL existe mais la connexion échoue.'));
    }
  }

  const jwtConfigured = envSet(process.env.JWT_SECRET);
  checks.push(check(
    'Sécurité JWT',
    jwtConfigured,
    jwtConfigured && process.env.JWT_SECRET.length >= 32 ? 'ok' : 'error',
    jwtConfigured ? (process.env.JWT_SECRET.length >= 32 ? 'Secret suffisamment long.' : 'JWT_SECRET doit contenir au moins 32 caractères.') : 'JWT_SECRET est manquante.'
  ));

  const adminConfigured = true;
  const adminPasswordStrong = true;
  checks.push(check(
    'Compte administrateur',
    adminConfigured,
    !adminConfigured ? 'error' : (adminPasswordStrong ? 'ok' : 'warning'),
    'Compte administrateur intégré : ' + ADMIN_EMAIL + '.'
  ));

  const publicConfigured = envSet(process.env.PUBLIC_URL) || envSet(process.env.RENDER_EXTERNAL_URL);
  checks.push(check(
    'URL publique',
    publicConfigured,
    publicConfigured ? 'ok' : 'warning',
    publicConfigured ? 'URL automatique Render ou PUBLIC_URL détectée.' : 'PUBLIC_URL est recommandée pour MoneyFusion.'
  ));

  checks.push(check(
    'Assistant Groq',
    settings.groqApiKey.length > 0,
    settings.groqApiKey.length > 0 ? 'ok' : 'warning',
    settings.groqApiKey.length > 0 ? 'Clé détectée, modèle : ' + settings.groqModel : 'Clé Groq manquante : l’assistant restera indisponible.',
    false
  ));
  checks.push(check(
    'Paiements SebPay',
    settings.billingMode === 'free'
      || (settings.paymentMethod === 'link' ? isHttpUrl(settings.sebpayPaymentLink) : Boolean(SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY)),
    settings.billingMode === 'free'
      ? 'ok'
      : (settings.paymentMethod === 'link'
        ? (isHttpUrl(settings.sebpayPaymentLink) ? 'ok' : 'error')
        : (SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY ? 'ok' : 'warning')),
    settings.billingMode === 'free'
      ? 'Mode Free actif : aucun paiement SebPay n’est requis pour les campagnes.'
      : (settings.paymentMethod === 'link'
        ? (isHttpUrl(settings.sebpayPaymentLink)
          ? 'Lien de paiement SebPay configuré.'
          : 'Ajoutez un lien de paiement SebPay valide dans Configuration.')
        : (SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY
          ? 'Clés SebPay détectées.'
          : 'SEBPAY_PUBLIC_KEY et SEBPAY_SECRET_KEY manquent : les campagnes ne pourront pas être payées.')),
    false
  ));
  checks.push(check(
    'Retraits SebPay',
    Boolean(SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY),
    SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY ? 'ok' : 'warning',
    SEBPAY_PUBLIC_KEY && SEBPAY_SECRET_KEY
      ? 'Clés SebPay détectées pour les décaissements.'
      : 'Les clés SebPay manquent : les retraits seront bloqués.',
    false
  ));
  const googleConfigured = envSet(oauth.google.clientId) && envSet(oauth.google.clientSecret);
  checks.push(check(
    'Connexion Google',
    googleConfigured,
    googleConfigured ? 'ok' : 'warning',
    googleConfigured ? 'OAuth Google configuré.' : 'Ajoutez GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET pour activer Google.',
    false
  ));
  const facebookConfigured = envSet(oauth.facebook.appId) && envSet(oauth.facebook.appSecret);
  checks.push(check(
    'Connexion Facebook',
    facebookConfigured,
    facebookConfigured ? 'ok' : 'warning',
    facebookConfigured ? 'OAuth Facebook configuré.' : 'Ajoutez FACEBOOK_APP_ID et FACEBOOK_APP_SECRET pour activer Facebook.',
    false
  ));
  checks.push(check(
    'E-mails de bienvenue',
    emailConfigured,
    emailConfigured ? 'ok' : 'warning',
    emailConfigured
      ? 'SMTP configuré.'
      : 'SMTP_USER et SMTP_PASS manquent : les comptes seront créés sans e-mail de bienvenue.',
    false
  ));

  const rulesValid = Number.isFinite(settings.taskReward) && settings.taskReward > 0
    && Number.isFinite(settings.pricePerInteraction) && settings.pricePerInteraction > 0
    && (settings.billingMode === 'free' || (Number.isFinite(settings.minCampaignAmount) && settings.minCampaignAmount > 0))
    && Number.isFinite(settings.minWithdrawal) && settings.minWithdrawal > 0;
  checks.push(check(
    'Règles métier',
    rulesValid,
    rulesValid ? 'ok' : 'error',
    rulesValid
      ? (settings.billingMode === 'free'
        ? 'Mode Free actif : les campagnes et commissions sont gratuites.'
        : 'Récompense, prix, campagne minimum et retrait minimum sont valides.')
      : 'Un réglage métier est invalide.'
  ));

  const hasError = checks.some(c => c.status === 'error');
  const hasWarning = checks.some(c => c.status === 'warning');
  return {
    status: hasError ? 'error' : (hasWarning ? 'warning' : 'ok'),
    checkedAt: new Date().toISOString(),
    checks
  };
}

// Endpoint utilisable comme health check Render. Il ne renvoie aucune valeur secrète.
router.get('/health', h(async (req, res) => {
  res.json(await deploymentHealth());
}));

// Même diagnostic depuis l'administration, pour vérifier la configuration après connexion.
router.get('/admin/config-status', adminRequired, h(async (req, res) => {
  res.json(await deploymentHealth());
}));

// Réglages modifiables depuis le panneau administrateur. La clé Groq n'est
// jamais renvoyée au navigateur : seule sa présence et une version masquée
// sont affichées.
router.get('/admin/settings', adminRequired, h(async (req, res) => {
  const settings = await currentSettings();
  res.json({
    billingMode: settings.billingMode,
    paymentMethod: settings.paymentMethod,
    sebpayPaymentLink: settings.sebpayPaymentLink,
    taskReward: settings.taskReward,
    pricePerInteraction: settings.pricePerInteraction,
    minCampaignAmount: settings.minCampaignAmount,
    minWithdrawal: settings.minWithdrawal,
    groqModel: settings.groqModel,
    groqConfigured: Boolean(settings.groqApiKey),
    groqKeyMasked: settings.groqApiKey
      ? settings.groqApiKey.slice(0, 5) + '••••••••' + settings.groqApiKey.slice(-4)
      : ''
  });
}));

router.post('/admin/settings', adminRequired, h(async (req, res) => {
  const body = req.body || {};
  const current = await currentSettings();
  const billingMode = String(body.billingMode || '').trim().toLowerCase();
  if (!['paid', 'free'].includes(billingMode))
    return res.status(400).json({ error: 'Choisissez le mode Payant ou Free.' });
  const paymentMethod = body.paymentMethod == null
    ? current.paymentMethod
    : String(body.paymentMethod || '').trim().toLowerCase();
  if (!['api', 'link'].includes(paymentMethod))
    return res.status(400).json({ error: 'Choisissez le paiement par API SebPay ou par lien SebPay.' });
  const sebpayPaymentLink = body.sebpayPaymentLink == null
    ? current.sebpayPaymentLink
    : String(body.sebpayPaymentLink || '').trim();
  if (paymentMethod === 'link' && !isHttpUrl(sebpayPaymentLink))
    return res.status(400).json({ error: 'Ajoutez un lien de paiement SebPay valide (commençant par http:// ou https://).' });
  const taskReward = Number(body.taskReward);
  const pricePerInteraction = Number(body.pricePerInteraction);
  if (!Number.isFinite(taskReward) || taskReward <= 0 || !Number.isFinite(pricePerInteraction) || pricePerInteraction <= 0)
    return res.status(400).json({ error: 'Les montants doivent être des nombres supérieurs à zéro.' });
  const minCampaignAmount = body.minCampaignAmount == null ? null : Number(body.minCampaignAmount);
  const minWithdrawal = body.minWithdrawal == null ? null : Number(body.minWithdrawal);
  if ((minCampaignAmount != null && (!Number.isFinite(minCampaignAmount) || minCampaignAmount <= 0))
    || (minWithdrawal != null && (!Number.isFinite(minWithdrawal) || minWithdrawal <= 0)))
    return res.status(400).json({ error: 'Les seuils doivent être des nombres supérieurs à zéro.' });

  const updates = [
    ['billing_mode', billingMode],
    ['payment_method', paymentMethod],
    ['sebpay_payment_link', sebpayPaymentLink],
    ['task_reward', taskReward],
    ['price_per_interaction', pricePerInteraction]
  ];
  if (minCampaignAmount != null) updates.push(['min_campaign_amount', minCampaignAmount]);
  if (minWithdrawal != null) updates.push(['min_withdrawal', minWithdrawal]);
  if (body.groqModel && String(body.groqModel).trim()) updates.push(['groq_model', String(body.groqModel).trim().slice(0, 120)]);
  if (body.clearGroqKey === true) updates.push(['groq_api_key', '']);
  else if (typeof body.groqApiKey === 'string' && body.groqApiKey.trim()) updates.push(['groq_api_key', body.groqApiKey.trim()]);

  for (const [key, value] of updates) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, String(value)]
    );
  }
  logAction(req.user.id, 'update_settings', 'app_settings', updates.map(([key]) => key).join(','));
  const settings = await currentSettings();
  res.json({
    ok: true,
    billingMode: settings.billingMode,
    paymentMethod: settings.paymentMethod,
    sebpayPaymentLink: settings.sebpayPaymentLink,
    taskReward: settings.taskReward,
    pricePerInteraction: settings.pricePerInteraction,
    groqConfigured: Boolean(settings.groqApiKey)
  });
}));

// ========================= ASSISTANT IA ========================
router.post('/assistant', h(async (req, res) => {
  const settings = await currentSettings();
  if (!settings.groqApiKey)
    return res.status(503).json({ error: 'Assistant momentanément indisponible : la clé Groq n’est pas configurée.' });

  const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  const messages = incoming
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-8)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1200) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Écrivez une question pour démarrer la conversation.' });

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.groqApiKey },
    body: JSON.stringify({
      model: settings.groqModel,
      temperature: 0.35,
      max_tokens: 280,
      messages: [
        {
          role: 'system',
          content: `Tu es Kora, l'assistant chaleureux et précis de KoraBoost, une plateforme francophone de tâches sociales.
 Réponds toujours en français simple, en 2 à 5 phrases maximum. Aide les utilisateurs à comprendre : inscription, tâches Facebook/TikTok, envoi d'une preuve unique par tâche, validation, solde, retrait minimum de ${settings.minWithdrawal} FCFA, et aide les clients à lancer une campagne.
Ne promets jamais un paiement ou une validation. Ne demande jamais de mot de passe, clé API, code secret ou information bancaire complète. Si la question concerne un dossier précis, demande de contacter l’administrateur depuis les informations de leur compte. Si tu ne sais pas, dis-le clairement et propose l’étape sûre suivante.`
        },
        ...messages
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[groq]', response.status, data && (data.error || data));
    return res.status(502).json({ error: 'L’assistant IA est temporairement indisponible. Réessayez dans un instant.' });
  }
  const answer = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!answer) return res.status(502).json({ error: 'L’assistant n’a pas renvoyé de réponse.' });
  res.json({ answer: String(answer).trim(), model: settings.groqModel });
}));

// Liste des pays disponibles (code ISO, indicatif, devise)
router.get('/sebpay/countries', h(async (req, res) => {
  const live = await sebpayOperators().catch(() => []);
  const available = new Set(live.map(operatorCountryCode).filter(Boolean));
  const list = catalog.COUNTRIES
    .filter((c) => (available.size ? available.has(c.code) : true))
    .map((c) => ({ ...c }));
  res.json({ success: true, data: operatorsCache.live ? list : (list.length ? list : catalog.COUNTRIES) });
}));

// Liste des operateurs d'un pays (slug + otp_required + ussd_code)
router.get('/sebpay/operators', h(async (req, res) => {
  const country = String(req.query.country || '').trim().toUpperCase();
  const list = country ? await sebpayOperatorsByCountry(country) : await sebpayOperators();
  res.json({
    success: true,
    data: list.map((o) => ({
      slug: o.slug,
      name: o.name || o.slug,
      country: operatorCountryCode(o),
      otp_required: Boolean(o.otp_required),
      ussd_code: o.ussd_code || null
    }))
  });
}));

// ========================= CAMPAGNES (CLIENT) =================
router.post('/campaigns', authRequired, h(async (req, res) => {
  const settings = await currentSettings();
  const {
    link, interaction_type: requestedInteractionType, operator, otp_code: otpCode,
    country_code: bodyCountryCode, phone: bodyPhone
  } = req.body || {};
  const platform = detectPlatform(link);
  const interactionType = ['like', 'comment'].includes(String(requestedInteractionType || '').trim().toLowerCase())
    ? String(requestedInteractionType).trim().toLowerCase()
    : 'like';
  // Le nombre de tâches n'est plus fourni par le client : un lien envoyé
  // correspond toujours à une seule tâche.
  const n = 1;
  if (!link || !platform) return res.status(400).json({ error: 'Lien Facebook ou TikTok invalide.' });
  const freeMode = settings.billingMode === 'free';
  const apiPayment = !freeMode && settings.paymentMethod === 'api';
  // Le seuil historique reste appliqué au prix de la demande, mais il ne
  // multiplie jamais le nombre de tâches.
  const amount = freeMode ? 0 : Math.max(settings.pricePerInteraction, settings.minCampaignAmount);
  if (apiPayment && (!SEBPAY_PUBLIC_KEY || !SEBPAY_SECRET_KEY))
    return res.status(500).json({ error: 'Paiement non configuré (clés SebPay manquantes côté serveur).' });

  const me = await pool.query('SELECT nom, prenom, telephone, pays FROM users WHERE id = $1', [req.user.id]);
  const u = me.rows[0];

  // En mode Free, aucun compte Mobile Money n'est nécessaire : le lien est
  // enregistré directement et aucune commission ne sera versée.
  if (freeMode) {
    const freeReference = 'KORABOOST-FREE-' + crypto.randomBytes(8).toString('hex');
    const ins = await pool.query(
      `INSERT INTO campaigns
        (user_id, platform, link, interaction_type, interactions, amount, payment_method, payment_reference, payment_status, status, link_confirmed_at)
       VALUES ($1,$2,$3,$4,1,0,'free',$5,'paid','pending_admin',now()) RETURNING id`,
      [req.user.id, platform, link, interactionType, freeReference]
    );
    const campaignId = ins.rows[0].id;
    await pool.query("INSERT INTO tasks (campaign_id, status) VALUES ($1, 'pending_admin')", [campaignId]);
    return res.json({
      campaignId,
      amount: 0,
      paymentStatus: 'free',
      free: true,
      payUrl: null,
      successUrl: '/success.html?campaign=' + encodeURIComponent(campaignId)
    });
  }

  if (settings.paymentMethod === 'link') {
    if (!isHttpUrl(settings.sebpayPaymentLink))
      return res.status(500).json({ error: 'Le lien de paiement SebPay n’est pas configuré par l’administrateur.' });
    const linkReference = 'KORABOOST-LINK-' + crypto.randomBytes(8).toString('hex');
    const slot = await createPaymentCampaignWithLock({
      userId: req.user.id, platform, link, interactionType, amount,
      paymentMethod: 'link', paymentReference: linkReference
    });
    if (slot.busy) {
      return res.status(409).json({
        error: slot.sameUser
          ? 'Votre paiement est déjà en cours. Retournez sur la page de succès.'
          : 'Veuillez patienter : quelqu’un effectue actuellement un paiement.',
        paymentBusy: true,
        sameUser: slot.sameUser,
        campaignId: slot.sameUser ? slot.campaignId : null,
        lockExpiresAt: slot.expiresAt,
        waitSeconds: slot.waitSeconds
      });
    }
    const campaignId = slot.campaignId;
    const successUrl = PUBLIC_URL + '/success.html?campaign=' + encodeURIComponent(campaignId);
    const payUrl = paymentLinkFor(settings.sebpayPaymentLink, {
      campaign: campaignId,
      amount,
      external_reference: linkReference,
      return_url: successUrl,
      redirect_url: successUrl
    });
    return res.json({
      campaignId,
      amount,
      paymentStatus: 'pending',
      paymentMethod: 'link',
      payUrl,
      successUrl
    });
  }

  // 1) Pays : celui choisi dans le formulaire, sinon celui du profil
  const countryCode = sebpayCountryCode(bodyCountryCode, u.pays);
  if (!countryCode) return res.status(400).json({ error: 'Sélectionnez votre pays avant de payer.' });

  // 2) Opérateur : doit appartenir au pays choisi et venir de la liste live
  const operatorSlug = String(operator || '').trim().toLowerCase();
  if (!operatorSlug) return res.status(400).json({ error: 'Sélectionnez votre réseau Mobile Money.' });
  const countryOperators = await sebpayOperatorsByCountry(countryCode);
  const operatorInfo = countryOperators.find((o) => sameOperator(o, operatorSlug))
    || await sebpayOperator(operatorSlug);
  if (!operatorInfo || operatorCountryCode(operatorInfo) !== countryCode)
    return res.status(400).json({ error: "Ce réseau n'est pas disponible dans le pays sélectionné." });
  const apiOperator = String(operatorInfo.api_slug || operatorInfo.slug).trim().toLowerCase();

  // 3) Numéro : format international sans "+" exigé par SebPay
  const phone = normalizePhone(bodyPhone || u.telephone, countryCode);
  if (!phone) return res.status(400).json({ error: 'Saisissez le numéro Mobile Money qui doit payer.' });

  if (operatorInfo.otp_required && !String(otpCode || '').trim()) {
    return res.status(400).json({
      error: 'Cet opérateur exige un code OTP. Composez ' + (operatorInfo.ussd_code || 'le code USSD de votre opérateur') + ' puis saisissez le code reçu.',
      otpRequired: true,
      ussdCode: operatorInfo.ussd_code || null
    });
  }

  const externalReference = 'KORABOOST-CAMPAIGN-' + crypto.randomBytes(12).toString('hex');
  const slot = await createPaymentCampaignWithLock({
    userId: req.user.id, platform, link, interactionType, amount,
    paymentMethod: 'api', paymentReference: externalReference
  });
  if (slot.busy) {
    return res.status(409).json({
      error: slot.sameUser
        ? 'Votre paiement est déjà en cours. Retournez sur la page de succès.'
        : 'Veuillez patienter : quelqu’un effectue actuellement un paiement.',
      paymentBusy: true,
      sameUser: slot.sameUser,
      campaignId: slot.sameUser ? slot.campaignId : null,
      lockExpiresAt: slot.expiresAt,
      waitSeconds: slot.waitSeconds
    });
  }
  const campaignId = slot.campaignId;

  const resp = await sebpayJson('POST', '/collections', {
    amount,
    currency: sebpayCurrencyFor(countryCode),
    phone,
    operator: apiOperator,
    country: countryCode,
    external_reference: externalReference,
    callback_url: PUBLIC_URL + '/api/sebpay/webhook',
    ...(String(otpCode || '').trim() ? { otp_code: String(otpCode).trim() } : {})
  });
  const payment = resp.data || {};
  if (!resp.ok || !payment.transaction_id) {
    await releasePaymentLock(campaignId);
    await pool.query('DELETE FROM tasks WHERE campaign_id = $1', [campaignId]);
    await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
    const detail = resp.message || payment.message || 'impossible de créer le paiement.';
    return res.status(502).json({
      error: 'SebPay : ' + detail + ' (pays ' + countryCode + ', réseau ' + operatorSlug + ', HTTP ' + resp.status + ')'
    });
  }
  await pool.query(
    'UPDATE campaigns SET mf_token=$2, payment_reference=$3, sebpay_transaction_id=$2, payment_provider_link=$4 WHERE id=$1',
    [campaignId, payment.transaction_id, externalReference, payment.provider_link || null]
  );
  res.json({
    campaignId,
    amount,
    paymentStatus: payment.status || 'pending',
    payUrl: payment.provider_link || null,
    successUrl: '/success.html?campaign=' + encodeURIComponent(campaignId)
  });
}));

// Webhook serveur-a-serveur SebPay (confirmation fiable et signée)
router.post('/sebpay/webhook', h(async (req, res) => {
  if (!sebpaySignatureIsValid(req)) return res.status(401).json({ error: 'Signature SebPay invalide.' });
  const b = req.body || {};
  const reference = String(b.external_reference || '').trim();
  const transactionId = String(b.transaction_id || '').trim();
  const camp = await pool.query(
    'SELECT id FROM campaigns WHERE payment_reference=$1 OR sebpay_transaction_id=$2 LIMIT 1',
    [reference || '__missing__', transactionId || '__missing__']
  );
  if (camp.rowCount && b.status === 'approved') {
    await confirmCampaignPayment(camp.rows[0].id, transactionId || reference, b);
  } else if (camp.rowCount && b.status === 'rejected') {
    await pool.query(
      "UPDATE campaigns SET payment_status='rejected', status='rejected' WHERE id=$1 AND payment_status <> 'paid'",
      [camp.rows[0].id]
    );
    await releasePaymentLock(camp.rows[0].id);
  }
  res.json({ received: true });
}));

router.get('/campaigns/:id/payment-status', authRequired, h(async (req, res) => {
  await pool.query('DELETE FROM payment_locks WHERE expires_at <= now()');
  const r = await pool.query(
    `SELECT c.id, c.platform, c.link, c.amount, c.interactions, c.status, c.payment_status, c.payment_method,
            c.created_at,
            c.link_confirmed_at, c.payment_reference, c.sebpay_transaction_id,
            pl.started_at AS lock_started_at, pl.expires_at AS lock_expires_at,
            (c.payment_reference LIKE 'KORABOOST-FREE-%') AS free
     FROM campaigns c
     LEFT JOIN payment_locks pl ON pl.campaign_id=c.id AND pl.expires_at > now()
     WHERE c.id=$1 AND c.user_id=$2`,
    [req.params.id, req.user.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Campagne introuvable.' });
  const c = r.rows[0];
  res.json({
    ...c,
    amount: Number(c.amount),
    linkConfirmed: Boolean(c.link_confirmed_at),
    lockExpiresAt: c.lock_expires_at || null,
    lockRemainingSeconds: c.lock_expires_at
      ? Math.max(0, Math.ceil((new Date(c.lock_expires_at).getTime() - Date.now()) / 1000))
      : 0
  });
}));

// En mode paiement par lien, le client signale son retour après le délai
// demandé. La campagne devient "claimed" : l'administrateur doit encore
// vérifier le paiement dans SebPay avant de la valider.
router.post('/campaigns/:id/payment-link-confirm', authRequired, h(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM campaigns WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (!r.rowCount) return res.status(404).json({ error: 'Campagne introuvable.' });
  const campaign = r.rows[0];
  if (campaign.payment_method !== 'link')
    return res.status(409).json({ error: 'Cette campagne n’utilise pas le lien de paiement SebPay.' });
  if (campaign.payment_status === 'claimed' || campaign.payment_status === 'paid') {
    return res.json({
      ...campaign,
      amount: Number(campaign.amount),
      linkConfirmed: Boolean(campaign.link_confirmed_at)
    });
  }
  const ageSeconds = Math.floor((Date.now() - new Date(campaign.created_at).getTime()) / 1000);
  if (ageSeconds < 180) {
    return res.status(429).json({
      error: 'Attendez encore ' + (180 - ageSeconds) + ' seconde(s) avant de confirmer.',
      waitSeconds: 180 - ageSeconds
    });
  }
  const claimed = await pool.query(
    `UPDATE campaigns
     SET payment_status='claimed', status='pending_admin',
         link_confirmed_at=COALESCE(link_confirmed_at, now())
     WHERE id=$1 AND user_id=$2 AND payment_method='link' AND payment_status='pending'
     RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!claimed.rowCount) return res.status(409).json({ error: 'Cette campagne a déjà été confirmée ou traitée.' });
  await releasePaymentLock(req.params.id);
  res.json({
    ...claimed.rows[0],
    amount: Number(claimed.rows[0].amount),
    linkConfirmed: true
  });
}));

router.post('/campaigns/:id/confirm-link', authRequired, h(async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns SET link_confirmed_at=COALESCE(link_confirmed_at, now())
     WHERE id=$1 AND user_id=$2 AND payment_status='paid'
     RETURNING id, link, link_confirmed_at`,
    [req.params.id, req.user.id]
  );
  if (!r.rowCount) return res.status(409).json({ error: 'Le paiement doit être confirmé avant de confirmer le lien.' });
  res.json({ ok: true, link: r.rows[0].link, linkConfirmed: true });
}));

router.get('/campaigns/mine', authRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT c.*,
       (SELECT count(*) FROM tasks t WHERE t.campaign_id=c.id AND t.status='approved')::int AS faits
     FROM campaigns c WHERE c.user_id=$1 ORDER BY c.id DESC`,
    [req.user.id]
  );
  res.json(r.rows.map(c => ({
    ...c,
    amount: Number(c.amount),
    free: c.payment_method === 'free',
    linkPayment: c.payment_method === 'link'
  })));
}));

// ========================= TACHES (UTILISATEUR) ===============
router.get('/tasks', authRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT t.id, c.platform, c.link, c.interaction_type, c.id AS campaign_id
     FROM tasks t JOIN campaigns c ON c.id = t.campaign_id
     WHERE t.status='open' AND c.status='active'
       AND NOT EXISTS (SELECT 1 FROM task_submissions s WHERE s.task_id=t.id AND s.user_id=$1)
     ORDER BY t.id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(r.rows);
}));

router.post('/tasks/:id/submit', authRequired, h(async (req, res) => {
  const taskId = parseInt(req.params.id, 10);
  const proofs = Array.isArray((req.body || {}).proofs) ? (req.body || {}).proofs : [];
  if (proofs.length !== 1)
    return res.status(400).json({ error: 'Chaque tâche doit contenir exactement une preuve.' });
  const proof = proofs[0];
  if (!proof || typeof proof.image !== 'string' || !proof.image.startsWith('data:image/'))
    return res.status(400).json({ error: 'La preuve doit être une image valide.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(
      "SELECT t.*, c.status AS cstatus FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.id=$1 FOR UPDATE",
      [taskId]
    );
    if (!t.rowCount) throw httpError(404, 'Tâche introuvable.');
    if (t.rows[0].status !== 'open' || t.rows[0].cstatus !== 'active')
      throw httpError(409, 'Cette tâche est déjà prise ou indisponible.');
    const dup = await client.query(
      "SELECT id FROM task_submissions WHERE task_id=$1 AND user_id=$2 AND status IN ('pending','approved')",
      [taskId, req.user.id]
    );
    if (dup.rowCount) throw httpError(409, 'Preuve déjà envoyée pour cette tâche.');

    const s = await client.query('INSERT INTO task_submissions (task_id, user_id) VALUES ($1,$2) RETURNING id', [taskId, req.user.id]);
    const sid = s.rows[0].id;
    await client.query(
      "INSERT INTO proofs (submission_id, kind, image) VALUES ($1,'proof',$2)",
      [sid, proof.image]
    );
    await client.query("UPDATE tasks SET status='pending', assigned_to=$2 WHERE id=$1", [taskId, req.user.id]);
    await client.query('COMMIT');
    res.json({ ok: true, submissionId: sid });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.get('/tasks/history', authRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT s.id, s.status, s.reason, s.created_at, t.id AS task_id, c.platform, c.link, c.interaction_type, c.id AS campaign_id
     FROM task_submissions s
     JOIN tasks t ON t.id = s.task_id
     JOIN campaigns c ON c.id = t.campaign_id
     WHERE s.user_id = $1 ORDER BY s.id DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(r.rows);
}));

// ========================= RETRAITS ===========================
// Pays + réseaux de retrait : même source que les paiements (live SebPay / catalogue)
router.get('/withdraw/methods', authRequired, h(async (req, res) => {
  const list = await sebpayOperators().catch(() => catalog.OPERATORS);
  const data = catalog.COUNTRIES.map((c) => {
    const ops = list.filter((o) => String(o.country || '').toUpperCase() === c.code);
    const methods = (ops.length ? ops : catalog.operatorsFor(c.code))
      .map((o) => ({ key: o.slug, name: o.name || o.slug }));
    return { country: c.name, code: c.code, dial: c.dial, currency: c.currency, paymentMethods: methods };
  }).filter((c) => c.paymentMethods.length);
  res.json({ success: true, data });
}));

router.post('/withdrawals', authRequired, h(async (req, res) => {
  const settings = await currentSettings();
  const { amount, country, countryCode, phone, withdraw_mode } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt < settings.minWithdrawal)
    return res.status(400).json({ error: 'Retrait impossible. Vous devez avoir au moins ' + settings.minWithdrawal + ' FCFA dans votre solde.' });
  if (!country || !countryCode || !phone || !withdraw_mode)
    return res.status(400).json({ error: 'Pays, numéro et méthode de retrait obligatoires.' });
  if (!SEBPAY_PUBLIC_KEY || !SEBPAY_SECRET_KEY)
    return res.status(500).json({ error: 'Décaissement non configuré (clés SebPay manquantes côté serveur).' });
  const normalizedCountry = sebpayCountryCode(countryCode, country);
  const requestedOperator = String(withdraw_mode).trim().toLowerCase();
  const payoutOperators = await sebpayOperatorsByCountry(normalizedCountry);
  const payoutInfo = payoutOperators.find((o) => sameOperator(o, requestedOperator))
    || await sebpayOperator(requestedOperator);
  if (!normalizedCountry || !payoutInfo || operatorCountryCode(payoutInfo) !== normalizedCountry)
    return res.status(400).json({ error: 'Ce réseau de retrait n’est pas disponible dans le pays sélectionné.' });
  const apiOperator = String(payoutInfo.api_slug || payoutInfo.slug).trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT id, balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
    if (!u.rowCount || Number(u.rows[0].balance) < amt) throw httpError(400, 'Solde insuffisant.');
    await client.query('UPDATE users SET balance = balance - $2, reserved = reserved + $2 WHERE id=$1', [req.user.id, amt]);
    const w = await client.query(
      "INSERT INTO withdrawals (user_id, amount, country, country_code, phone, withdraw_mode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.user.id, amt, country, countryCode, phone, withdraw_mode]
    );
    await client.query("INSERT INTO transactions (user_id, type, amount, ref) VALUES ($1,'withdraw_reserve',$2,$3)",
      [req.user.id, amt, 'retrait #' + w.rows[0].id]);

    const payoutReference = 'KORABOOST-WITHDRAW-' + w.rows[0].id + '-' + crypto.randomBytes(5).toString('hex');
    const payout = await sebpayJson('POST', '/payouts', {
      recipient_name: 'Utilisateur KoraBoost #' + req.user.id,
      phone: normalizePhone(phone, normalizedCountry),
      operator: apiOperator,
      country: normalizedCountry,
      amount: amt,
      currency: sebpayCurrencyFor(normalizedCountry),
      external_reference: payoutReference,
      callback_url: PUBLIC_URL + '/api/sebpay/withdrawal-webhook',
      description: 'Retrait KoraBoost #' + w.rows[0].id
    });
    if (!payout.ok || !payout.data || !payout.data.transaction_id)
      throw httpError(502, 'SebPay : ' + (payout.message || (payout.data && payout.data.message) || 'décaissement refusé.'));
    await client.query('UPDATE withdrawals SET mf_token = $2 WHERE id = $1', [w.rows[0].id, payoutReference]);
    await client.query('COMMIT');
    res.json({ ok: true, withdrawalId: w.rows[0].id, transactionId: payout.data.transaction_id });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

// Webhook de décaissement SebPay
router.post('/sebpay/withdrawal-webhook', h(async (req, res) => {
  if (!sebpaySignatureIsValid(req)) return res.status(401).json({ error: 'Signature SebPay invalide.' });
  const { external_reference: reference, status } = req.body || {};
  if (reference) {
    const w = await pool.query('SELECT * FROM withdrawals WHERE mf_token = $1', [reference]);
    if (w.rowCount && w.rows[0].status === 'pending') {
      const wd = w.rows[0];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (status === 'approved') {
          await client.query("UPDATE withdrawals SET status='success', updated_at=now() WHERE id=$1", [wd.id]);
          await client.query('UPDATE users SET reserved = reserved - $2 WHERE id=$1', [wd.user_id, wd.amount]);
          await client.query("INSERT INTO transactions (user_id, type, amount, ref) VALUES ($1,'withdraw_debit',$2,$3)",
            [wd.user_id, wd.amount, 'retrait #' + wd.id + ' confirmé']);
        } else if (status === 'rejected') {
          await client.query("UPDATE withdrawals SET status='failed', updated_at=now() WHERE id=$1", [wd.id]);
          await client.query('UPDATE users SET reserved = reserved - $2, balance = balance + $2 WHERE id=$1', [wd.user_id, wd.amount]);
          await client.query("INSERT INTO transactions (user_id, type, amount, ref) VALUES ($1,'withdraw_release',$2,$3)",
            [wd.user_id, wd.amount, 'retrait #' + wd.id + ' échoué — fonds recrédités']);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
  }
  res.json({ received: true });
}));

router.get('/withdrawals/mine', authRequired, h(async (req, res) => {
  const r = await pool.query('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json(r.rows.map(w => ({ ...w, amount: Number(w.amount) })));
}));

// ========================= ADMIN ==============================
router.get('/admin/stats', adminRequired, h(async (req, res) => {
  const settings = await currentSettings();
  const r = await pool.query(
    `SELECT
      (SELECT count(*) FROM users WHERE role='user')::int AS utilisateurs,
      (SELECT count(*) FROM users WHERE role='user' AND status='active')::int AS actifs,
      (SELECT count(*) FROM campaigns WHERE status='pending_admin')::int AS campagnes_en_attente,
      (SELECT count(*) FROM campaigns WHERE status='active')::int AS campagnes_actives,
      (SELECT count(*) FROM task_submissions WHERE status='pending')::int AS verifications,
      (SELECT count(*) FROM withdrawals WHERE status='pending')::int AS retraits_en_attente,
      (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='paid')::float AS encaisse,
      (SELECT COALESCE(sum(amount),0) FROM withdrawals WHERE status='success')::float AS decaisse`
  );
  res.json({
    ...r.rows[0],
    capacite: r.rows[0].actifs,
    recompense_tache: effectiveReward(settings),
    billing_mode: settings.billingMode
  });
}));

router.get('/admin/users', adminRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.nom, u.prenom, u.email, u.telephone, u.pays, u.status, u.role, u.balance, u.reserved, u.created_at,
       (SELECT count(*) FROM task_submissions s WHERE s.user_id=u.id AND s.status='approved')::int AS taches_validees
     FROM users u ORDER BY u.id DESC LIMIT 500`
  );
  res.json(r.rows.map(u => ({ ...u, balance: Number(u.balance), reserved: Number(u.reserved) })));
}));

router.post('/admin/users/:id/status', adminRequired, h(async (req, res) => {
  const { action } = req.body || {};
  const status = action === 'suspend' ? 'suspended' : 'active';
  if (parseInt(req.params.id, 10) === req.user.id) return res.status(400).json({ error: 'Impossible de modifier votre propre compte.' });
  const r = await pool.query('UPDATE users SET status=$2 WHERE id=$1 RETURNING id', [req.params.id, status]);
  if (!r.rowCount) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  logAction(req.user.id, action === 'suspend' ? 'suspend_user' : 'activate_user', 'user#' + req.params.id, '');
  res.json({ ok: true });
}));

router.get('/admin/campaigns', adminRequired, h(async (req, res) => {
  const status = ['pending_admin', 'active', 'completed', 'rejected', 'pending_payment'].includes(req.query.status) ? req.query.status : 'pending_admin';
  const r = await pool.query(
    `SELECT c.*, u.nom, u.prenom, u.telephone,
       (SELECT count(*) FROM tasks t WHERE t.campaign_id=c.id AND t.status='approved')::int AS faits,
       (SELECT count(*) FROM tasks t WHERE t.campaign_id=c.id)::int AS task_count
     FROM campaigns c JOIN users u ON u.id=c.user_id
     WHERE c.status=$1 ORDER BY c.id DESC LIMIT 200`,
    [status]
  );
  res.json(r.rows.map(c => ({
    ...c,
    amount: Number(c.amount),
    free: c.payment_method === 'free',
    linkPayment: c.payment_method === 'link'
  })));
}));

router.post('/admin/campaigns/:id/decision', adminRequired, h(async (req, res) => {
  const { approve, note } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const c = await client.query('SELECT * FROM campaigns WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!c.rowCount) throw httpError(404, 'Campagne introuvable.');
    if (c.rows[0].status !== 'pending_admin' || !['paid', 'claimed'].includes(c.rows[0].payment_status))
      throw httpError(409, 'Campagne non payable ou déjà traitée.');
    if (approve && c.rows[0].payment_status !== 'paid')
      throw httpError(409, 'Vérifiez d’abord le paiement SebPay avec le bouton de confirmation.');
    if (approve && !c.rows[0].link_confirmed_at)
      throw httpError(409, 'Le client doit confirmer le lien depuis success.html avant validation.');
    if (approve) {
      await client.query("UPDATE campaigns SET status='active', admin_note=$2 WHERE id=$1", [req.params.id, note || null]);
      // Une approbation ouvre exactement la tâche créée avec le lien. La
      // clause de secours protège aussi les anciennes demandes importées.
      const task = await client.query(
        "UPDATE tasks SET status='open', assigned_to=NULL WHERE campaign_id=$1 AND status='pending_admin' RETURNING id",
        [req.params.id]
      );
      const existingTask = task.rowCount
        ? task
        : await client.query("SELECT id FROM tasks WHERE campaign_id=$1 LIMIT 1", [req.params.id]);
      if (!existingTask.rowCount) {
        await client.query("INSERT INTO tasks (campaign_id, status) VALUES ($1, 'open')", [req.params.id]);
      }
    } else {
      await client.query("UPDATE campaigns SET status='rejected', admin_note=$2 WHERE id=$1", [req.params.id, note || null]);
      await client.query("UPDATE tasks SET status='rejected' WHERE campaign_id=$1 AND status='pending_admin'", [req.params.id]);
    }
    logAction(req.user.id, approve ? 'approve_campaign' : 'reject_campaign', 'campaign#' + req.params.id, note || '');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.post('/admin/campaigns/:id/confirm-payment', adminRequired, h(async (req, res) => {
  const r = await pool.query(
    `UPDATE campaigns
     SET payment_status='paid', status='pending_admin'
     WHERE id=$1 AND payment_method='link' AND payment_status='claimed'
     RETURNING id`,
    [req.params.id]
  );
  if (!r.rowCount) return res.status(409).json({ error: 'Cette campagne n’attend pas une confirmation de paiement par lien.' });
  await releasePaymentLock(req.params.id);
  logAction(req.user.id, 'confirm_link_payment', 'campaign#' + req.params.id, 'Paiement vérifié dans SebPay');
  res.json({ ok: true });
}));

router.get('/admin/submissions', adminRequired, h(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const r = await pool.query(
    `SELECT s.id, s.status, s.reason, s.created_at, s.reviewed_at,
            u.nom, u.prenom, u.telephone,
           t.id AS task_id, c.id AS campaign_id, c.platform, c.link, c.interaction_type,
            (SELECT count(*) FROM proofs p WHERE p.submission_id=s.id)::int AS proofs
     FROM task_submissions s
     JOIN tasks t ON t.id = s.task_id
     JOIN campaigns c ON c.id = t.campaign_id
     JOIN users u ON u.id = s.user_id
     WHERE s.status = $1 ORDER BY s.id DESC LIMIT 200`,
    [status]
  );
  res.json(r.rows);
}));

router.get('/admin/submissions/:id', adminRequired, h(async (req, res) => {
  const s = await pool.query(
    `SELECT s.*, u.nom, u.prenom, u.telephone, t.id AS task_id, c.id AS campaign_id, c.platform, c.link, c.interaction_type
     FROM task_submissions s
     JOIN tasks t ON t.id = s.task_id
     JOIN campaigns c ON c.id = t.campaign_id
     JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [req.params.id]
  );
  if (!s.rowCount) return res.status(404).json({ error: 'Preuve introuvable.' });
  const proofs = await pool.query('SELECT id, kind, image FROM proofs WHERE submission_id=$1 ORDER BY id', [req.params.id]);
  res.json({ submission: s.rows[0], proofs: proofs.rows });
}));

router.post('/admin/submissions/:id/review', adminRequired, h(async (req, res) => {
  const settings = await currentSettings();
  const { approve, reason } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT s.*, t.campaign_id, c.payment_method
       FROM task_submissions s
       JOIN tasks t ON t.id=s.task_id
       JOIN campaigns c ON c.id=t.campaign_id
       WHERE s.id=$1 FOR UPDATE`,
      [req.params.id]
    );
    if (!s.rowCount) throw httpError(404, 'Preuve introuvable.');
    if (s.rows[0].status !== 'pending') throw httpError(409, 'Cette preuve a déjà été traitée.');
    const sub = s.rows[0];
    const reward = sub.payment_method === 'free'
      ? 0
      : effectiveReward(settings);
    if (approve) {
      await client.query("UPDATE task_submissions SET status='approved', reviewed_at=now() WHERE id=$1", [sub.id]);
      await client.query("UPDATE tasks SET status='approved' WHERE id=$1", [sub.task_id]);
      if (reward > 0) {
        await client.query('UPDATE users SET balance = balance + $2 WHERE id=$1', [sub.user_id, reward]);
        await client.query("INSERT INTO transactions (user_id, type, amount, ref) VALUES ($1,'reward',$2,$3)",
          [sub.user_id, reward, 'tâche #' + sub.task_id + ' validée']);
      }
      const prog = await pool.query(
        "SELECT c.interactions, (SELECT count(*) FROM tasks WHERE campaign_id=c.id AND status='approved')::int AS faits FROM campaigns c WHERE c.id=$1",
        [sub.campaign_id]
      );
      if (prog.rowCount && prog.rows[0].faits >= prog.rows[0].interactions)
        await client.query("UPDATE campaigns SET status='completed' WHERE id=$1", [sub.campaign_id]);
    } else {
      await client.query("UPDATE task_submissions SET status='rejected', reason=$2, reviewed_at=now() WHERE id=$1",
        [sub.id, reason || 'Preuve refusée']);
      await client.query("UPDATE tasks SET status='open', assigned_to=NULL WHERE id=$1", [sub.task_id]);
    }
    logAction(req.user.id, approve ? 'validate_submission' : 'reject_submission', 'submission#' + sub.id, reason || '');
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

router.get('/admin/withdrawals', adminRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT w.*, u.nom, u.prenom, u.telephone
     FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 200`
  );
  res.json(r.rows.map(w => ({ ...w, amount: Number(w.amount) })));
}));

router.get('/admin/transactions', adminRequired, h(async (req, res) => {
  const r = await pool.query(
    `SELECT t.*, u.nom, u.prenom, u.telephone
     FROM transactions t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 300`
  );
  res.json(r.rows.map(t => ({ ...t, amount: Number(t.amount) })));
}));

module.exports = router;
