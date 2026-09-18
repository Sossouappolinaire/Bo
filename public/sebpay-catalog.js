// Catalogue de secours (fallback) des pays / indicatifs / devises / opérateurs SebPay.
// Source : SEBPAY-API.md (GET /operators au 01/09/2026).
// En production la liste LIVE de /operators est prioritaire : ce fichier sert
// uniquement de repli si l'API est injoignable.

const COUNTRIES = [
  { code: 'BJ', name: 'Bénin', dial: '229', currency: 'XOF' },
  { code: 'BF', name: 'Burkina Faso', dial: '226', currency: 'XOF' },
  { code: 'CI', name: "Côte d'Ivoire", dial: '225', currency: 'XOF' },
  { code: 'SN', name: 'Sénégal', dial: '221', currency: 'XOF' },
  { code: 'TG', name: 'Togo', dial: '228', currency: 'XOF' },
  { code: 'ML', name: 'Mali', dial: '223', currency: 'XOF' },
  { code: 'NE', name: 'Niger', dial: '227', currency: 'XOF' },
  { code: 'GW', name: 'Guinée-Bissau', dial: '245', currency: 'XOF' },
  { code: 'CM', name: 'Cameroun', dial: '237', currency: 'XAF' },
  { code: 'GA', name: 'Gabon', dial: '241', currency: 'XAF' },
  { code: 'CG', name: 'Congo', dial: '242', currency: 'XAF' },
  { code: 'TD', name: 'Tchad', dial: '235', currency: 'XAF' },
  { code: 'CD', name: 'R.D. Congo', dial: '243', currency: 'CDF' },
  { code: 'GN', name: 'Guinée Conakry', dial: '224', currency: 'GNF' },
  { code: 'GM', name: 'Gambie', dial: '220', currency: 'GMD' },
  { code: 'NG', name: 'Nigéria', dial: '234', currency: 'NGN' },
  { code: 'GH', name: 'Ghana', dial: '233', currency: 'GHS' },
  { code: 'KE', name: 'Kenya', dial: '254', currency: 'KES' },
  { code: 'UG', name: 'Ouganda', dial: '256', currency: 'UGX' },
  { code: 'TZ', name: 'Tanzanie', dial: '255', currency: 'TZS' }
];

// slug -> { name, country }  (les slugs inactifs sont exclus)
const OPERATORS = [
  ['moov-bf', 'Moov Money', 'BF'], ['orange-bf', 'Orange Money', 'BF'], ['wligdicash-bf', 'LigdiCash', 'BF'],
  ['afrimoney-cd', 'Afri Money', 'CD'], ['airtel-cd', 'Airtel Money', 'CD'], ['mpesa-cd', 'Mpesa', 'CD'],
  ['orange-cd', 'Orange Money', 'CD'], ['vodacom-cd', 'Vodacom', 'CD'],
  ['airtel-cg', 'Airtel Money', 'CG'], ['mtn-cg', 'MTN Money', 'CG'],
  ['moov-ci', 'Moov Money', 'CI'], ['mtn-ci', 'MTN Money', 'CI'], ['orange-ci', 'Orange Money', 'CI'], ['wave-ci', 'Wave Money', 'CI'],
  ['mtn-cm', 'MTN Money', 'CM'], ['orange-cm', 'Orange Money', 'CM'],
  ['moov-ga', 'Moov Money', 'GA'],
  ['mtn-gn', 'MTN Money', 'GN'], ['orange-gn', 'Orange Money', 'GN'],
  ['orange-gw', 'Orange Money', 'GW'],
  ['moov-ml', 'Moov Money', 'ML'], ['orange-ml', 'Orange Money', 'ML'],
  ['airtel-ne', 'Airtel Money', 'NE'], ['amanata-ne', 'Amanata', 'NE'], ['moov-ne', 'Moov Money', 'NE'],
  ['nita-ne', 'Nita', 'NE'], ['wligdicash-ne', 'LigdiCash', 'NE'], ['zamani-ne', 'Zamani', 'NE'],
  ['free-sn', 'Free Money', 'SN'], ['orange-sn', 'Orange Money', 'SN'], ['wave-sn', 'Wave Money', 'SN'],
  ['moov-tg', 'Moov Money', 'TG'], ['tmoney-tg', 'T-Money', 'TG'],
  ['celtiis-bj', 'Celtiis Money', 'BJ'], ['coris-bj', 'Coris Money', 'BJ'], ['moov-bj', 'Moov Money', 'BJ'], ['mtn-bj', 'MTN Money', 'BJ'],
  ['afrimoney-gm', 'Afri Money', 'GM'],
  ['airtel-ng', 'Airtel', 'NG'], ['mtn-ng', 'MTN Money', 'NG'],
  ['airtel-gh', 'Airtel', 'GH'], ['mtn-gh', 'MTN Money', 'GH'], ['telecel-gh', 'Telecel Cash', 'GH'],
  ['airtel-ke', 'Airtel', 'KE'], ['mpesa-ke', 'Mpesa', 'KE'],
  ['airtel-ug', 'Airtel', 'UG'], ['mtn-ug', 'MTN', 'UG'],
  ['airtel-tz', 'Airtel', 'TZ'], ['ezypesa-tz', 'Ezy Pesa', 'TZ'], ['halo_pesa', 'Halo Pesa', 'TZ'],
  ['mpesa-tz', 'Mpesa', 'TZ'], ['tigopesa-tz', 'Tigo Pesa', 'TZ']
].map(([slug, name, country]) => ({
  slug,
  name,
  country,
  // Orange CI / BF / SN exigent un OTP (cf. documentation SebPay)
  otp_required: ['orange-ci', 'orange-bf', 'orange-sn'].includes(slug),
  ussd_code: { 'orange-ci': '#144*82#', 'orange-bf': '*144*4*6#', 'orange-sn': '#144*391#' }[slug] || null
}));

const byCode = (code) => COUNTRIES.find((c) => c.code === String(code || '').toUpperCase()) || null;
const dialFor = (code) => (byCode(code) ? byCode(code).dial : '');
const currencyFor = (code) => (byCode(code) ? byCode(code).currency : 'XOF');
const operatorsFor = (code) => OPERATORS.filter((o) => o.country === String(code || '').toUpperCase());

// Nom de pays libre (profil utilisateur) -> code ISO
function codeFromName(name) {
  const key = String(name || '').toLowerCase().trim();
  if (!key) return '';
  const hit = COUNTRIES.find((c) => c.name.toLowerCase() === key);
  if (hit) return hit.code;
  const alias = {
    benin: 'BJ', 'cote d ivoire': 'CI', "côte d’ivoire": 'CI', 'cote divoire': 'CI',
    senegal: 'SN', guinee: 'GN', 'guinée': 'GN', nigeria: 'NG', 'rdc': 'CD', 'congo rdc': 'CD'
  };
  return alias[key] || '';
}

// Numéro local -> format international sans "+" (ex. 97000000 + BJ => 22997000000)
function toInternational(phone, countryCode) {
  let digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  const dial = dialFor(countryCode);
  if (!digits) return '';
  if (dial && !digits.startsWith(dial)) digits = dial + digits;
  return digits;
}

module.exports = { COUNTRIES, OPERATORS, byCode, dialFor, currencyFor, operatorsFor, codeFromName, toInternational };
