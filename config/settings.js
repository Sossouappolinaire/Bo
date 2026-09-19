// Réglages métier persistés en base et modifiables depuis l'administration.
// Les variables d'environnement servent uniquement de valeurs initiales.
const DEFAULT_SETTINGS = Object.freeze({
  billing_mode: process.env.BILLING_MODE === 'free' ? 'free' : 'paid',
  payment_method: process.env.PAYMENT_METHOD === 'link' ? 'link' : 'api',
  sebpay_payment_link: process.env.SEBPAY_PAYMENT_LINK || '',
  task_reward: process.env.TASK_REWARD || '2',
  price_per_interaction: process.env.PRICE_PER_INTERACTION || '3',
  min_campaign_amount: process.env.MIN_CAMPAIGN_AMOUNT || '100',
  min_withdrawal: process.env.MIN_WITHDRAWAL || '300',
  groq_api_key: process.env.GROQ_API_KEY || process.env.GROQ_API || '',
  groq_model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant'
});

const positiveNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Number(fallback);
};
const billingMode = (value) => String(value || '').trim().toLowerCase() === 'free' ? 'free' : 'paid';
const paymentMethod = (value) => String(value || '').trim().toLowerCase() === 'link' ? 'link' : 'api';

async function loadSettings(pool) {
  const result = await pool.query('SELECT key, value FROM app_settings');
  const values = { ...DEFAULT_SETTINGS };
  for (const row of result.rows) {
    if (row.key in values) values[row.key] = row.value;
  }
  return {
    taskReward: positiveNumber(values.task_reward, DEFAULT_SETTINGS.task_reward),
    pricePerInteraction: positiveNumber(values.price_per_interaction, DEFAULT_SETTINGS.price_per_interaction),
    minCampaignAmount: positiveNumber(values.min_campaign_amount, DEFAULT_SETTINGS.min_campaign_amount),
    minWithdrawal: positiveNumber(values.min_withdrawal, DEFAULT_SETTINGS.min_withdrawal),
    billingMode: billingMode(values.billing_mode),
    paymentMethod: paymentMethod(values.payment_method),
    sebpayPaymentLink: String(values.sebpay_payment_link || '').trim(),
    groqApiKey: String(values.groq_api_key || ''),
    groqModel: String(values.groq_model || DEFAULT_SETTINGS.groq_model)
  };
}

async function seedSettings(pool) {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, String(value)]
    );
  }
}

module.exports = { DEFAULT_SETTINGS, loadSettings, seedSettings };