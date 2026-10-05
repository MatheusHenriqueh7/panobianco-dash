// api/relatorio-semanal.js — Relatório somente-leitura do Funil de Conversão por unidade.
//
// GET /api/relatorio-semanal?key=<REPORT_KEY>[&dias=N]
//
// Reaproveita as MESMAS regras da dash (nada é reimplementado aqui):
//   - unidades, agregação de campanhas Meta e fórmulas CPL/taxa/CAC → shared/funil.js
//   - descoberta automática conta → token nos BMs                    → api/_lib/metaTokens.js
//   - chamada à Graph API (paginação)                                → api/_lib/metaGraph.js
//   - matrículas no RD Station (origem paga, etapa, unidade)          → api/_lib/rdDeals.js
//
// Período padrão: últimos 7 dias completos até ontem, no fuso America/Sao_Paulo.
// Protegido por REPORT_KEY (variável de ambiente exclusiva deste endpoint). Tokens do Meta e do
// RD Station nunca aparecem na resposta.

import { timingSafeEqual } from 'node:crypto';
import funil from '../shared/funil.js';
import { getTokenMap } from './_lib/metaTokens.js';
import { graphGet } from './_lib/metaGraph.js';
import { loadRdConfig, fetchDeals, countDealsByUnit, mapLimit } from './_lib/rdDeals.js';

const { UNIDADES, insightsCampanhaEndpoint, agregarCampanhas, calcularFunil } = funil;

const TZ = 'America/Sao_Paulo';
const DIAS_PADRAO = 7;
const DIAS_MAX = 90;
const META_CONCURRENCY = 6;

