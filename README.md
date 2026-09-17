# KoraBoost — paquet de déploiement Render

Ce dossier est une version autonome de KoraBoost prête pour un **Web Service Render** :

- frontend React compilé dans `public/` ;
- API Express compilée dans `server.js` ;
- initialisation idempotente de PostgreSQL dans `db-init.mjs` ;
- configuration Render dans `render.yaml` ;
- variables d’environnement documentées dans `.env.example`.

## Flux client et participants

Tous les comptes peuvent ouvrir le **Panneau client**. Ils y collent le lien
de leur publication Facebook ou TikTok (ce n’est pas un lien de paiement),
choisissent le nombre d’interactions et paient la campagne.

Après confirmation du paiement, la campagne arrive dans la file de
l’administrateur. Les tâches ne sont créées et visibles par les participants
qu’après le bouton **Publier les tâches** dans la console admin. Une campagne
refusée ne produit aucune tâche.

## Déploiement avec Blueprint Render

1. Importez ce dépôt ou ce dossier dans GitHub.
2. Dans Render, choisissez **New > Blueprint** et sélectionnez le dépôt.
3. Créez une base PostgreSQL Render.
4. Renseignez `DATABASE_URL`, `ADMIN_EMAIL` et `PUBLIC_URL` dans les variables du service.
5. Déployez. `npm run db:init` prépare automatiquement les tables avant le démarrage.

Le contrôle de santé est disponible à `/api/healthz`.

## Déploiement manuel

- **Build command :** `npm ci`
- **Pre-deploy command :** `npm run db:init`
- **Start command :** `npm start`

Les paiements SebPay et les notifications Resend restent désactivés tant que leurs variables
correspondantes ne sont pas configurées. Ne commitez jamais les vraies valeurs de secrets.