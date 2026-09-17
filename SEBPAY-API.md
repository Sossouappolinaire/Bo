# Documentation API SebPay

Référence interne de l'API SebPay utilisée par ce projet (`sebpayService.js`).
Base URL : `https://newapi.sebpay.bj/api/v1`

## Authentification

Chaque requête doit inclure deux en-têtes :

| En-tête | Description |
|---|---|
| `X-Public-Key` | Clé publique (`pk_live_...` / `pk_test_...`), identifie le compte, visible côté client. |
| `X-Secret-Key` | Clé secrète (`sk_live_...` / `sk_test_...`), signe/autorise les actions sensibles. **Ne jamais l'exposer côté frontend.** |

Toutes les réponses sont enveloppées ainsi :

```json
{ "success": true, "data": { ... }, "message": "..." }
```

## Collectes (encaissement chez l'expéditeur)

### `POST /collections`

Initie une demande de paiement Mobile Money vers le téléphone d'un client (USSD ou notification à valider).

**Headers** : `X-Public-Key`, `X-Secret-Key`

**Body**

| Champ | Requis | Type | Description |
|---|---|---|---|
| `amount` | oui | numeric | Montant de la transaction |
| `currency` | oui | string | Code devise (XOF, EUR, USD...) |
| `phone` | oui | string | Numéro international sans le `+` |
| `operator` | oui | string | Slug opérateur (`mtn`, `moov`, `orange`, `wave`...) |
| `country` | oui | string | Code ISO pays (`BJ`, `CI`, `SN`...) |
| `external_reference` | oui | string | Identifiant unique côté marchand |
| `callback_url` | non | string | URL de notification du statut final |
| `otp_code` | non | string | Requis pour certains opérateurs (ex. Orange CI/BF/SN) — voir `GET /operators` |

**Réponse** : `transaction_id`, `status` (`pending` généralement), `external_reference`, `amount`, `currency`, `provider_link` (redirection, ex. Wave), `message`.

### `GET /collections/{id_or_reference}`

Récupère le statut d'une collecte (`pending`, `approved`, `rejected`) via l'ID SebPay ou l'`external_reference`.

> Toujours utiliser `callback_url` pour les mises à jour temps réel — ne pas se reposer uniquement sur le polling manuel.

## Payouts (décaissement vers un bénéficiaire)

Le montant total (montant + frais) est débité immédiatement du wallet SebPay lors de l'initiation. En cas d'échec côté agrégateur, le solde est remboursé automatiquement et la transaction passe `rejected`.

### `POST /payouts`

**Body**

| Champ | Requis | Type | Description |
|---|---|---|---|
| `recipient_name` | oui | string | Nom complet du bénéficiaire (max 180 car.) |
| `phone` | oui | string | Numéro international sans `+` |
| `operator` | oui | string | Slug opérateur — voir `GET /operators` |
| `country` | oui | string | Code ISO pays du destinataire |
| `amount` | oui | numeric | Montant reçu par le bénéficiaire |
| `currency` | oui | string | Code devise (3 caractères) |
| `external_reference` | oui | string | Identifiant unique (idempotent) |
| `callback_url` | non | string | URL de notification |
| `description` | non | string | Référence interne (max 500 car.) |

**Réponse** : `transaction_id`, `status` (toujours `pending` au départ), `external_reference`, `amount`, `fee_amount`, `total_deducted`, `currency`.

Traitement **asynchrone** : le statut final (`approved`/`rejected`) arrive par webhook — le polling `GET /payouts/{id}` est un complément, pas le mécanisme principal.

### `GET /payouts/{id_or_reference}`

Statut actuel + `fee_amount`, `created_at`, `updated_at`.

## Vérification OTP

Certains opérateurs (Orange CI, Orange BF, Orange SN à ce jour) exigent que l'abonné confirme la transaction via un code USSD avant le débit.

**Flux** :
1. `GET /operators` → lire `otp_required` (booléen) et `ussd_code` par opérateur.
2. Si `otp_required: true` : afficher le `ussd_code` à l'utilisateur (ex. `*144*4*4#`).
3. L'utilisateur compose le code, reçoit un OTP temporaire de l'opérateur.
4. Collecter cet OTP côté interface.
5. Envoyer `POST /collections` avec le champ `otp_code` rempli.

Sans `otp_code` pour un opérateur qui l'exige, la transaction est **immédiatement rejetée par l'opérateur**. Ne pas coder cette liste en dur — la revérifier via `GET /operators`.

| Pays | Opérateur | Slug | Code USSD |
|---|---|---|---|
| Burkina Faso | Orange Money | `orange-bf` | `*144*4*6*montant#` |
| Côte d'Ivoire | Orange Money | `orange-ci` | `#144*82#` |
| Sénégal | Orange Money | `orange-sn` | `#144*391#` |

## Opérateurs (`GET /operators`)

`GET /operators` (tous) ou `GET /operators?country={code}` (filtré).

**Champs retournés par opérateur** : `id`, `name`, `slug`, `code`, `country`, `otp_required`.

### Liste des opérateurs par pays (au 01/09/2026)

