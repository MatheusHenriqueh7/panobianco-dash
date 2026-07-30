// api/rdstation.js — Busca negociações "ganhas" (matrículas) no RD Station CRM (API v1)
// e agrupa por unidade Panobianco, cruzando com o mesmo nome de unidade usado no Meta Ads.
//
// A unidade de cada negociação é identificada pelo NOME DA CAMPANHA (`deal.campaign.name`,
// ex: "(MM) ENVIO DE LEADS - CONDADO"), não por um campo personalizado — o campo "Unidade"
// existe no RD Station mas não é preenchido em nenhuma negociação (confirmado em produção).
//
// Configuração via variável de ambiente (nunca exposta ao client):
// - RD_STATION_API_TOKEN        (obrigatório) — token privado da API v1 do RD Station CRM.
// - RD_STATION_SOURCE_MATCH     (opcional)    — trechos (separados por vírgula) que identificam
//                                                origem Meta Ads no deal_source.
//                                                Default: "Facebook Ads,Busca Paga".
// - RD_STATION_WON_STAGE_MATCH  (opcional)    — trecho do nome da etapa (deal_stage) que deve
//                                                ser considerado "matriculado", além do campo
//                                                nativo "win" do RD Station. Se vazio, usa só win=true.

const RD_BASE = 'https://crm.rdstation.com/api/v1';

const COMBINING_MARKS_RE = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');

function normalize(str) {
  return (str || '')
    .normalize('NFD').replace(COMBINING_MARKS_RE, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

function matchesAny(value, substrings) {
  const v = normalize(value);
  return substrings.some(s => v.includes(normalize(s)));
}

async function fetchDeals(token, startDate, endDate, wonStageMatch) {
  const deals = [];
  let page = 1;
  const limit = 200;
  const maxPages = 25; // trava de segurança (até 5000 negociações por período)

  while (page <= maxPages) {
    const params = new URLSearchParams({
      token,
      page: String(page),
      limit: String(limit),
      closed_at_period: 'true',
      start_date: startDate,
      end_date: endDate,
      win: 'true',
    });
    const url = `${RD_BASE}/deals?${params.toString()}`;
    const r = await fetch(url);
    const json = await r.json();
    const batch = Array.isArray(json) ? json : (json.deals || json.data || []);
    if (!batch.length) break;

    for (const d of batch) {
      if (wonStageMatch && !matchesAny(d.deal_stage?.name, [wonStageMatch])) continue;
      deals.push(d);
    }

    if (batch.length < limit) break;
    page++;
  }
  return deals;
}

function extractUnitValue(deal) {
  return (deal.campaign && deal.campaign.name) || null;
}

// Nome da campanha no RD Station às vezes diverge do nome cadastrado em UNIDADES (index.html)
// — prefixo/abreviação/espaçamento diferentes. Mapeamento manual confirmado para esses casos.
const UNIT_ALIASES = {
  'rio claro': 'Enxuto - Rio Claro',
  'vera cruz': 'VeraCruz',
  'jardim dona benta': 'Jd Dona Benta',
  'campestre': 'Parque Prado', // unidade renomeada na conta Meta; campanhas antigas no RD ainda podem dizer "Campestre"
};

// Casa o nome da campanha (texto livre) com o nome canônico da unidade usado no Meta Ads.
function matchUnit(rawValue, unitNames) {
  const norm = normalize(rawValue);
  if (!norm) return null;
  let exact = unitNames.find(u => normalize(u) === norm);
  if (exact) return exact;
  let partial = unitNames.find(u => {
    const nu = normalize(u);
    return nu.length >= 4 && (norm.includes(nu) || nu.includes(norm));
  });
  if (partial) return partial;
  for (const [alias, canonical] of Object.entries(UNIT_ALIASES)) {
    if (norm.includes(alias) && unitNames.includes(canonical)) return canonical;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.RD_STATION_API_TOKEN;
  if (!token) {
    return res.status(200).json({ configured: false, byUnit: {}, unmatched: {} });
  }

  const { start_date, end_date, units } = req.query;
  if (!start_date || !end_date || !units) {
    return res.status(400).json({ error: 'Parâmetros start_date, end_date e units são obrigatórios' });
  }

  const sourceMatch = (process.env.RD_STATION_SOURCE_MATCH || 'Facebook Ads,Busca Paga').split(',').map(s => s.trim()).filter(Boolean);
  const wonStageMatch = (process.env.RD_STATION_WON_STAGE_MATCH || '').trim() || null;
  const unitNames = units.split('|').map(s => s.trim()).filter(Boolean);

  try {
    const deals = await fetchDeals(token, start_date, end_date, wonStageMatch);

    const byUnit = {};
    const unmatched = {};
    for (const d of deals) {
      if (sourceMatch.length && !matchesAny(d.deal_source?.name, sourceMatch)) continue;
      const rawUnit = extractUnitValue(d);
      const unit = matchUnit(rawUnit, unitNames);
      if (unit) {
        byUnit[unit] = (byUnit[unit] || 0) + 1;
      } else {
        const key = rawUnit || '(sem campanha associada)';
        unmatched[key] = (unmatched[key] || 0) + 1;
      }
    }

    return res.status(200).json({ configured: true, byUnit, unmatched, totalDeals: deals.length });
  } catch (error) {
    // Falha isolada: dashboard mostra "--" para conversão, sem quebrar o restante.
    console.error('RD Station:', error.message);
    return res.status(200).json({ configured: true, error: 'Erro ao consultar RD Station: ' + error.message, byUnit: {}, unmatched: {} });
  }
}
