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

// ── Paginação de /deals ──
// A API v1 do RD Station tem um limite físico: não deixa paginar além de 10.000 registros
// num mesmo intervalo de datas ("Result window is too large, must be less than or equal to
// 10000"). Contas com volume alto de negociações "ganhas" (ex: várias unidades, vários meses)
// facilmente passam disso — por isso o intervalo pedido é dividido em janelas menores (por mês)
// e, se mesmo assim uma janela específica passar do limite (ex: um evento pontual de importação
// em massa), ela é bisseccionada recursivamente por data até caber.
const PAGE_LIMIT = 200;
const RESULT_WINDOW_CAP = 10000;
const SAFE_CHUNK_CAP = 9600;           // margem abaixo do limite físico da API
const MAX_BISECT_DEPTH = 4;            // mês → ~15 dias → ~4 dias → ~2 dias → 1 dia, no pior caso
const PAGE_CONCURRENCY = 12;           // testado sem erro 429 da API do RD Station
const SOFT_TIME_BUDGET_MS = 6000;      // pausa de tentar mais páginas/janelas
const HARD_TIME_BUDGET_MS = 8500;      // corte duro: devolve o que já foi coletado até aqui,
                                        // pra nunca deixar a function serverless estourar o
                                        // timeout da plataforma (ver Promise.race abaixo)

function toDateOnly(s) { return s.slice(0, 10); }
function toEpochDay(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
function fromEpochDay(ed) { return new Date(ed * 86400000).toISOString().slice(0, 10); }
function startOfMonthUTC(dateStr) { const [y, m] = dateStr.split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-01`; }
function addMonthsUTC(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10); }
function endOfMonthUTC(dateStr) { const [y, m] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }

// Divide [startDay,endDay] (strings 'YYYY-MM-DD') em janelas de 1 mês de calendário.
function monthlyWindows(startDay, endDay) {
  const windows = [];
  let cur = startDay;
  while (cur <= endDay) {
    const monthEnd = endOfMonthUTC(cur);
    const winEnd = monthEnd < endDay ? monthEnd : endDay;
    windows.push({ start: cur, end: winEnd });
    cur = addMonthsUTC(startOfMonthUTC(cur), 1);
  }
  return windows;
}

async function fetchDealsPage(token, startDay, endDay, page) {
  const params = new URLSearchParams({
    token, page: String(page), limit: String(PAGE_LIMIT), closed_at_period: 'true',
    start_date: `${startDay}T00:00:00`, end_date: `${endDay}T23:59:59`, win: 'true',
  });
  const r = await fetch(`${RD_BASE}/deals?${params.toString()}`);
  const json = await r.json();
  return { ok: r.ok, json };
}

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// `deals` é passado de fora (mesma referência de array) para que o corte duro em fetchDeals
// consiga ler o que já foi coletado até aquele instante, mesmo com esta função ainda rodando.
async function fetchDealsCore(token, startDate, endDate, deals) {
  const start = Date.now();
  const softExpired = () => (Date.now() - start) > SOFT_TIME_BUDGET_MS;
  let truncated = false;

  const topWindows = monthlyWindows(toDateOnly(startDate), toDateOnly(endDate));

  // Resolve cada janela mensal (bissecciona recursivamente se passar do limite físico da API),
  // coletando a 1ª página de cada janela-folha já resolvida.
  const leaves = [];
  async function resolve(w, depth) {
    if (softExpired()) { truncated = true; return; }
    const first = await fetchDealsPage(token, w.start, w.end, 1);
    if (!first.ok) { truncated = true; return; }
    const total = first.json.total || 0;
    if (total === 0) return;

    if (total > SAFE_CHUNK_CAP && depth < MAX_BISECT_DEPTH && w.start < w.end) {
      const mid = fromEpochDay(Math.floor((toEpochDay(w.start) + toEpochDay(w.end)) / 2));
      const midNext = fromEpochDay(toEpochDay(mid) + 1);
      await Promise.all([
        resolve({ start: w.start, end: mid }, depth + 1),
        resolve({ start: midNext, end: w.end }, depth + 1),
      ]);
      return;
    }

    if (total > RESULT_WINDOW_CAP) truncated = true; // nem bisseccionar deu conta (pico extremo)
    deals.push(...(first.json.deals || []));
    leaves.push({ w, total: Math.min(total, RESULT_WINDOW_CAP) });
  }
  await Promise.all(topWindows.map(w => resolve(w, 0)));

  // Todas as páginas restantes de todas as janelas-folha, num único pool de concorrência —
  // maximiza o uso do tempo disponível em vez de esgotá-lo numa única janela primeiro.
  const pageTasks = [];
  for (const leaf of leaves) {
    const totalPages = Math.ceil(leaf.total / PAGE_LIMIT);
    for (let p = 2; p <= totalPages; p++) pageTasks.push({ w: leaf.w, p });
  }

  await mapLimit(pageTasks, PAGE_CONCURRENCY, async (t) => {
    if (softExpired()) { truncated = true; return; }
    const r = await fetchDealsPage(token, t.w.start, t.w.end, t.p);
    if (!r.ok) { truncated = true; return; }
    deals.push(...(r.json.deals || []));
  });

  return { deals, truncated };
}

async function fetchDeals(token, startDate, endDate, wonStageMatch) {
  // Corte duro: se o intervalo pedido for grande demais para caber no tempo de execução da
  // function serverless, devolve o que já foi coletado até aqui em vez de deixar a plataforma
  // matar a function por timeout (o que faria a conversão falhar por completo, pra todas as
  // unidades). `deals` é passado por referência pra fetchDealsCore — o array já reflete o que
  // foi coletado até o corte, mesmo que fetchDealsCore ainda esteja rodando quando isso acontece.
  const deals = [];
  const corePromise = fetchDealsCore(token, startDate, endDate, deals);
  const hardTimeout = new Promise(resolve => setTimeout(() => resolve({ truncated: true, hardCut: true }), HARD_TIME_BUDGET_MS));

  const result = await Promise.race([corePromise, hardTimeout]);
  const truncated = result.hardCut ? true : result.truncated;

  const filtered = wonStageMatch
    ? deals.filter(d => matchesAny(d.deal_stage?.name, [wonStageMatch]))
    : deals;

  return { deals: filtered, truncated };
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
    const { deals, truncated } = await fetchDeals(token, start_date, end_date, wonStageMatch);

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

    return res.status(200).json({ configured: true, byUnit, unmatched, totalDeals: deals.length, truncated });
  } catch (error) {
    // Falha isolada: dashboard mostra "--" para conversão, sem quebrar o restante.
    console.error('RD Station:', error.message);
    return res.status(200).json({ configured: true, error: 'Erro ao consultar RD Station: ' + error.message, byUnit: {}, unmatched: {} });
  }
}
