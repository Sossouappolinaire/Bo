# Guide de mise à jour KoraBoost (Dépôt Bo)

Les deux seules modifications nécessaires par rapport à votre dépôt GitHub **Sossouappolinaire/Bo** sont dans `config/mailer.js` et `routes.js`.

---

## 1. `config/mailer.js`

Ajoutez la fonction `notifyAdminOfPaidCampaign` et exportez-la :

```javascript
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
```

---

## 2. `routes.js`

Ajoutez les deux routes suivantes (juste avant `router.get('/campaigns/mine', ...)`):

```javascript
// Confirmation post-paiement par le client
router.post('/campaigns/:campaignId/success-confirmation', authRequired, h(async (req, res) => {
  const campaignId = Number(req.params.campaignId);
  const { link, email } = req.body || {};
  if (!campaignId || !link || !email) {
    throw httpError(400, "Le lien et l'e-mail sont requis.");
  }

  const campaignRes = await pool.query(
    `SELECT c.id, c.platform, c.link, c.amount, c.payment_status,
            u.prenom || ' ' || u.nom AS customer_name
       FROM campaigns c
       JOIN users u ON u.id = c.user_id
      WHERE c.id = $1 AND c.user_id = $2`,
    [campaignId, req.user.id]
  );
  const campaign = campaignRes.rows[0];
  if (!campaign) throw httpError(404, 'Campagne introuvable.');

  const target = String(campaign.id);
  const existing = await pool.query(
    `SELECT id, detail, created_at
       FROM admin_actions
      WHERE action = 'campaign_success_confirmed' AND target = $1
      ORDER BY id DESC LIMIT 1`,
    [target]
  );

  if (existing.rows[0]) {
    const detail = (existing.rows[0].detail ? JSON.parse(existing.rows[0].detail) : {});
    return res.json({
      id: Number(existing.rows[0].id),
      campaignId: Number(campaign.id),
      link: String(detail.link || campaign.link),
      email: String(detail.email || email),
      notificationSent: Boolean(detail.notificationSent),
      createdAt: new Date(existing.rows[0].created_at).toISOString()
    });
  }

  const detail = {
    campaignId: Number(campaign.id),
    platform: campaign.platform,
    link: String(link).trim(),
    email: String(email).trim().toLowerCase(),
    customerName: campaign.customer_name,
    amount: Number(campaign.amount),
    notificationSent: false
  };

  const inserted = await pool.query(
    `INSERT INTO admin_actions (admin_id, action, target, detail)
     VALUES (NULL, 'campaign_success_confirmed', $1, $2)
     RETURNING id, created_at`,
    [target, JSON.stringify(detail)]
  );

  let notificationSent = false;
  let notificationReason = null;
  try {
    const { notifyAdminOfPaidCampaign } = require('./config/mailer');
    if (typeof notifyAdminOfPaidCampaign === 'function') {
      const notif = await notifyAdminOfPaidCampaign({
        campaignId: detail.campaignId,
        platform: detail.platform,
        link: detail.link,
        customerEmail: detail.email,
        customerName: detail.customerName,
        amount: detail.amount
      });
      notificationSent = Boolean(notif && notif.sent);
      notificationReason = notif && notif.reason;
    }
  } catch (err) {
    notificationReason = err.message;
  }

  await pool.query(
    `UPDATE admin_actions
        SET detail = $1
      WHERE id = $2`,
    [JSON.stringify({ ...detail, notificationSent, notificationReason }), inserted.rows[0].id]
  );

  res.status(201).json({
    id: Number(inserted.rows[0].id),
    campaignId: detail.campaignId,
    link: detail.link,
    email: detail.email,
    notificationSent,
    createdAt: new Date(inserted.rows[0].created_at).toISOString()
  });
}));

// Consultation des confirmations par l'admin
router.get('/admin/campaign-confirmations', adminRequired, h(async (req, res) => {
  const result = await pool.query(
    `SELECT id, target, detail, created_at
       FROM admin_actions
      WHERE action = 'campaign_success_confirmed'
      ORDER BY created_at DESC
      LIMIT 100`
  );

  res.json(result.rows.map((row) => {
    let detail = {};
    try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch (_) {}
    return {
      id: Number(row.id),
      campaignId: Number(row.target),
      platform: String(detail.platform || ''),
      link: String(detail.link || ''),
      email: String(detail.email || ''),
      notificationSent: Boolean(detail.notificationSent),
      createdAt: new Date(row.created_at).toISOString()
    };
  }));
}));
```

---

## 3. GitHub & Render

1. Supprimez le fichier inutile `package-locllllllk.json` sur GitHub.
2. Si vous utilisez Render, le déploiement se relancera automatiquement à chaque push sur la branche `main`.
