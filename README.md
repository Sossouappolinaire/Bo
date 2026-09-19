# KoraBoost

Plateforme de tâches sociales et de campagnes Facebook/TikTok, avec récompenses,
retraits SebPay et assistant IA Kora.

## Lancer le projet

```bash
npm install
npm start
```

Le serveur attend une base PostgreSQL dans `DATABASE_URL`. Copier `.env.example`
dans la configuration d'environnement du serveur et renseigner les variables
SebPay et JWT.

## Paiements SebPay

Les campagnes utilisent la collecte SebPay (`POST /api/v1/collections`) avec
`SEBPAY_PUBLIC_KEY` et `SEBPAY_SECRET_KEY`. Le serveur transmet un
`external_reference` unique, puis attend le webhook signé HMAC-SHA256 sur :

```text
https://votre-app.onrender.com/api/sebpay/webhook
```

Après l'approbation du paiement, le navigateur ouvre `success.html`. Cette page
interroge le serveur, affiche le lien Facebook/TikTok enregistré et permet au
client de confirmer ce lien. La confirmation ne remplace pas la validation
administrateur : elle verrouille seulement le lien présenté au client.

Les retraits utilisent également SebPay, avec le webhook :

```text
https://votre-app.onrender.com/api/sebpay/withdrawal-webhook
```

Ne mettez jamais `SEBPAY_SECRET_KEY` dans le navigateur.

## Administrateur

Le compte administrateur est synchronisé au démarrage depuis `ADMIN_EMAIL` et
`ADMIN_PASSWORD`. L'adresse prévue est `sossoukouam@gmail.com` ; renseignez le
mot de passe directement dans les variables secrètes Render, jamais dans le
code. La connexion admin accepte maintenant l'e-mail ou le téléphone.

L'onglet **🩺 Configuration** permet de modifier le prix client d'une tâche
(1 like + 5 commentaires), la récompense versée à l'utilisateur après
validation, les seuils et la clé Groq. Les valeurs par défaut sont **3 FCFA**
facturés par tâche et **2 FCFA** versés à l'utilisateur. La clé Groq reste
stockée côté serveur et n'est jamais affichée en clair.

Le même onglet permet de choisir le mode **Payant** ou **Free**. En mode Free,
le client peut envoyer son lien sans paiement SebPay, aucun numéro Mobile Money
n'est demandé et aucune commission n'est versée aux utilisateurs. Les campagnes
restent soumises à la validation administrateur avant d'être activées.

Pour une campagne payante, l'onglet permet également de choisir entre **API
SebPay** et **Lien SebPay**. En mode API, KoraBoost crée la collecte et reçoit
son statut par webhook. En mode Lien, l'administrateur renseigne son lien de
paiement SebPay ; le client est redirigé vers ce lien, puis revient sur
`success.html`. La page impose trois minutes avant d'autoriser la confirmation
du retour. Cette confirmation passe la campagne en attente de vérification :
l'administrateur doit vérifier le paiement dans SebPay, cliquer sur
**Confirmer paiement** dans la liste des campagnes, puis approuver la campagne.

## Activer l'assistant Groq

Ajouter ces variables dans Render, dans un fichier `.env` local ou dans le
gestionnaire de secrets du serveur :

```env
GROQ_API_KEY=votre_cle_groq
GROQ_MODEL=llama-3.1-8b-instant
```

La clé n'est jamais envoyée au navigateur. Elle peut être initialisée par
`GROQ_API_KEY` ou enregistrée depuis le panneau administrateur ; dans les deux
cas elle est utilisée uniquement côté serveur.

## Vérifier Render après le déploiement

Ouvrir `https://votre-app.onrender.com/api/health`. L'endpoint indique si
PostgreSQL, JWT, l'URL publique, Groq, les paiements SebPay et les règles
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