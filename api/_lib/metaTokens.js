// api/_lib/metaTokens.js — Descoberta automática do mapeamento conta de anúncio → token.
//
// META_API_TOKENS_JSON agora é um ARRAY simples de tokens (um por Business Manager), ex:
//   ["TOKEN_BM_1", "TOKEN_BM_2", "TOKEN_BM_3", "TOKEN_BM_4"]
//
// Como cada BM pode ter dezenas de contas de anúncio, em vez de mapear conta por conta à mão,
// para cada token perguntamos à própria Graph API (GET /me/adaccounts) quais contas ele enxerga,
// e montamos o mapa conta → token automaticamente. O resultado fica em cache (1h) por instância
// da function, com deduplicação de descobertas concorrentes.

import funil from '../../shared/funil.js';

const GRAPH_VERSION = 'v19.0';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

let tokenMapCache = null;      // { [accountId]: token }
let tokenMapCacheAt = 0;
let discoveryInFlight = null;  // Promise compartilhada — evita descobrir o mesmo lote de tokens em paralelo

function loadTokenList() {
  const raw = process.env.META_API_TOKENS_JSON;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('META_API_TOKENS_JSON inválido (JSON malformado):', e.message);
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.error('META_API_TOKENS_JSON deve ser um array de tokens (um por Business Manager), ex: ["TOKEN_BM_1","TOKEN_BM_2"].');
    return null;
  }
  const tokens = parsed.filter(t => typeof t === 'string' && t.trim());
  return tokens.length ? tokens : null;
}

// Lista todas as contas de anúncio acessíveis por um token (pagina se necessário).
// Falha de um token nunca deve derrubar a descoberta dos demais — por isso retorna [] e
// só loga o erro, em vez de propagar a exceção.
async function fetchAccountsForToken(token, tokenIndex) {
  const accounts = [];
  let url = `https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts?fields=id,account_id,name&limit=200&access_token=${encodeURIComponent(token)}`;
  let guard = 0;
  try {
    while (url && guard < 20) {
      guard++;
      const r = await fetch(url);
      const json = await r.json();
      if (json.error) {
        console.error(`Token #${tokenIndex + 1} de META_API_TOKENS_JSON: falha ao listar contas — ${json.error.message}`);
        break;
      }
      for (const a of (json.data || [])) {
        const accountId = a.account_id || (a.id || '').replace(/^act_/, '');
        if (accountId) accounts.push(accountId);
      }
      url = json.paging && json.paging.next ? json.paging.next : null;
    }
  } catch (e) {
    console.error(`Token #${tokenIndex + 1} de META_API_TOKENS_JSON: erro de rede na descoberta — ${e.message}`);
  }
  return accounts;
}

// Descobre, para todos os tokens configurados, quais contas cada um enxerga, e monta o
// mapeamento conta → token. Se a mesma conta aparecer em mais de um token (não deveria
// acontecer), mantém o token descoberto primeiro e apenas loga um aviso.
async function discoverTokenMap(tokens) {
  const map = {};
  const perToken = await Promise.all(tokens.map((t, i) => fetchAccountsForToken(t, i)));
  perToken.forEach((accountIds, i) => {
    for (const accountId of accountIds) {
      if (map[accountId] && map[accountId] !== tokens[i]) {
        console.warn(`Conta act_${accountId} descoberta em mais de um token de META_API_TOKENS_JSON — mantendo o token descoberto primeiro.`);
        continue;
      }
      if (!map[accountId]) map[accountId] = tokens[i];
    }
  });
  return map;
}

// Retorna o mapa { accountId: token }, usando cache de 1h. Sem nenhum token configurado
// retorna null (sinal para o caller cair em modo demonstração).
async function getTokenMap() {
  const tokens = loadTokenList();
  if (!tokens) return null;

  const fresh = tokenMapCache && (Date.now() - tokenMapCacheAt) < CACHE_TTL_MS;
  if (fresh) return tokenMapCache;

  if (!discoveryInFlight) {
    discoveryInFlight = discoverTokenMap(tokens).finally(() => { discoveryInFlight = null; });
  }
  const map = await discoveryInFlight;
  tokenMapCache = map;
  tokenMapCacheAt = Date.now();
  return map;
}

// ── Fallback por sondagem ──
// /me/adaccounts lista só as contas ATRIBUÍDAS diretamente ao usuário do sistema. Uma conta
// acessível por outro caminho (ex: acesso herdado da própria BM) não aparece ali, mas o token
// consegue lê-la — caso real da Parque Prado (antiga Campestre). Para essas, testamos cada token
// direto na conta. Só para contas cadastradas em shared/funil.js, para que o proxy público
// (/api/meta) não vire um jeito de disparar sondagens com IDs arbitrários.
const UNIDADE_IDS = new Set(funil.UNIDADES.map(u => u.id));
const probeCache = {};     // { [accountId]: { token | null, at } }
const probeInFlight = {};  // { [accountId]: Promise }

async function probeAccount(accountId, tokens) {
  for (const token of tokens) {
    try {
      const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/act_${accountId}?fields=id&access_token=${encodeURIComponent(token)}`);
      const json = await r.json();
      if (!json.error) return token;
    } catch (e) {
      console.error(`Sondagem da conta act_${accountId}: erro de rede — ${e.message}`);
    }
  }
  return null;
}

// Token que enxerga a conta: primeiro pelo mapa descoberto, depois por sondagem (com cache de 1h,
// inclusive negativo). Retorna null se nenhum token enxergar a conta.
async function resolveToken(accountId) {
  const map = await getTokenMap();
  if (!map) return null;
  if (map[accountId]) return map[accountId];
  if (!UNIDADE_IDS.has(accountId)) return null;

  const cached = probeCache[accountId];
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return cached.token;

  if (!probeInFlight[accountId]) {
    probeInFlight[accountId] = probeAccount(accountId, loadTokenList() || [])
      .then(token => { probeCache[accountId] = { token, at: Date.now() }; return token; })
      .finally(() => { delete probeInFlight[accountId]; });
  }
  return probeInFlight[accountId];
}

export { getTokenMap, loadTokenList, resolveToken };
