// api/rdstation.js — Busca negociações "ganhas" (matrículas) no RD Station CRM (API v1)
// e agrupa por unidade Panobianco, cruzando com o mesmo nome de unidade usado no Meta Ads.
//
// Configuração via variável de ambiente (nunca exposta ao client):
// - RD_STATION_API_TOKEN        (obrigatório) — token privado da API v1 do RD Station CRM.
// - RD_STATION_UNIT_FIELD_LABEL (opcional)    — label do campo personalizado que guarda a
//                                                unidade na negociação. Default: "Unidade".
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

// Cache em memória do processo (válido enquanto a function serverless ficar "quente").
let unitFieldCache = null;

async function findUnitFieldId(token, label) {
  if (unitFieldCache && unitFieldCache.label === label) return unitFieldCache.id;
  const url = `${RD_BASE}/custom_fields?token=${encodeURIComponent(token)}&for=deal`;
  const r = await fetch(url);
  const json = await r.json();
  const fields = Array.isArray(json) ? json : (json.custom_fields || json.data || []);
  const target = normalize(label);
  const found = fields.find(f => normalize(f.label || f.name) === target);
  if (found) {
    unitFieldCache = { label, id: found.id };
    return found.id;
  }
  return null;
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

function extractUnitValue(deal, unitFieldId) {
  const fields = deal.deal_custom_fields || deal.custom_fields || [];
  const entry = fields.find(f => f.custom_field_id === unitFieldId);
  return entry ? entry.value : null;
}

// Casa o valor (texto livre) do campo "Unidade" com o nome canônico usado no Meta Ads.
function matchUnit(rawValue, unitNames) {
  const norm = normalize(rawValue);
  if (!norm) return null;
  let exact = unitNames.find(u => normalize(u) === norm);
  if (exact) return exact;
  let partial = unitNames.find(u => {
    const nu = normalize(u);
    return nu.length >= 4 && (norm.includes(nu) || nu.includes(norm));
  });
  return partial || null;
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

  const unitFieldLabel = process.env.RD_STATION_UNIT_FIELD_LABEL || 'Unidade';
  const sourceMatch = (process.env.RD_STATION_SOURCE_MATCH || 'Facebook Ads,Busca Paga').split(',').map(s => s.trim()).filter(Boolean);
  const wonStageMatch = (process.env.RD_STATION_WON_STAGE_MATCH || '').trim() || null;
  const unitNames = units.split('|').map(s => s.trim()).filter(Boolean);

  try {
    const unitFieldId = await findUnitFieldId(token, unitFieldLabel);
    if (!unitFieldId) {
      return res.status(200).json({
        configured: true,
        error: `Campo personalizado "${unitFieldLabel}" não encontrado nas negociações do RD Station.`,
        byUnit: {}, unmatched: {},
      });
    }

    const deals = await fetchDeals(token, start_date, end_date, wonStageMatch);

    const byUnit = {};
    const unmatched = {};
    for (const d of deals) {
      if (sourceMatch.length && !matchesAny(d.deal_source?.name, sourceMatch)) continue;
      const rawUnit = extractUnitValue(d, unitFieldId);
      const unit = matchUnit(rawUnit, unitNames);
      if (unit) {
        byUnit[unit] = (byUnit[unit] || 0) + 1;
      } else {
        const key = rawUnit || '(sem unidade preenchida)';
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
