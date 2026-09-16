// Configuration de l'assistant IA.
// La clé reste dans les variables d'environnement du serveur (Render/.env local).
module.exports = {
  groq: {
    apiKey: process.env.GROQ_API_KEY || process.env.GROQ_API || '',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions'
  }
};