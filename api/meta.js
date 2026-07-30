// api/meta.js — Proxy servidor para a Meta Graph API com resolução automática de token por conta.
//
// META_API_TOKENS_JSON é um array de tokens (um por Business Manager). O mapeamento conta de
// anúncio → token é descoberto automaticamente perguntando à própria Graph API quais contas cada
// token enxerga (ver api/_lib/metaTokens.js) — não é preciso mapear conta por conta manualmente.
// O token nunca é aceito via query string do frontend e nunca aparece na resposta desta rota.

import { getTokenMap } from './_lib/metaTokens.js';

// Extrai o ID da conta de anúncio (act_123456) do início do endpoint solicitado.
function extractAccountId(endpoint) {
  const match = /^act_(\d+)/.exec(endpoint || '');
  return match ? match[1] : null;
}

// Segue `paging.next` da Graph API e concatena `data`. Necessário para períodos longos
// (ex: filtro "Personalizado" de vários meses com time_increment=1), onde uma única página
// não traz todos os dias/campanhas. Trava por tempo e por nº de páginas para nunca deixar a
// function serverless rodar até estourar o timeout da plataforma — nesse caso devolve o que
// já foi coletado, marcado como `truncated`, em vez de falhar a chamada inteira.
async function fetchAllPages(firstUrl) {
  const MAX_PAGES = 50;
  const TIME_BUDGET_MS = 8000;
  const start = Date.now();

  let url = firstUrl;
  let merged = null;
  let last = null;
  let pages = 0;
  let truncated = false;

  while (url) {
    const response = await fetch(url);
    const json = await response.json();
    if (json.error) return json;
    last = json;
    pages++;

    if (!Array.isArray(json.data)) return json; // resposta sem coleção paginável (ex: objeto único)
    merged = merged ? merged.concat(json.data) : json.data;

    const next = json.paging && json.paging.next;
    if (next && pages < MAX_PAGES && (Date.now() - start) < TIME_BUDGET_MS) {
      url = next;
    } else {
      truncated = !!next;
      url = null;
    }
  }

  return { ...last, data: merged, truncated };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint } = req.query;
  if (!endpoint) {
    return res.status(400).json({ error: 'Parâmetro endpoint é obrigatório' });
  }

  const tokenMap = await getTokenMap();
  if (!tokenMap || Object.keys(tokenMap).length === 0) {
    // Sem nenhum token configurado (ou nenhuma conta descoberta): sinaliza modo demonstração.
    return res.status(503).json({ error: 'demo_mode', message: 'Nenhuma conta de anúncio pôde ser descoberta a partir de META_API_TOKENS_JSON.' });
  }

  const accountId = extractAccountId(endpoint);
  if (!accountId) {
    return res.status(400).json({ error: 'endpoint_invalido', message: 'Endpoint deve começar com act_<id_da_conta>.' });
  }

  const token = tokenMap[accountId];
  if (!token) {
    // Erro isolado: só esta conta fica sem dados, as demais chamadas continuam normalmente.
    return res.status(404).json({ error: 'token_nao_configurado', message: `Nenhum dos tokens configurados enxerga a conta act_${accountId}.`, accountId });
  }

  try {
    const url = `https://graph.facebook.com/v19.0/${endpoint}`;
    const separator = url.includes('?') ? '&' : '?';
    const fullUrl = `${url}${separator}access_token=${encodeURIComponent(token)}`;

    const data = await fetchAllPages(fullUrl);

    if (data.error) {
      return res.status(400).json({ error: data.error.message, code: data.error.code });
    }

    // Nunca repassar o token na resposta.
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao chamar a Meta API: ' + error.message });
  }
}
