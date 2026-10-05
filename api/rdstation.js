// api/rdstation.js — Busca negociações "ganhas" (matrículas) no RD Station CRM (API v1)
// e agrupa por unidade Panobianco, cruzando com o mesmo nome de unidade usado no Meta Ads.
//
// Toda a regra (paginação, filtro de origem/etapa, cruzamento por nome de campanha) fica em
// api/_lib/rdDeals.js — compartilhada com api/relatorio-semanal.js. Variáveis de ambiente
// documentadas lá e no README.

import { loadRdConfig, fetchDeals, countDealsByUnit } from './_lib/rdDeals.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token, sourceMatch, wonStageMatch } = loadRdConfig();
  if (!token) {
    return res.status(200).json({ configured: false, byUnit: {}, unmatched: {} });
  }

  const { start_date, end_date, units } = req.query;
  if (!start_date || !end_date || !units) {
    return res.status(400).json({ error: 'Parâmetros start_date, end_date e units são obrigatórios' });
  }

  const unitNames = units.split('|').map(s => s.trim()).filter(Boolean);

  try {
    const { deals, truncated } = await fetchDeals(token, start_date, end_date, wonStageMatch);
    const { byUnit, unmatched } = countDealsByUnit(deals, unitNames, sourceMatch);

    return res.status(200).json({ configured: true, byUnit, unmatched, totalDeals: deals.length, truncated });
  } catch (error) {
    // Falha isolada: dashboard mostra "--" para conversão, sem quebrar o restante.
    console.error('RD Station:', error.message);
    return res.status(200).json({ configured: true, error: 'Erro ao consultar RD Station: ' + error.message, byUnit: {}, unmatched: {} });
  }
}