| Pays | Opérateur | Slug | Statut |
|---|---|---|---|
| Burkina Faso | Moov Money | `moov-bf` | Active |
| Burkina Faso | Orange Money | `orange-bf` | Active |
| Burkina Faso | LigdiCash | `wligdicash-bf` | Active |
| R.D. Congo | Afri Money | `afrimoney-cd` | Active |
| R.D. Congo | Airtel Money | `airtel-cd` | Active |
| R.D. Congo | Mpesa | `mpesa-cd` | Active |
| R.D. Congo | Orange Money | `orange-cd` | Active |
| R.D. Congo | Vodacom | `vodacom-cd` | Active |
| Congo | Airtel Money | `airtel-cg` | Active |
| Congo | MTN Money | `mtn-cg` | Active |
| Côte d'Ivoire | Moov Money | `moov-ci` | Active |
| Côte d'Ivoire | MTN Money | `mtn-ci` | Active |
| Côte d'Ivoire | Orange Money | `orange-ci` | Active |
| Côte d'Ivoire | Wave Money | `wave-ci` | Active |
| Cameroun | MTN Money | `mtn-cm` | Active |
| Cameroun | Orange Money | `orange-cm` | Active |
| Gabon | Airtel Money | `airtel-ga` | **Inactive** |
| Gabon | Moov Money | `moov-ga` | Active |
| Guinée Conakry | MTN Money | `mtn-gn` | Active |
| Guinée Conakry | Orange Money | `orange-gn` | Active |
| Guinée-Bissau | Orange Money | `orange-gw` | Active |
| Mali | Moov Money | `moov-ml` | Active |
| Mali | Orange Money | `orange-ml` | Active |
| Niger | Airtel Money | `airtel-ne` | Active |
| Niger | Amanata | `amanata-ne` | Active |
| Niger | Moov Money | `moov-ne` | Active |
| Niger | Nita | `nita-ne` | Active |
| Niger | LigdiCash | `wligdicash-ne` | Active |
| Niger | Zamani | `zamani-ne` | Active |
| Sénégal | E-money | `emoney-sn` | **Inactive** |
| Sénégal | Free Money | `free-sn` | Active |
| Sénégal | Orange Money | `orange-sn` | Active |
| Sénégal | Wave Money | `wave-sn` | Active |
| Togo | Moov Money | `moov-tg` | Active |
| Togo | T-Money | `tmoney-tg` | Active |
| Bénin | Celtiis Money | `celtiis-bj` | Active |
| Bénin | Coris Money | `coris-bj` | Active |
| Bénin | Moov Money | `moov-bj` | Active |
| Bénin | MTN Money | `mtn-bj` | Active |
| Gambie | Afri Money | `afrimoney-gm` | Active |
| Tchad | Airtel | `airtel-td` | **Inactive** |
| Tchad | Moov | `moov-td` | **Inactive** |
| Nigéria | Airtel | `airtel-ng` | Active |
| Nigéria | MTN Money | `mtn-ng` | Active |
| Ghana | Airtel | `airtel-gh` | Active |
| Ghana | MTN Money | `mtn-gh` | Active |
| Ghana | Telecel Cash | `telecel-gh` | Active |
| Kenya | Airtel | `airtel-ke` | Active |
| Kenya | Mpesa | `mpesa-ke` | Active |
| Ouganda | Airtel | `airtel-ug` | Active |
| Ouganda | MTN | `mtn-ug` | Active |
| Tanzanie | Airtel | `airtel-tz` | Active |
| Tanzanie | Ezy Pesa | `ezypesa-tz` | Active |
| Tanzanie | Halo Pesa | `halo_pesa` | Active |
| Tanzanie | Mpesa | `mpesa-tz` | Active |
| Tanzanie | Tigo Pesa | `tigopesa-tz` | Active |

> Ne pas coder cette liste en dur pour la production : elle peut évoluer. Toujours confirmer via `GET /operators` avant un gros volume — un mauvais slug fait échouer la transaction avec une erreur explicite (aucun argent ne part).

## Webhooks

SebPay notifie le statut final (`approved`/`rejected`) par `POST` JSON sur votre `callback_url`.

**Headers reçus** : `X-SebPay-Signature` (HMAC-SHA256 du body, calculé avec votre `X-Secret-Key`), `Content-Type: application/json`.

**Body reçu** : `transaction_id`, `external_reference`, `status` (`approved`/`rejected`/`pending`), `amount`, `currency`, `customer_phone`, `created_at`, `updated_at`.

**Bonnes pratiques** :
- Toujours vérifier la signature HMAC avant de traiter (voir `isValidSignature` dans `server.js`).
- Répondre `HTTP 200` sous 5 secondes ; traiter le reste en arrière-plan si besoin.
- Gérer l'idempotence via `transaction_id` (un webhook peut être renvoyé plusieurs fois).

## Codes de statut HTTP

| Code | Statut | Message | Final ? |
|---|---|---|---|
| 200 | SUCCESS | Transaction successfully processed | Oui |
| 200 | FAILED | Transaction Failed | Oui |
| 200 | PENDING | Transaction in process | Non |
| 400 | FAILED | Bad Request | Non |
| 401 | FAILED | Invalid credentials | Non |
| 403 | FAILED | Unauthorized | Non |
| 404 | FAILED | Not Found | Non |
| 405 | FAILED | Method Not Allowed | Non |
| 408 | FAILED | Request Timeout | Non |
| 429 | FAILED | Too Many Requests | Non |
| 500 | FAILED | Internal Server Error | Non |
