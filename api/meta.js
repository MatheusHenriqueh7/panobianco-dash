// api/meta.js — Proxy servidor para Meta API (resolve CORS)
// Deploy no Vercel — gratuito

export default async function handler(req, res) {
  // Permite chamadas do GitHub Pages e localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { endpoint, token } = req.query;

  if (!endpoint || !token) {
    return res.status(400).json({ error: 'Parâmetros endpoint e token são obrigatórios' });
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${endpoint}`;
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}access_token=${token}`;

    const response = await fetch(fullUrl);
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message, code: data.error.code });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao chamar a Meta API: ' + error.message });
  }
}
