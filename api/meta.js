// api/meta.js — Proxy servidor para a Meta Graph API com resolução automática de token por conta.
//
// META_API_TOKENS_JSON é um array de tokens (um por Business Manager). O mapeamento conta de
// anúncio → token é descoberto automaticamente perguntando à própria Graph API quais contas cada
// token enxerga (ver api/_lib/metaTokens.js) — não é preciso mapear conta por conta manualmente.
// O token nunca é aceito via query string do frontend e nunca aparece na resposta desta rota.

import { getTokenMap } from './_lib/metaTokens.js';
import { graphGet } from './_lib/metaGraph.js';

// Extrai o ID da conta de anúncio (act_123456) do início do endpoint solicitado.
function extractAccountId(endpoint) {
  const match = /^act_(\d+)/.exec(endpoint || '');
  return match ? match[1] : null;
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
    const data = await graphGet(endpoint, token);

    if (data.error) {
      return res.status(400).json({ error: data.error.message, code: data.error.code });
    }

    // Nunca repassar o token na resposta (graphGet já remove os links de `paging`, que o carregam).
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao chamar a Meta API: ' + error.message });
  }
}