function keyIsValid(provided) {
  const expected = process.env.REPORT_KEY;
  if (!expected || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Data de hoje (YYYY-MM-DD) no fuso de São Paulo, independente do fuso do servidor (UTC na Vercel).
function hojeSaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function addDias(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function round2(v) { return v == null ? null : Math.round(v * 100) / 100; }

async function buscarMeta(since, until) {
  const tokenMap = await getTokenMap();
  if (!tokenMap || Object.keys(tokenMap).length === 0) {
    return { erro: 'Nenhuma conta de anúncio pôde ser descoberta a partir de META_API_TOKENS_JSON.', porUnidade: {} };
  }

  const porUnidade = {};
  await mapLimit(UNIDADES, META_CONCURRENCY, async (u) => {
    const token = tokenMap[u.id];
    if (!token) {
      porUnidade[u.nome] = { erro: `Nenhum dos tokens configurados enxerga a conta act_${u.id}.` };
      return;
    }
    try {
      const data = await graphGet(insightsCampanhaEndpoint(u.id, since, until), token);
      if (data.error) {
        porUnidade[u.nome] = { erro: data.error.message };
        return;
      }
      porUnidade[u.nome] = { ...agregarCampanhas(data.data), incompleto: !!data.truncated };
    } catch (e) {
      porUnidade[u.nome] = { erro: 'Erro ao chamar a Meta API: ' + e.message };
    }
  });
  return { erro: null, porUnidade };
}

async function buscarRd(since, until) {
  const { token, sourceMatch, wonStageMatch } = loadRdConfig();
  const criterio = {
    fonte: sourceMatch,
    etapa: wonStageMatch, // null = só o "ganho" nativo do RD (win=true), sem filtro de etapa
    data: 'data de ganho (closed_at) dentro do período',
  };
  if (!token) return { erro: 'RD_STATION_API_TOKEN não configurado.', criterio };

  try {
    const { deals, truncated, httpError } = await fetchDeals(token, `${since}T00:00:00`, `${until}T23:59:59`, wonStageMatch);
    if (httpError && deals.length === 0) {
      return { erro: `RD Station respondeu com erro: ${httpError}`, criterio };
    }
    const { byUnit, unmatched } = countDealsByUnit(deals, UNIDADES.map(u => u.nome), sourceMatch);
    return { erro: null, criterio, byUnit, unmatched, incompleto: !!truncated, avisoHttp: httpError };
  } catch (e) {
    return { erro: 'Erro ao consultar RD Station: ' + e.message, criterio };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!keyIsValid(req.query.key)) {
    if (!process.env.REPORT_KEY) console.error('relatorio-semanal: REPORT_KEY não configurada — endpoint bloqueado.');
    return res.status(401).json({ error: 'nao_autorizado' });
  }

  let dias = DIAS_PADRAO;
  if (req.query.dias !== undefined) {
    dias = Number(req.query.dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > DIAS_MAX) {
      return res.status(400).json({ error: `Parâmetro dias deve ser um inteiro entre 1 e ${DIAS_MAX}.` });
    }
  }

  const until = addDias(hojeSaoPaulo(), -1);
  const since = addDias(until, -(dias - 1));

  const [meta, rd] = await Promise.all([buscarMeta(since, until), buscarRd(since, until)]);
  const rdOk = !rd.erro;

  const unidades = UNIDADES.map(u => {
    const m = meta.porUnidade[u.nome] || { erro: meta.erro };
    const metaOk = !m.erro;
    // Sem dado do Meta a unidade fica com gasto/leads null (não 0): senão o custo por venda
    // sairia 0 para uma unidade que teve matrículas mas cujo gasto não pôde ser lido.
    const gasto = metaOk ? m.gasto : null, gastoLeads = metaOk ? m.gastoLeads : null, leads = metaOk ? m.leads : null;
    const convertidos = rdOk ? (rd.byUnit[u.nome] || 0) : null;
    const f = metaOk ? calcularFunil({ gasto, gastoLeads, leads, convertidos }) : { cpl: null, taxaConv: null, cac: null };
    const linha = {
      unidade: u.nome,
      gasto: round2(gasto),
      leads,
      cpl: round2(f.cpl),
      convertidos,
      taxa_conversao: round2(f.taxaConv),
      custo_por_venda: round2(f.cac),
    };
    if (m.erro) linha.meta_erro = m.erro;
    if (m.incompleto) linha.meta_incompleto = true;
    return linha;
  });

  unidades.sort((a, b) => (b.convertidos || 0) - (a.convertidos || 0) || (b.leads || 0) - (a.leads || 0));

  // Taxa e custo gerais só com unidades que têm dado do Meta (mesma regra do relatório em PDF
  // da dash): matrículas de uma unidade sem gasto conhecido baixariam o custo por venda geral.
  const comMeta = unidades.filter(l => !l.meta_erro);
  const tot = {
    gasto: Object.values(meta.porUnidade).reduce((s, m) => s + (m.gasto || 0), 0),
    gastoLeads: Object.values(meta.porUnidade).reduce((s, m) => s + (m.gastoLeads || 0), 0),
    leads: comMeta.reduce((s, l) => s + l.leads, 0),
    convertidos: rdOk ? comMeta.reduce((s, l) => s + l.convertidos, 0) : null,
  };
  const convertidosTodas = rdOk ? unidades.reduce((s, l) => s + l.convertidos, 0) : null;
  const metaErros = Object.fromEntries(unidades.filter(l => l.meta_erro).map(l => [l.unidade, l.meta_erro]));
  const ft = calcularFunil(tot);

  const semUnidade = rdOk
    ? {
        total: Object.values(rd.unmatched).reduce((s, n) => s + n, 0),
        por_campanha: Object.fromEntries(Object.entries(rd.unmatched).sort((a, b) => b[1] - a[1])),
      }
    : null;

  const body = {
    periodo: { inicio: since, fim: until, dias, fuso: TZ },
    gerado_em: new Date().toISOString(),
    unidades,
    totais: {
      gasto: round2(tot.gasto),
      leads: tot.leads,
      cpl: round2(ft.cpl),
      convertidos: convertidosTodas,
      taxa_conversao: round2(ft.taxaConv),
      custo_por_venda: round2(ft.cac),
    },
    unidades_medida: { taxa_conversao: '% (convertidos / leads × 100)', gasto: 'R$', cpl: 'R$ (gasto em campanhas de leads / leads)', custo_por_venda: 'R$ (gasto total / convertidos)' },
    rd: {
      criterio_convertido: rd.criterio,
      sem_unidade_identificada: semUnidade,
      incompleto: rdOk ? rd.incompleto : null,
    },
  };
  if (rdOk && rd.avisoHttp) body.rd.aviso = `Parte das páginas do RD falhou (${rd.avisoHttp}) — convertidos podem estar subcontados.`;
  if (!rdOk) body.rd_erro = rd.erro;
  if (meta.erro) body.meta_erro = meta.erro;
  else if (Object.keys(metaErros).length) {
    body.meta_erros = metaErros;
    body.totais.obs = 'totais.convertidos inclui todas as unidades; taxa_conversao e custo_por_venda gerais excluem as unidades em meta_erros (sem gasto/leads conhecidos).';
  }

  return res.status(200).json(body);
}
