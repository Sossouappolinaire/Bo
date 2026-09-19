const path = require('path');
const express = require('express');
const { init } = require('./database');
const routes = require('./routes');
const { runtimeErrors } = require('./config/runtime');

const app = express();
app.disable('x-powered-by');

// Securite de base + JSON (preuves image en base64)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({
  limit: '30mb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));

// Pages (fichiers servis individuellement : rien d'autre n'est expose)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/success.html', (req, res) => res.sendFile(path.join(__dirname, 'success.html')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));

app.use('/api', routes);

app.use((req, res) => res.status(404).json({ error: 'Introuvable.' }));
app.use((err, req, res, next) => {
  console.error('[erreur]', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erreur serveur.' });
});

const PORT = parseInt(process.env.PORT || '10000', 10);
const runtimeConfigErrors = runtimeErrors();
if (runtimeConfigErrors.length) {
  console.error('[fatal] Configuration Render invalide :');
  runtimeConfigErrors.forEach(error => console.error(' - ' + error));
  process.exit(1);
}
init()
  .then(() => app.listen(PORT, () => console.log('Serveur démarré sur le port ' + PORT)))
  .catch((e) => { console.error('[fatal] Erreur base de données :', e.message); process.exit(1); });
