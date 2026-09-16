const nodemailer = require('nodemailer');

const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPass = String(process.env.SMTP_PASS || '');
const smtpService = String(process.env.SMTP_SERVICE || '').trim();
const smtpHost = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
const smtpPort = Number.parseInt(process.env.SMTP_PORT || '465', 10);
const smtpSecure = String(process.env.SMTP_SECURE || (smtpPort === 465 ? 'true' : 'false')).toLowerCase() === 'true';
const mailFrom = String(process.env.MAIL_FROM || smtpUser).trim();

const configured = Boolean(smtpUser && smtpPass && mailFrom);
const transportOptions = smtpService
  ? { service: smtpService, auth: { user: smtpUser, pass: smtpPass } }
  : {
      host: smtpHost,
      port: Number.isFinite(smtpPort) ? smtpPort : 465,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass }
    };

const transporter = configured ? nodemailer.createTransport(transportOptions) : null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function displayName(user) {
  return [user.prenom, user.nom].filter(Boolean).join(' ').trim() || 'Utilisateur';
}

async function sendWelcomeEmail(user, method = 'inscription') {
  if (!user || !user.email) return { sent: false, reason: 'email_absent' };
  if (!transporter) {
    console.warn('[EMAIL] Bienvenue non envoyé : SMTP non configuré.');
    return { sent: false, reason: 'smtp_non_configure' };
  }

  const name = displayName(user);
  const safeName = escapeHtml(name);
  const safeMethod = escapeHtml(method === 'google' ? 'Google' : method === 'facebook' ? 'Facebook' : 'e-mail');
  const text = [
    `Bonjour ${name},`,
    '',
    'Bienvenue sur KoraBoost ! Votre compte a été créé avec succès.',
    `Inscription via : ${method === 'google' ? 'Google' : method === 'facebook' ? 'Facebook' : 'e-mail'}.`,
    '',
    'Vous pouvez maintenant vous connecter et consulter les campagnes disponibles.',
    '',
    'À bientôt,',
    'L’équipe KoraBoost'
  ].join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0a0f1e;color:#fff;border-radius:14px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#6d5dfc,#3b82f6);padding:28px 32px;text-align:center">
        <h1 style="margin:0;font-size:1.5rem;color:#fff">Bienvenue sur KoraBoost</h1>
      </div>
      <div style="padding:32px">
        <h2 style="color:#a99cff;margin-top:0">Bonjour ${safeName} 👋</h2>
        <p style="color:rgba(255,255,255,.82);font-size:1rem;line-height:1.6">
          Votre compte a été créé avec succès. Vous pouvez maintenant accéder à votre espace KoraBoost.
        </p>
        <div style="background:rgba(255,255,255,.06);border:1px solid rgba(169,156,255,.3);border-radius:10px;padding:18px;margin:20px 0;color:rgba(255,255,255,.8)">
          Inscription via <strong style="color:#fff">${safeMethod}</strong>
        </div>
        <p style="color:rgba(255,255,255,.65);font-size:.9rem;line-height:1.5">
          Ne partagez jamais votre mot de passe ni vos codes de connexion. Pour toute question, contactez l’administrateur depuis votre compte.
        </p>
        <p style="color:#a99cff;font-size:.82rem;margin-bottom:0">L’équipe KoraBoost</p>
      </div>
    </div>`;

  try {
    await transporter.sendMail({
      from: mailFrom,
      to: user.email,
      subject: 'Bienvenue sur KoraBoost',
      text,
      html
    });
    console.log('[EMAIL] Bienvenue envoyé à', user.email);
    return { sent: true };
  } catch (error) {
    console.error('[EMAIL-ERR] Bienvenue non envoyé :', error.message);
    return { sent: false, reason: 'envoi_echoue' };
  }
}

module.exports = {
  configured,
  smtpUser,
  sendWelcomeEmail
};