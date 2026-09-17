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
async function notifyAdminOfPaidCampaign(input) {
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
  const resendApiKey = (process.env.RESEND_API_KEY || '').trim();

  // Envoi via Resend si configuré
  if (resendApiKey && adminEmail) {
    try {
      const from = (process.env.EMAIL_FROM || '').trim() || 'KoraBoost <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + resendApiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from,
          to: [adminEmail],
          subject: 'KoraBoost — campagne payée #' + input.campaignId + ' à traiter',
          html: '<div style="font-family:sans-serif;padding:20px;background:#f8fafc;color:#1e293b">' +
            '<h2>Nouvelle campagne payée</h2>' +
            '<p>Le client a confirmé les informations suivantes après son paiement :</p>' +
            '<ul>' +
              '<li><strong>Campagne :</strong> #' + input.campaignId + '</li>' +
              '<li><strong>Client :</strong> ' + escapeHtml(input.customerName) + '</li>' +
              '<li><strong>E-mail :</strong> ' + escapeHtml(input.customerEmail) + '</li>' +
              '<li><strong>Montant :</strong> ' + Number(input.amount).toLocaleString('fr-FR') + ' FCFA</li>' +
              '<li><strong>Plateforme :</strong> ' + escapeHtml(input.platform) + '</li>' +
            '</ul>' +
            '<p><strong>Lien :</strong> <a href="' + escapeHtml(input.link) + '">' + escapeHtml(input.link) + '</a></p>' +
          '</div>'
        })
      });
      if (res.ok) return { sent: true, provider: 'resend' };
    } catch (e) {
      console.error('[NOTIF] Erreur Resend:', e.message);
    }
  }

  // Fallback SMTP (Nodemailer)
  if (transporter && adminEmail) {
    try {
      await transporter.sendMail({
        from: mailFrom,
        to: adminEmail,
        subject: 'KoraBoost — Campagne payée #' + input.campaignId,
        text: 'Nouvelle campagne payée #' + input.campaignId + ' par ' + input.customerName + ' (' + input.customerEmail + '). Lien: ' + input.link,
        html: '<div style="font-family:sans-serif;padding:20px;background:#0a0f1e;color:#fff;border-radius:10px">' +
          '<h2 style="color:#56e39f">Nouvelle campagne payée #' + input.campaignId + '</h2>' +
          '<p><strong>Client :</strong> ' + escapeHtml(input.customerName) + ' (' + escapeHtml(input.customerEmail) + ')</p>' +
          '<p><strong>Montant :</strong> ' + Number(input.amount).toLocaleString('fr-FR') + ' FCFA</p>' +
          '<p><strong>Plateforme :</strong> ' + escapeHtml(input.platform) + '</p>' +
          '<p><strong>Lien :</strong> <a style="color:#7c8cff" href="' + escapeHtml(input.link) + '">' + escapeHtml(input.link) + '</a></p>' +
        '</div>'
      });
      return { sent: true, provider: 'smtp' };
    } catch (e) {
      console.error('[NOTIF] Erreur SMTP:', e.message);
    }
  }

  return { sent: false, reason: 'Aucun service email configuré.' };
}

module.exports = {
  notifyAdminOfPaidCampaign,
  configured,
  smtpUser,
  sendWelcomeEmail
};
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
