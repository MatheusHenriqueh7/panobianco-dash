// api/_lib/metaGraph.js — Chamada à Meta Graph API com o token já resolvido (ver metaTokens.js).
// Usado por api/meta.js (proxy da dash) e por api/relatorio-semanal.js. O token só entra na URL
// da requisição ao Graph — nunca é devolvido ao chamador.

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

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

// Remove `paging` em qualquer nível: os links next/previous da Graph API (inclusive os de
// edges aninhados, ex: adsets{insights}) carregam o access_token na URL.
function stripPaging(obj) {
  return JSON.parse(JSON.stringify(obj, (k, v) => (k === 'paging' ? undefined : v)));
}

// GET em `endpoint` (ex: "act_123/insights?...") com o token da conta, seguindo a paginação.
// A resposta já sai sem `paging` — segura para repassar ao browser.
async function graphGet(endpoint, token) {
  const url = `${GRAPH_BASE}/${endpoint}`;
  const separator = url.includes('?') ? '&' : '?';
  return stripPaging(await fetchAllPages(`${url}${separator}access_token=${encodeURIComponent(token)}`));
}

export { graphGet };
