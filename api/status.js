// api/status.js — Informa ao frontend quais integrações estão configuradas no servidor,
// sem nunca expor tokens ou qualquer segredo. Usado para decidir modo demo vs. produção.
//
// metaAccounts reflete contas de anúncio REALMENTE descobertas (via GET /me/adaccounts para
// cada token de META_API_TOKENS_JSON), não apenas a quantidade de tokens configurados — assim,
// se todos os tokens estiverem inválidos/expirados, o dashboard cai em modo demo corretamente.

import { getTokenMap } from './_lib/metaTokens.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const tokenMap = await getTokenMap();
  const metaAccounts = tokenMap ? Object.keys(tokenMap).length : 0;

  res.status(200).json({
    metaConfigured: metaAccounts > 0,
    metaAccounts,
    rdConfigured: !!process.env.RD_STATION_API_TOKEN,
  });
}
