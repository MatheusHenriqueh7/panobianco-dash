# Panobianco — Meta Ads Dashboard

Dashboard estático (`index.html`) + funções serverless na Vercel (`api/*.js`) que consolidam
Meta Ads (investimento, leads, CPL, visitas ao Instagram) e conversão real (matrículas) via
RD Station CRM, para as unidades Panobianco.

Sem nenhuma variável de ambiente configurada, o dashboard funciona em **modo demonstração**
(dados fictícios), então é seguro publicar/testar antes de configurar produção.

## Arquitetura de segurança

- Nenhum token (Meta ou RD Station) fica no HTML/JS do client. Tudo é resolvido no servidor.
- `api/meta.js` recebe só `?endpoint=act_123.../insights?...` do frontend, descobre a conta
  (`act_<id>`) e resolve automaticamente qual token de `META_API_TOKENS_JSON` enxerga aquela
  conta. O token nunca volta na resposta.
- `api/rdstation.js` usa `RD_STATION_API_TOKEN` só no servidor para buscar negociações ganhas.
- `api/status.js` informa ao frontend **se** há contas descobertas (booleano/contagem), nunca os
  valores dos tokens.
- Se nenhum token enxergar uma conta específica, só aquela unidade fica sem dados — as demais
  seguem normalmente (erro isolado, ver `token_nao_configurado` em `api/meta.js`).

## Variáveis de ambiente (Vercel → Project Settings → Environment Variables)

### `META_API_TOKENS_JSON` (obrigatória para sair do modo demo)

É um **array simples de tokens**, um por Business Manager — **não precisa mapear conta por
conta manualmente** (cada BM tem ~12 contas, isso não escalaria):

```json
["TOKEN_BM_1", "TOKEN_BM_2", "TOKEN_BM_3", "TOKEN_BM_4"]
```

**Como isso funciona (descoberta automática):** ao receber a primeira requisição (ou a cada 1h,
para renovar o cache), o backend (`api/_lib/metaTokens.js`) chama, para cada token da lista,
`GET /me/adaccounts?fields=id,account_id,name` na Graph API — o próprio endpoint que lista quais
contas de anúncio aquele token de Usuário do Sistema enxerga. Com isso monta em memória o mapa
conta → token, sem precisar saber de antemão quais IDs de conta existem em cada BM.

- O resultado fica em cache por 1h (por instância "quente" da function). Requisições concorrentes
  durante o cache frio compartilham a mesma descoberta em vez de disparar uma chamada por request.
- Se a mesma conta aparecer em mais de um token (não deveria acontecer, mas pode indicar um
  usuário do sistema com acesso duplicado entre BMs), o backend mantém o **primeiro token em que
  a conta foi descoberta** e loga um aviso — não derruba a requisição.
- Se um token individual estiver inválido/expirado, só a descoberta daquele token falha (fica de
  fora do mapa) — os demais tokens continuam funcionando normalmente.
- Para adicionar uma nova Business Manager no futuro: gere o token dela (veja abaixo) e acrescente
  no array. **Não precisa saber os IDs das contas nem alterar nenhum código** — na próxima
  descoberta (próxima requisição após expirar o cache de 1h) as contas novas já aparecem
  automaticamente. Só lembre de também adicionar a unidade no array `UNIDADES` do `index.html`
  se for uma unidade nova.

**Como gerar um token de Usuário do Sistema sem expiração, por Business Manager:**

