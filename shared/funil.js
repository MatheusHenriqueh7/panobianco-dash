// shared/funil.js — Fonte única das regras do Funil de Conversão, usada em DOIS lugares:
//   - no browser (index.html carrega via <script src="/shared/funil.js">, expõe window.PANO_FUNIL);
//   - no servidor (api/relatorio-semanal.js importa via `import funil from '../shared/funil.js'`).
//
// Por isso este arquivo é um script clássico (UMD), sem `import`/`export`: assim roda tanto
// como <script> comum no navegador quanto como módulo CommonJS no Node/Vercel.
// Qualquer mudança aqui (unidade nova, regra de lead, fórmula de CPL/CAC) vale para a dash E
// para o relatório semanal — não duplique essas regras em outro lugar.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PANO_FUNIL = api;
})(typeof self !== 'undefined' ? self : this, function () {

  // Contas de anúncio Meta (uma por unidade). O `nome` é o nome canônico da unidade — o mesmo
  // usado para casar as negociações do RD Station (ver api/_lib/rdDeals.js → matchUnit).
  const UNIDADES = [
    { id: "461525510615687",   nome: "Rio Preto" },
    { id: "926932954012010",   nome: "Saburo Akamine" },
    { id: "960870287284943",   nome: "Enxuto - Rio Claro" },
    { id: "960870997284872",   nome: "Marechal Tito" },
    { id: "1339940072711294",  nome: "Jardim Paulista" },
    { id: "1476215899083710",  nome: "Barra Bonita" },
    { id: "1374018689303432",  nome: "Parque Prado" },
    { id: "1534633956575237",  nome: "Pereira Barreto" },
    { id: "1611727625532536",  nome: "Lorena" },
    { id: "329817199287951",   nome: "Caxias RJ" },
    { id: "642335825534761",   nome: "Votuporanga" },
    { id: "25052320904357565", nome: "VeraCruz" },
    { id: "24324838040468354", nome: "Curuça" },
    { id: "342452664785881",   nome: "Jd Dona Benta" },
    { id: "1719214925258407",  nome: "Campo Limpo" },
    { id: "3522572947930191",  nome: "Vazame" },
    { id: "600983156391131",   nome: "Rio Das Pedras" },
    { id: "772882545216233",   nome: "Jardim Vilage" },
    { id: "1294908258942748",  nome: "Vila Ipiranga" },
    { id: "1153616979566102",  nome: "Condado" },
    { id: "2384148928647338",  nome: "Mococa" },
    { id: "1412461593941079",  nome: "Diário Ville" },
    { id: "1040672539304717",  nome: "Ítalo Adami" },
    { id: "1065013660203938",  nome: "Jamaica" },
  ];

  function extrairAcao(actions, tipos) {
    if (!actions) return 0;
    return actions.filter(a => tipos.includes(a.action_type)).reduce((s,a) => s + parseInt(a.value || 0), 0);
  }

  // Endpoint de insights por CAMPANHA de uma conta (relativo à Graph API, sem token).
  function insightsCampanhaEndpoint(accId, since, until) {
    const timeRange = JSON.stringify({ since, until });
    const fields = "spend,actions,impressions,clicks";
    return `act_${accId}/insights?fields=${fields}&time_range=${encodeURIComponent(timeRange)}&level=campaign`;
  }

  // Agrega as linhas de insights por campanha de uma unidade: gasto de leads separado do gasto
  // de branding (o CPL usa só o gasto das campanhas de leads).
  function agregarCampanhas(campanhas) {
    let gasto = 0, gastoLeads = 0, leads = 0, visitas = 0, impressoes = 0, cliques = 0;
    for (const c of (campanhas || [])) {
      const g = parseFloat(c.spend || 0);
      const l = extrairAcao(c.actions, ['lead']);
      // Considera campanha de leads se tiver 'lead' OU 'onsite_conversion.lead_grouped'
      // (não soma os dois para evitar double-count — usa só 'lead' para o número de leads)
      const isLeadCamp = l > 0 || extrairAcao(c.actions, ['onsite_conversion.lead_grouped']) > 0;
      const v = extrairAcao(c.actions, ['instagram_profile_visit']);
      gasto += g;
      leads += l;
      visitas += v;
      impressoes += parseInt(c.impressions || 0);
      cliques += parseInt(c.clicks || 0);
      if (isLeadCamp) gastoLeads += g;
    }
    return { gasto, gastoLeads, leads, visitas, impressoes, cliques };
  }

  // Métricas do funil Investimento → Leads → Convertidos. Denominador zero → null.
  //   cpl      = gasto das campanhas de leads / leads
  //   taxaConv = convertidos / leads, em %
  //   cac      = gasto total / convertidos (custo por venda)
  function calcularFunil({ gasto, gastoLeads, leads, convertidos }) {
    return {
      cpl: leads > 0 ? gastoLeads / leads : null,
      taxaConv: leads > 0 && convertidos != null ? (convertidos / leads) * 100 : null,
      cac: convertidos > 0 ? gasto / convertidos : null,
    };
  }

  return { UNIDADES, extrairAcao, insightsCampanhaEndpoint, agregarCampanhas, calcularFunil };
});
