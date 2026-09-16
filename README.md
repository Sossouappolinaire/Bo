# KoraBoost

Plateforme de tâches sociales et de campagnes Facebook/TikTok, avec récompenses,
retraits MoneyFusion et assistant IA Kora.

## Lancer le projet

```bash
npm install
npm start
```

Le serveur attend une base PostgreSQL dans `DATABASE_URL`. Copier `.env.example`
dans la configuration d'environnement du serveur et renseigner les variables
MoneyFusion et JWT.

## Administrateur

Le compte administrateur est synchronisé au démarrage depuis `ADMIN_EMAIL` et
`ADMIN_PASSWORD`. L'adresse prévue est `sossoukouam@gmail.com` ; renseignez le
mot de passe directement dans les variables secrètes Render, jamais dans le
code. La connexion admin accepte maintenant l'e-mail ou le téléphone.

## Activer l'assistant Groq

Ajouter ces variables dans Render, dans un fichier `.env` local ou dans le
gestionnaire de secrets du serveur :

```env
GROQ_API_KEY=votre_cle_groq
GROQ_MODEL=llama-3.1-8b-instant
```

La clé n'est jamais envoyée au navigateur. `config/ai.js` centralise
l'endpoint, le modèle et la lecture de la variable d'environnement.

## Vérifier Render après le déploiement

Ouvrir `https://votre-app.onrender.com/api/health`. L'endpoint indique si
PostgreSQL, JWT, l'URL publique, Groq, les paiements MoneyFusion et les règles
métier sont `ok`, `warning` ou `error`, sans révéler les valeurs sensibles.
Le même diagnostic est disponible dans l'onglet **🩺 Configuration** de `/admin`.

Un `render.yaml` est inclus : en déployant comme Blueprint, Render génère
automatiquement `JWT_SECRET`, relie PostgreSQL et demande les secrets privés.
`PUBLIC_URL` utilise automatiquement `RENDER_EXTERNAL_URL`. Si un domaine
personnalisé est utilisé, définissez ensuite `PUBLIC_URL` avec ce domaine.

## Inscription Google et Facebook

Les boutons sociaux utilisent OAuth. Renseigner les identifiants de chaque
fournisseur dans Render. Les URL de callback sont calculées automatiquement
depuis `PUBLIC_URL` ou `RENDER_EXTERNAL_URL` :

```text
https://votre-app.onrender.com/api/auth/google/callback
https://votre-app.onrender.com/api/auth/facebook/callback
```

Après la première connexion, le nom et l'e-mail du fournisseur sont enregistrés
dans la base. Un mot de passe aléatoire est haché côté serveur pour le compte
interne ; il n'est jamais affiché ni stocké en clair.

## E-mails de bienvenue

Après une inscription classique ou la première inscription via Google/Facebook,
KoraBoost tente d'envoyer un e-mail de bienvenue. Un échec SMTP ne bloque pas
la création du compte ni la connexion. Si le compte classique est créé avec un
numéro de téléphone sans adresse e-mail, aucun e-mail ne peut être envoyé.

Pour Gmail, activez la validation en deux étapes puis créez un mot de passe
d'application. Dans Render, ajoutez uniquement les variables secrètes
`SMTP_USER`, `SMTP_PASS` et `MAIL_FROM` ; vous pouvez laisser
`SMTP_SERVICE=gmail`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` et
`SMTP_SECURE=true`. Ne commitez jamais le mot de passe d'application.

Les identifiants et mots de passe qui ont été partagés avec l'archive doivent
être considérés comme compromis : révoquez-les et générez de nouvelles valeurs
dans Telegram, Render/PostgreSQL et Google avant de déployer. Le code fourni ne
contient aucune de ces valeurs.

## Identité visuelle

Le site public utilise la marque **KoraBoost**, avec le slogan
« Des interactions qui comptent ». Le bouton ✦ en bas à droite ouvre l'assistant
Kora et les formulaires de captures affichent une progression de lecture/envoi.