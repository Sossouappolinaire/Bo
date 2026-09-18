// Valeurs d'environnement initiales pour l'assistant IA.
// La configuration active est persistée en base via config/settings.js.
module.exports = {
  groq: {
    apiKey: process.env.GROQ_API_KEY || process.env.GROQ_API || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions'
  }
};