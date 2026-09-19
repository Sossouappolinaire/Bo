const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecret } = require('./config/runtime');

const SECRET = jwtSecret;

const hash = (p) => bcrypt.hash(String(p), 10);
const compare = (p, h) => bcrypt.compare(String(p), h);
const sign = (u) => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' });

function authRequired(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const cookieToken = parseCookies(req.headers.cookie || '').tr_token;
  const authToken = token || cookieToken;
  if (!authToken) return res.status(401).json({ error: 'Connexion requise.' });
  try {
    req.user = jwt.verify(authToken, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expirée, reconnectez-vous.' });
  }
}

function parseCookies(raw) {
  return raw.split(';').reduce((all, pair) => {
    const index = pair.indexOf('=');
    if (index < 0) return all;
    const key = pair.slice(0, index).trim();
    all[key] = decodeURIComponent(pair.slice(index + 1).trim());
    return all;
  }, {});
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis.' });
    next();
  });
}

const publicUser = (u) => ({
  id: u.id, nom: u.nom, prenom: u.prenom, email: u.email, telephone: u.telephone,
  pays: u.pays, role: u.role, status: u.status,
  balance: Number(u.balance), reserved: Number(u.reserved || 0)
});

module.exports = { hash, compare, sign, authRequired, adminRequired, publicUser, parseCookies };