1. Acesse [business.facebook.com](https://business.facebook.com) → selecione a Business Manager.
2. Configurações do Negócio → **Usuários** → **Usuários do sistema**.
3. Crie um usuário do sistema (perfil **Admin**) ou reutilize um existente.
4. Atribua a ele acesso a todas as contas de anúncio dessa BM (Ativos → Contas de anúncio →
   Atribuir usuário do sistema) — é esse acesso que faz `/me/adaccounts` enxergar as contas.
5. Em "Gerar novo token": selecione o app conectado e os escopos `ads_read` (mínimo) ou
   `ads_management` se o dashboard também precisar pausar/duplicar campanhas.
6. **Não defina data de expiração** — tokens de usuário do sistema podem ser gerados sem expirar.
7. Copie o token e acrescente no array `META_API_TOKENS_JSON`.

Repita para cada Business Manager e junte todos os tokens num único array.

### `RD_STATION_API_TOKEN` (opcional — habilita a métrica de conversão real)

Token privado da API v1 do RD Station CRM (Configurações → Integrações → API).
Sem essa variável, as colunas de Convertidos/Taxa de Conversão/CAC mostram `--` e o dashboard
segue funcionando normalmente com os dados do Meta.

### Variáveis opcionais de configuração do RD Station

| Variável | Default | Para que serve |
|---|---|---|
| `RD_STATION_SOURCE_MATCH` | `Facebook Ads,Busca Paga` | Trechos (separados por vírgula) que identificam a origem Meta Ads no `deal_source` da negociação. |
| `RD_STATION_WON_STAGE_MATCH` | *(vazio)* | Se preenchido, além do campo nativo "ganho" (`win=true`) do RD Station, também exige que o nome da etapa (`deal_stage`) contenha esse texto (ex: `Matriculado`). |

> A unidade de cada negociação é identificada pelo **nome da campanha** (`deal.campaign.name`,
> ex: `"(MM) ENVIO DE LEADS - CONDADO"`) — não existe um campo personalizado confiável para isso
> no RD Station (o campo "Unidade" existe mas não é preenchido em nenhuma negociação). O
> cruzamento com o nome usado no Meta Ads é feito por aproximação (ignora acentuação/maiúsculas
> e aceita correspondência parcial). Negociações cujo texto não bate com nenhuma unidade
> conhecida ficam agrupadas em `unmatched` na resposta de `/api/rdstation` — útil para depurar
> nomes de campanha divergentes sem perder o dado.

### `REPORT_KEY` (opcional — habilita `/api/relatorio-semanal`)

Chave secreta exigida pelo endpoint de relatório. Sem ela configurada, o endpoint responde
sempre `401`. Use um valor longo e aleatório (ex: gerado com `openssl rand -hex 32`).

## Relatório semanal para os líderes (botão "📄 Relatório semanal")

Na barra superior da dash. Abre o relatório da **última semana fechada (segunda a domingo,
fuso de São Paulo)** numa folha A4: investimento, leads, CPL, matrículas, taxa de conversão e
custo por matrícula (com variação vs semana anterior), destaques automáticos e a tabela por
unidade. "◀ Anterior" navega para semanas passadas; "⤓ Salvar PDF" abre a impressão do
navegador — escolha "Salvar como PDF" e encaminhe o arquivo. Usa as mesmas regras do Funil
(`shared/funil.js`) e as mesmas rotas da dash (`/api/meta`, `/api/rdstation`).

## Endpoint JSON (`GET /api/relatorio-semanal`)

Endpoint somente-leitura com o Funil de Conversão por unidade, em JSON:

```
GET /api/relatorio-semanal?key=<REPORT_KEY>            → últimos 7 dias completos até ontem (America/Sao_Paulo)
GET /api/relatorio-semanal?key=<REPORT_KEY>&dias=30    → últimos 30 dias completos até ontem (1 a 90)
```

Usa exatamente as mesmas regras da dash — nada é reimplementado:

- `shared/funil.js` — lista de unidades, agregação das campanhas do Meta (gasto de leads × branding)
  e fórmulas CPL / taxa de conversão / custo por venda. **Carregado também pelo `index.html`**:
  unidade nova se adiciona lá.
- `api/_lib/metaTokens.js` + `api/_lib/metaGraph.js` — descoberta conta → token e chamada à Graph API.
- `api/_lib/rdDeals.js` — matrículas no RD Station (mesmas variáveis `RD_STATION_*` da dash).

Campos por unidade: `gasto`, `leads`, `cpl`, `convertidos`, `taxa_conversao` (em %),
`custo_por_venda`. Ordenado por `convertidos`. Também traz `totais`, `periodo`,
`rd.sem_unidade_identificada` (negociações pagas que não casaram com nenhuma unidade) e
`rd.criterio_convertido` (fonte/etapa efetivamente aplicadas). Se o RD falhar, Meta continua
vindo e `rd_erro` explica; unidade sem dado do Meta vem com `meta_erro` e métricas `null`.

## Rodando localmente

O dashboard é HTML+JS puro; para uma prévia rápida (sem as funções serverless, ou seja, sempre
em modo demo):

```powershell
powershell -File .preview-server.ps1
# abre http://localhost:8099
```

Para testar as funções serverless (`api/*.js`) localmente com as variáveis de ambiente reais,
use a [Vercel CLI](https://vercel.com/docs/cli): `vercel dev`.

## Deploy

```
vercel --prod
```

Depois do deploy, confirme que `VERCEL_URL` no topo do `<script>` de `index.html` aponta para o
domínio publicado.
