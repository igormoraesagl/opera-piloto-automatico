// OPERA Piloto Automatico · Worker de disparo (Cloudflare Workers + Cron).
// 7 automacoes de WhatsApp que rodam sozinhas via triggers agendados.
// Reutiliza os padroes de chamada de API dos conectores AGL:
//   Kommo (CRM), Asaas (financeiro) e Z-API (WhatsApp).
//
// O handler scheduled() recebe event.cron e roteia para a automacao certa.
// Cada automacao trata o proprio erro: uma falha nao derruba as outras.

// =====================================================================
// 1. CLIENTES DE API (mesmo padrao dos conectores MCP prontos)
// =====================================================================

// ---- Kommo (CRM) -----------------------------------------------------
function kommoBase(env) {
  // Aceita tanto o subdominio sozinho quanto o dominio completo.
  const sub = (env.KOMMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "");
  return `https://${sub}.kommo.com/api/v4`;
}

async function kommo(env, path, { method = "GET", body } = {}) {
  const token = (env.KOMMO_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  const res = await fetch(`${kommoBase(env)}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null; // sem conteudo (busca vazia)
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Kommo ${res.status}: ${detail}`);
  }
  return data;
}

// Coletor paginado do Kommo.
//
// Por que isso existe: a API do Kommo devolve no maximo 250 itens por pagina.
// Contar o tamanho de UMA pagina significa que toda agencia com mais de 250
// leads (ou tarefas) na janela le "250" e nunca sabe. O relatorio nao avisa
// que truncou, ele so mente com cara de numero certo. Aqui a gente varre as
// paginas ate acabar.
//
// `entidade` e a chave dentro de _embedded: "leads", "tasks", "users"...
async function kommoTudo(env, caminho, params, entidade, maxPaginas = 40) {
  const itens = [];
  let truncou = false;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const p = new URLSearchParams(params);
    p.set("limit", "250");
    p.set("page", String(pagina));
    const d = await kommo(env, `${caminho}?${p.toString()}`);
    const lote = d?._embedded?.[entidade] || [];
    itens.push(...lote);
    // Sem proxima pagina, ou pagina incompleta: acabou.
    if (!d?._links?.next || lote.length < 250) break;
    // Bateu o teto COM proxima pagina ainda existindo: truncou. Nao minta em
    // silencio. Marca o array e grita no log. 40 paginas = 10.000 itens, entao
    // isso so acontece em volume absurdo, mas se acontecer, tem que aparecer.
    if (pagina === maxPaginas) {
      truncou = true;
      console.log(`kommoTudo: TRUNCOU em ${maxPaginas} paginas (${itens.length}+ ${entidade}). Numero abaixo do real.`);
    }
  }
  itens.truncou = truncou;
  return itens;
}

// Conta de verdade, varrendo todas as paginas.
const kommoContar = async (env, caminho, params, entidade) =>
  (await kommoTudo(env, caminho, params, entidade)).length;

// ---- Asaas (financeiro) ---------------------------------------------
// A URL base vem do prefixo da chave: $aact_hmlg_ = Sandbox, senao Producao.
function asaasBase(env) {
  const k = env.ASAAS_API_KEY || "";
  return k.startsWith("$aact_hmlg_") ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
}

async function asaas(env, path, { method = "GET", body } = {}) {
  const res = await fetch(`${asaasBase(env)}${path}`, {
    method,
    headers: { access_token: env.ASAAS_API_KEY, "Content-Type": "application/json", "User-Agent": "opera-piloto-automatico" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) {
    const msg = data && data.errors ? data.errors.map((e) => e.description).join("; ") : (typeof data === "string" ? data : JSON.stringify(data));
    throw new Error(`Asaas ${res.status}: ${msg}`);
  }
  return data;
}

// Busca todas as paginas de um endpoint de lista Asaas (data/hasMore), com teto.
async function asaasListarTudo(env, path, maxPaginas = 10) {
  const itens = [];
  let offset = 0;
  const limit = 100;
  for (let i = 0; i < maxPaginas; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await asaas(env, `${path}${sep}limit=${limit}&offset=${offset}`);
    (d.data || []).forEach((x) => itens.push(x));
    if (!d.hasMore) break;
    offset += limit;
  }
  return itens;
}

// ---- Z-API (WhatsApp) -----------------------------------------------
function zapiBase(env) {
  return `https://api.z-api.io/instances/${env.ZAPI_INSTANCE_ID}/token/${env.ZAPI_INSTANCE_TOKEN}`;
}

async function zapi(env, path, { method = "GET", body } = {}) {
  const res = await fetch(`${zapiBase(env)}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Client-Token": env.ZAPI_CLIENT_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = txt; }
  if (!res.ok) {
    throw new Error(`Z-API ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

const onlyDigits = (s) => String(s).replace(/\D/g, "");

// Envia um texto no WhatsApp. Sem telefone, cai no NOTIFY_PHONE (dono).
async function enviarTexto(env, mensagem, telefone) {
  const phone = onlyDigits(telefone || env.NOTIFY_PHONE || "");
  if (!phone) throw new Error("Sem telefone de destino (defina NOTIFY_PHONE).");
  const r = await zapi(env, `/send-text`, { method: "POST", body: { phone, message: mensagem } });
  return r.messageId || r.id || "?";
}

// =====================================================================
// 2. HELPERS DE FORMATACAO E DATA (fuso America/Sao_Paulo)
// =====================================================================

const brl = (n) => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDia = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "");
const hojeSP = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD

// Tipo de tarefa "reuniao" no Kommo. O padrao do Kommo e 2, mas a conta pode ter
// tipos customizados. Sem um id certo, a contagem de reunioes mente em silencio.
// Por isso vem de variavel de ambiente, com 2 so como padrao.
const tipoReuniao = (env) => String((env && env.KOMMO_TASK_TYPE_REUNIAO) || "2");

function addDias(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diasEntre(aIso, bIso) {
  return Math.round((new Date(bIso + "T12:00:00Z") - new Date(aIso + "T12:00:00Z")) / 86400000);
}

// Inicio do dia (00:00 em Sao Paulo) em segundos unix, com deslocamento em dias.
function inicioDiaSP(offsetDias = 0) {
  const base = Date.parse(`${hojeSP()}T00:00:00-03:00`);
  return Math.floor((base + offsetDias * 86400000) / 1000);
}

const agoraUnix = () => Math.floor(Date.now() / 1000);

// Hora HH:MM em Sao Paulo a partir de um unix em segundos.
const horaSP = (unix) =>
  new Date((unix || 0) * 1000).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });

// =====================================================================
// 2.1 HELPERS DE KOMMO (link do lead, nome da etapa, nome do responsavel)
// =====================================================================

// Link direto do lead no Kommo (abre a ficha no navegador).
function linkLead(env, leadId) {
  const sub = (env.KOMMO_SUBDOMAIN || "").replace(/^https?:\/\//, "").replace(/\.kommo\.com.*$/, "");
  return `https://${sub}.kommo.com/leads/detail/${leadId}`;
}

// Nome da etapa do funil. Guarda em cache pra nao repetir chamada na mesma execucao.
async function nomeEtapa(env, cache, pipelineId, statusId) {
  const chave = `${pipelineId}:${statusId}`;
  if (cache.has(chave)) return cache.get(chave);
  let nome = "etapa nao identificada";
  try {
    const s = await kommo(env, `/leads/pipelines/${pipelineId}/statuses/${statusId}`);
    if (s && s.name) nome = s.name;
  } catch (e) {
    console.log("kommo/etapa erro:", e.message);
  }
  cache.set(chave, nome);
  return nome;
}

// Descobre os status_id de "venda ganha", sem chutar.
//
// Por que nao cravar 142: 142 e a etapa de ganho PADRAO do Kommo, mas funil
// customizado pode ter a etapa de ganho com outro id. Cravar 142 faz o review
// mostrar "0 fechados" numa agencia que fecha todo mes, e isso e exatamente o
// tipo de numero errado em silencio que destroi a confianca no produto.
//
// Ordem: se o dono setou KOMMO_STATUS_GANHO, respeita. Senao, varre os funis e
// pega toda etapa do tipo "won" (type 1). So se a API falhar e nao houver env,
// cai no 142 como ultimo recurso, e avisa no log.
async function statusGanho(env) {
  if (env.KOMMO_STATUS_GANHO) {
    return String(env.KOMMO_STATUS_GANHO).split(",").map((s) => s.trim()).filter(Boolean);
  }
  try {
    const d = await kommo(env, `/leads/pipelines`);
    const funis = d?._embedded?.pipelines || [];
    const ids = [];
    for (const f of funis) {
      for (const st of f?._embedded?.statuses || []) {
        if (st.type === 1) ids.push(String(st.id)); // type 1 = ganho no Kommo
      }
    }
    if (ids.length) return ids;
    console.log("kommo/status-ganho: nenhum status tipo 'ganho' achado, usando 142.");
  } catch (e) {
    console.log("kommo/status-ganho erro, usando 142:", e.message);
  }
  return ["142"];
}

// Mapa id -> nome dos usuarios do Kommo (pra dizer QUEM esta atrasado).
async function usuariosKommo(env) {
  const mapa = new Map();
  try {
    const d = await kommo(env, `/users?limit=250`);
    (d?._embedded?.users || []).forEach((u) => mapa.set(u.id, u.name || `usuario ${u.id}`));
  } catch (e) {
    console.log("kommo/usuarios erro:", e.message);
  }
  return mapa;
}

// Origem do lead: tenta o campo nativo, depois os campos personalizados de UTM.
function origemDoLead(lead) {
  if (lead?._embedded?.source?.name) return lead._embedded.source.name;
  const campos = lead?.custom_fields_values || [];
  const alvo = ["utm_source", "origem", "fonte", "canal"];
  for (const c of campos) {
    const nome = String(c.field_name || c.field_code || "").toLowerCase();
    if (alvo.some((a) => nome.includes(a))) {
      const v = c.values?.[0]?.value;
      if (v) return String(v);
    }
  }
  return "origem nao informada";
}

// =====================================================================
// 3. AUTOMACAO 1 · BRIEFING DIARIO (7h BRT)
//    Agenda/tarefas do dia no Kommo + saldo e proximos vencimentos no Asaas.
// =====================================================================

async function briefingDiario(env) {
  const de = inicioDiaSP(0);
  const ate = inicioDiaSP(1) - 1;

  // Tarefas do dia abertas (complete_till dentro de hoje).
  let tarefasHoje = [];
  try {
    const params = new URLSearchParams();
    params.set("filter[is_completed]", "0");
    params.set("filter[complete_till][from]", String(de));
    params.set("filter[complete_till][to]", String(ate));
    tarefasHoje = await kommoTudo(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("briefing/tarefas erro:", e.message);
  }

  // Saldo e proximos vencimentos (7 dias) no Asaas.
  let saldo = null, aVencer = [];
  try {
    const bal = await asaas(env, `/finance/balance`);
    saldo = bal.balance;
  } catch (e) {
    console.log("briefing/saldo erro:", e.message);
  }
  try {
    const hoje = hojeSP();
    aVencer = await asaasListarTudo(env, `/payments?status=PENDING&dueDate[ge]=${hoje}&dueDate[le]=${addDias(hoje, 7)}`);
  } catch (e) {
    console.log("briefing/vencimentos erro:", e.message);
  }

  const totalAVencer = aVencer.reduce((s, p) => s + (p.value || 0), 0);

  const linhasTarefas = tarefasHoje.length
    ? tarefasHoje.slice(0, 15).map((t) => {
        const hora = new Date((t.complete_till || 0) * 1000).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
        return `- ${hora} ${t.text || "(tarefa)"}`;
      })
    : ["- Sem tarefas agendadas para hoje."];

  const msg = [
    `*Briefing do dia · ${fmtDia(hojeSP())}*`,
    ``,
    `*Agenda no CRM (${tarefasHoje.length})*`,
    ...linhasTarefas,
    tarefasHoje.length > 15 ? `- e mais ${tarefasHoje.length - 15} tarefa(s).` : null,
    ``,
    `*Financeiro*`,
    saldo != null ? `Saldo em caixa: ${brl(saldo)}` : `Saldo: nao consegui ler agora.`,
    `A receber em 7 dias: ${brl(totalAVencer)} em ${aVencer.length} cobranca(s).`,
    ``,
    `Bom dia. Comece pela golden hour.`,
  ].filter((l) => l !== null).join("\n");

  const id = await enviarTexto(env, msg);
  return `briefing enviado (messageId ${id})`;
}

// =====================================================================
// 4. AUTOMACAO 2 · RELATORIO DIARIO DE FUNIL (18h BRT)
//    Leads novos, reunioes marcadas e tarefas atrasadas no Kommo.
// =====================================================================

async function relatorioFunil(env) {
  const de = inicioDiaSP(0);
  const ate = inicioDiaSP(1) - 1;

  // Leads criados hoje.
  let leadsNovos = 0;
  try {
    const params = new URLSearchParams();
    params.set("filter[created_at][from]", String(de));
    params.set("filter[created_at][to]", String(ate));
    leadsNovos = await kommoContar(env, "/leads", params, "leads");
  } catch (e) {
    console.log("funil/leads erro:", e.message);
  }

  // Reunioes marcadas hoje: tarefas do tipo "reuniao" (task_type 2 = reuniao no Kommo).
  let reunioes = 0;
  try {
    const params = new URLSearchParams();
    params.set("filter[task_type][]", tipoReuniao(env));
    params.set("filter[created_at][from]", String(de));
    params.set("filter[created_at][to]", String(ate));
    reunioes = await kommoContar(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("funil/reunioes erro:", e.message);
  }

  // Tarefas atrasadas: abertas com prazo ja vencido.
  let atrasadas = 0;
  try {
    const params = new URLSearchParams();
    params.set("filter[is_completed]", "0");
    params.set("filter[complete_till][to]", String(agoraUnix() - 1));
    atrasadas = await kommoContar(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("funil/atrasadas erro:", e.message);
  }

  const msg = [
    `*Fechamento do funil · ${fmtDia(hojeSP())}*`,
    ``,
    `Leads novos hoje: ${leadsNovos}`,
    `Reunioes marcadas: ${reunioes}`,
    `Tarefas atrasadas: ${atrasadas}`,
    ``,
    atrasadas > 0
      ? `Tem ${atrasadas} tarefa(s) atrasada(s) travando o funil. Limpe antes de amanha.`
      : `Funil sem tarefa atrasada. Dia limpo.`,
  ].join("\n");

  const id = await enviarTexto(env, msg);
  return `relatorio de funil enviado (messageId ${id})`;
}

// =====================================================================
// 5. AUTOMACAO 3 · REVIEW SEMANAL (segunda 8h BRT)
//    Resumo da semana: leads, reunioes, fechados e financeiro.
// =====================================================================

async function reviewSemanal(env) {
  const de = inicioDiaSP(-7);
  const ate = agoraUnix();
  const hoje = hojeSP();
  const seteAtras = addDias(hoje, -7);

  // Leads criados nos ultimos 7 dias.
  let leads = 0;
  try {
    const params = new URLSearchParams();
    params.set("filter[created_at][from]", String(de));
    params.set("filter[created_at][to]", String(ate));
    leads = await kommoContar(env, "/leads", params, "leads");
  } catch (e) {
    console.log("review/leads erro:", e.message);
  }

  // Reunioes da semana (tarefas tipo 2 criadas nos ultimos 7 dias).
  let reunioes = 0;
  try {
    const params = new URLSearchParams();
    params.set("filter[task_type][]", tipoReuniao(env));
    params.set("filter[created_at][from]", String(de));
    params.set("filter[created_at][to]", String(ate));
    reunioes = await kommoContar(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("review/reunioes erro:", e.message);
  }

  // Fechados na semana: leads em qualquer etapa de ganho, atualizados nos ultimos 7 dias.
  // As etapas de ganho vem da API (statusGanho), nao de um numero chutado.
  let fechados = 0, valorFechado = 0;
  try {
    const idsGanho = await statusGanho(env);
    const params = new URLSearchParams();
    idsGanho.forEach((id, i) => params.set(`filter[statuses][${i}][status_id]`, id));
    params.set("filter[updated_at][from]", String(de));
    params.set("filter[updated_at][to]", String(ate));
    const ganhos = await kommoTudo(env, "/leads", params, "leads");
    fechados = ganhos.length;
    valorFechado = ganhos.reduce((s, l) => s + (l.price || 0), 0);
  } catch (e) {
    console.log("review/fechados erro:", e.message);
  }

  // Financeiro: saldo atual + recebido nos ultimos 7 dias.
  let saldo = null, recebido = 0;
  try {
    const bal = await asaas(env, `/finance/balance`);
    saldo = bal.balance;
  } catch (e) {
    console.log("review/saldo erro:", e.message);
  }
  try {
    const recebidas = await asaasListarTudo(env, `/payments?status=RECEIVED&paymentDate[ge]=${seteAtras}&paymentDate[le]=${hoje}`);
    recebido = recebidas.reduce((s, p) => s + (p.value || 0), 0);
  } catch (e) {
    console.log("review/recebido erro:", e.message);
  }

  const msg = [
    `*Review da semana · ${fmtDia(seteAtras)} a ${fmtDia(hoje)}*`,
    ``,
    `*Comercial*`,
    `Leads novos: ${leads}`,
    `Reunioes: ${reunioes}`,
    `Negocios fechados: ${fechados} (${brl(valorFechado)})`,
    ``,
    `*Financeiro*`,
    saldo != null ? `Saldo em caixa: ${brl(saldo)}` : `Saldo: nao consegui ler agora.`,
    `Recebido na semana: ${brl(recebido)}`,
    ``,
    `Nova semana comecando. Defina a meta de reunioes antes das 9h.`,
  ].join("\n");

  const id = await enviarTexto(env, msg);
  return `review semanal enviado (messageId ${id})`;
}

// =====================================================================
// 6. AUTOMACAO 4 · REGUA DE COBRANCA (9h BRT)
//    Inadimplentes no Asaas, lembrete por estagio de atraso.
//
//    AVISO IMPORTANTE: esta automacao manda mensagem PARA O CLIENTE do
//    dono da agencia, nao para o dono. Por isso ela vem DESLIGADA por
//    padrao e exige opt-in explicito. Para ligar de fato, defina a
//    variavel REGUA_COBRANCA_ATIVA = "true" no deploy.
//
//    Enquanto REGUA_COBRANCA_ATIVA nao for "true", a regua roda em modo
//    seguro: monta as mensagens e manda so um RESUMO para o dono
//    (NOTIFY_PHONE), sem tocar em nenhum cliente. Assim o dono revisa o
//    texto e o alcance antes de liberar o envio real.
// =====================================================================

// Monta o lembrete de acordo com o estagio de atraso.
function mensagemCobranca(env, { nome, valor, vencimento, diasAtraso }) {
  const empresa = env.NOME_EMPRESA || "nossa equipe";
  const linkPix = env.LINK_PAGAMENTO ? `\n\nPague por aqui: ${env.LINK_PAGAMENTO}` : "";
  const abertura = `Oi ${nome ? nome.split(" ")[0] : ""}, aqui e da ${empresa}.`.replace(/\s+,/, ",");

  if (diasAtraso <= 7) {
    return [
      abertura,
      ``,
      `Notei que a fatura de ${brl(valor)}, com vencimento em ${fmtDia(vencimento)}, ficou em aberto.`,
      `Deve ser so um esquecimento. Consegue acertar hoje?${linkPix}`,
    ].join("\n");
  }
  if (diasAtraso <= 15) {
    return [
      abertura,
      ``,
      `A fatura de ${brl(valor)} venceu em ${fmtDia(vencimento)} e ja esta ${diasAtraso} dias em aberto.`,
      `Quero te ajudar a regularizar antes que gere juros. Da pra pagar ainda esta semana?${linkPix}`,
    ].join("\n");
  }
  return [
    abertura,
    ``,
    `A fatura de ${brl(valor)} (venceu em ${fmtDia(vencimento)}) esta com ${diasAtraso} dias de atraso.`,
    `Preciso alinhar o pagamento pra manter seu servico ativo. Me chama aqui pra resolver hoje.${linkPix}`,
  ].join("\n");
}

// ---- Idempotencia da regua (estado no KV) ----------------------------
// O cron da Cloudflare e "at-least-once": um tick pode disparar duas vezes.
// Sem estado, o mesmo inadimplente receberia a cobranca duas vezes no mesmo
// dia, no WhatsApp, o que queima a relacao e o numero do dono. O KV grava
// "esta cobranca ja foi cobrada neste estagio", e a regua nunca repete.
//
// Chave: regua:<paymentId>:<estagio>. TTL de 60 dias cobre o maior estagio (30).
// Sem o KV configurado, degrada pro comportamento antigo (dedup so por estagio
// do dia), entao um deploy sem o binding ainda funciona, so sem a garantia.
async function jaCobrado(env, paymentId, estagio) {
  if (!env.ESTADO) return false;
  return (await env.ESTADO.get(`regua:${paymentId}:${estagio}`)) !== null;
}
async function reservarCobranca(env, paymentId, estagio) {
  if (!env.ESTADO) return;
  await env.ESTADO.put(`regua:${paymentId}:${estagio}`, hojeSP(), { expirationTtl: 60 * 24 * 3600 });
}
async function liberarCobranca(env, paymentId, estagio) {
  if (!env.ESTADO) return;
  try { await env.ESTADO.delete(`regua:${paymentId}:${estagio}`); } catch {}
}
// Maior estagio que a cobranca JA alcancou (<= diasAtraso). null se nenhum.
// Usar o alcancado, e nao a igualdade exata, recupera o dia perdido: se o
// Worker ficou fora no dia 3, no dia 4 ainda cobra o estagio 3 (uma vez so).
function estagioAlcancado(estagios, diasAtraso) {
  const passados = estagios.filter((e) => diasAtraso >= e);
  return passados.length ? Math.max(...passados) : null;
}

async function reguaCobranca(env) {
  // Busca inadimplentes (cobrancas vencidas e nao pagas).
  const venc = await asaasListarTudo(env, `/payments?status=OVERDUE`);
  if (!venc.length) {
    // Nada a cobrar: avisa o dono e encerra.
    await enviarTexto(env, `*Regua de cobranca*\nNenhuma cobranca vencida hoje. Inadimplencia zerada.`);
    return "regua: inadimplencia zerada";
  }

  const hoje = hojeSP();
  const ativa = String(env.REGUA_COBRANCA_ATIVA || "").toLowerCase() === "true";

  // Cache de nomes/telefones de cliente pra nao repetir chamada.
  const cacheCliente = new Map();
  async function dadosCliente(id) {
    if (!id) return { nome: "cliente", telefone: null };
    if (cacheCliente.has(id)) return cacheCliente.get(id);
    let out = { nome: "cliente", telefone: null };
    try {
      const c = await asaas(env, `/customers/${id}`);
      out = { nome: c.name || "cliente", telefone: c.mobilePhone || c.phone || null };
    } catch (e) {
      console.log("regua/cliente erro:", e.message);
    }
    cacheCliente.set(id, out);
    return out;
  }

  // ---- TRAVA ANTI-SPAM (dedup sem banco) --------------------------------
  // A regua so cobra quando o atraso bate EXATAMENTE um estagio.
  // Sem isso, o mesmo inadimplente receberia cobranca todo santo dia, o que
  // irrita o cliente e coloca o numero do dono em risco de bloqueio no WhatsApp.
  // Com os estagios, cada cobranca gera no maximo 1 mensagem por estagio.
  const estagios = String(env.REGUA_ESTAGIOS || "1,3,7,15,30")
    .split(",")
    .map((n) => parseInt(n.trim(), 10))
    .filter((n) => !isNaN(n));
  // Teto de disparos por rodada, pra nunca virar rajada.
  const maxEnvios = Number(env.REGUA_MAX_ENVIOS || 20);
  const pausaMs = Number(env.REGUA_PAUSA_MS || 1500);
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1) Separa quem alcancou um estagio e ainda nao foi cobrado nele.
  const cobrarHoje = [];
  let foraDoEstagio = 0;
  let jaAvisados = 0;
  for (const p of venc) {
    const diasAtraso = Math.max(diasEntre(p.dueDate, hoje), 0);
    const estagio = estagioAlcancado(estagios, diasAtraso);
    if (estagio === null) {
      foraDoEstagio++;
      continue;
    }
    // Ja cobrado neste estagio: nao repete. Esta e a trava anti-duplicata.
    if (await jaCobrado(env, p.id, estagio)) {
      jaAvisados++;
      continue;
    }
    const cli = await dadosCliente(p.customer);
    cobrarHoje.push({ p, cli, diasAtraso, estagio });
  }

  const total = venc.reduce((s, p) => s + (p.value || 0), 0);
  const fila = cobrarHoje.map(
    ({ cli, p, diasAtraso }) =>
      `- ${cli.nome} · ${brl(p.value)} · ${diasAtraso}d atraso${cli.telefone ? "" : " (sem telefone)"}`
  );

  // 2) MODO SEGURO (padrao): nao toca em cliente, so mostra a fila pro dono.
  if (!ativa) {
    const msg = [
      `*Regua de cobranca (modo revisao)*`,
      ``,
      `${venc.length} cobranca(s) vencida(s), total ${brl(total)}.`,
      `A cobrar (estagio novo): ${cobrarHoje.length}. Ja cobrados neste estagio: ${jaAvisados}. Antes do primeiro estagio: ${foraDoEstagio}.`,
      `A regua NAO enviou nada pros clientes. Para ligar o envio real, defina REGUA_COBRANCA_ATIVA = "true" no deploy.`,
      ``,
      cobrarHoje.length ? `Fila que seria cobrada hoje:` : `Ninguem bate estagio hoje.`,
      ...fila.slice(0, 30),
      fila.length > 30 ? `- e mais ${fila.length - 30}.` : null,
    ]
      .filter((l) => l !== null)
      .join("\n");
    await enviarTexto(env, msg);
    return `regua: modo seguro, ${cobrarHoje.length} no estagio de hoje (nada enviado ao cliente)`;
  }

  // 3) MODO REAL: dispara so pra quem bate estagio, com teto e pausa entre envios.
  let enviados = 0;
  let semTelefone = 0;
  for (const { p, cli, diasAtraso, estagio } of cobrarHoje) {
    if (!cli.telefone) {
      semTelefone++;
      continue;
    }
    if (enviados >= maxEnvios) break; // teto de volume, o resto fica pra proxima rodada
    // Reserva ANTES de enviar. Se um segundo disparo do cron rodar em paralelo,
    // ele ja le a marca e pula, em vez de enviar de novo. Se o envio falhar,
    // libera a reserva pra tentar na proxima rodada.
    await reservarCobranca(env, p.id, estagio);
    const texto = mensagemCobranca(env, {
      nome: cli.nome,
      valor: p.value,
      vencimento: p.dueDate,
      diasAtraso,
    });
    try {
      await enviarTexto(env, texto, cli.telefone);
      enviados++;
      await esperar(pausaMs); // respira entre um envio e outro
    } catch (e) {
      console.log("regua/envio erro:", e.message);
      await liberarCobranca(env, p.id, estagio);
    }
  }

  const restou = Math.max(cobrarHoje.length - enviados - semTelefone, 0);
  await enviarTexto(
    env,
    [
      `*Regua de cobranca*`,
      `Lembretes enviados hoje: ${enviados} de ${cobrarHoje.length} em estagio novo.`,
      jaAvisados ? `Ja cobrados neste estagio (nao repetidos): ${jaAvisados}.` : null,
      foraDoEstagio ? `Antes do primeiro estagio (nao cobrados): ${foraDoEstagio}.` : null,
      semTelefone ? `Sem telefone cadastrado: ${semTelefone}.` : null,
      restou ? `Passaram do teto de ${maxEnvios} e ficam pra proxima rodada: ${restou}.` : null,
      `Total em aberto: ${brl(total)}.`,
    ]
      .filter((l) => l !== null)
      .join("\n")
  );
  return `regua: ${enviados} lembrete(s) enviado(s), ${foraDoEstagio} fora de estagio`;
}

// =====================================================================
// 7. AUTOMACAO 5 · ALERTA DE LEAD NOVO (a cada 5 minutos)
//    Materializa a regra dos 5 minutos da rotina SDR AGL: lead que entra
//    tem que ser tocado em ate 5 minutos, senao a chance de contato despenca.
//
//    O Worker nao tem banco de estado, entao a janela e calculada pelo
//    relogio. A janela e ALINHADA a grade de 5 minutos, nunca "agora menos
//    5 minutos". Motivo: uma janela deslizante com folga se sobrepoe a
//    anterior e o mesmo lead e avisado duas vezes. Alinhando em blocos
//    fechados de 5 min ([09:55,10:00), [10:00,10:05), ...) as janelas se
//    encaixam sem sobrepor e sem deixar buraco. A dedup vem da matematica,
//    nao de um banco de estado.
//
//    Para cada lead novo: avisa o dono no WhatsApp (nome, valor, origem,
//    etapa e link) e cria uma tarefa de follow-up no proprio Kommo.
// =====================================================================

const BLOCO_SEG = 5 * 60;

async function alertaLeadNovo(env) {
  // Fecha o bloco de 5 min que acabou de passar, independente do segundo
  // exato em que o cron disparou.
  const ate = Math.floor(agoraUnix() / BLOCO_SEG) * BLOCO_SEG;
  const de = ate - BLOCO_SEG;

  const params = new URLSearchParams();
  params.set("filter[created_at][from]", String(de));
  params.set("filter[created_at][to]", String(ate));
  params.set("with", "source_id,contacts");
  params.set("limit", "50");
  const d = await kommo(env, `/leads?${params.toString()}`);
  const leads = d?._embedded?.leads || [];

  if (!leads.length) return "lead novo: nenhum na janela de 5 min";

  const cacheEtapa = new Map();
  // A urgencia dos 5 minutos vive na mensagem de WhatsApp, que chega na hora.
  // O prazo da TAREFA no CRM e maior de proposito: tarefa com prazo de 5 min
  // nasce vencida, entope o cutucao de tarefa vencida e suja o relatorio do
  // dia com um atraso que o proprio sistema criou.
  const prazoMin = Number(env.FOLLOWUP_MINUTOS || 60);
  let avisados = 0, tarefasCriadas = 0;

  for (const lead of leads) {
    const etapa = await nomeEtapa(env, cacheEtapa, lead.pipeline_id, lead.status_id);
    const origem = origemDoLead(lead);

    // 1) Avisa o dono no WhatsApp.
    const msg = [
      `*Lead novo · regra dos 5 minutos*`,
      ``,
      `Nome: ${lead.name || "(sem nome)"}`,
      `Valor: ${brl(lead.price)}`,
      `Origem: ${origem}`,
      `Etapa: ${etapa}`,
      `Entrou as ${horaSP(lead.created_at)}`,
      ``,
      `Abrir no CRM: ${linkLead(env, lead.id)}`,
      ``,
      `Toque esse lead agora. Depois de 5 minutos a chance de falar com ele despenca.`,
    ].join("\n");

    try {
      await enviarTexto(env, msg);
      avisados++;
    } catch (e) {
      console.log("lead-novo/whatsapp erro:", e.message);
    }

    // 2) Cria a tarefa de follow-up no Kommo, no prazo da regra dos 5 minutos.
    try {
      const tarefa = {
        task_type_id: 1, // 1 = contato (padrao Kommo)
        text: `Regra dos 5 minutos: falar com ${lead.name || "o lead"} agora.`,
        complete_till: agoraUnix() + prazoMin * 60,
        entity_id: lead.id,
        entity_type: "leads",
      };
      if (lead.responsible_user_id) tarefa.responsible_user_id = lead.responsible_user_id;
      await kommo(env, `/tasks`, { method: "POST", body: [tarefa] });
      tarefasCriadas++;
    } catch (e) {
      console.log("lead-novo/tarefa erro:", e.message);
    }
  }

  return `lead novo: ${leads.length} lead(s), ${avisados} aviso(s), ${tarefasCriadas} tarefa(s) criada(s)`;
}

// =====================================================================
// 8. AUTOMACAO 6 · CUTUCAO DE TAREFA VENCIDA (11h BRT)
//    Varre as tarefas vencidas e nao concluidas no Kommo, agrupa por
//    responsavel e entrega a lista pro dono. Quem esta com o que atrasado.
//
//    Por padrao a mensagem vai SO pro dono (NOTIFY_PHONE). Cutucar cada
//    pessoa do time no WhatsApp exige o telefone de cada uma e o aceite
//    dela, entao esse modo nasce desligado, igual a regua de cobranca.
//    Para ligar: CUTUCAO_INDIVIDUAL_ATIVO = "true" e CUTUCAO_TELEFONES
//    com um JSON no formato {"ID_DO_USUARIO_KOMMO": "5511999998888"}.
// =====================================================================

async function cutucaoTarefaVencida(env) {
  const params = new URLSearchParams();
  params.set("filter[is_completed]", "0");
  params.set("filter[complete_till][to]", String(agoraUnix() - 1));
  const tarefas = await kommoTudo(env, "/tasks", params, "tasks");

  if (!tarefas.length) {
    await enviarTexto(env, `*Cutucao de tarefa vencida*\nNenhuma tarefa atrasada no CRM. Time em dia.`);
    return "cutucao: nenhuma tarefa atrasada";
  }

  const users = await usuariosKommo(env);

  // Agrupa por responsavel.
  const porResponsavel = new Map();
  for (const t of tarefas) {
    const id = t.responsible_user_id || 0;
    if (!porResponsavel.has(id)) porResponsavel.set(id, []);
    porResponsavel.get(id).push(t);
  }

  const linhaTarefa = (t) => {
    const dias = Math.max(Math.floor((agoraUnix() - (t.complete_till || 0)) / 86400), 0);
    const atraso = dias >= 1 ? `${dias}d` : "hoje";
    return `  - ${t.text || "(tarefa)"} · vencida ha ${atraso}`;
  };

  // Mensagem do dono: o mapa completo de quem esta com o que atrasado.
  const blocos = [];
  for (const [id, lista] of porResponsavel) {
    const nome = users.get(id) || (id ? `usuario ${id}` : "sem responsavel");
    blocos.push(`*${nome}* (${lista.length})`);
    lista.slice(0, 8).forEach((t) => blocos.push(linhaTarefa(t)));
    if (lista.length > 8) blocos.push(`  - e mais ${lista.length - 8} tarefa(s).`);
    blocos.push(``);
  }

  const msgDono = [
    `*Cutucao de tarefa vencida · ${fmtDia(hojeSP())}*`,
    ``,
    `${tarefas.length} tarefa(s) atrasada(s) no CRM, em ${porResponsavel.size} responsavel(is).`,
    ``,
    ...blocos,
    `Tarefa atrasada e lead esfriando. Cobre a fila antes do almoco.`,
  ].join("\n");

  await enviarTexto(env, msgDono);

  // Cutucao individual: desligado por padrao (exige telefone e aceite de cada pessoa).
  const individual = String(env.CUTUCAO_INDIVIDUAL_ATIVO || "").toLowerCase() === "true";
  if (!individual) {
    return `cutucao: ${tarefas.length} atrasada(s), so o dono avisado (individual desligado)`;
  }

  let telefones = {};
  try {
    telefones = JSON.parse(env.CUTUCAO_TELEFONES || "{}");
  } catch (e) {
    console.log("cutucao/telefones erro: CUTUCAO_TELEFONES nao e um JSON valido");
  }

  let cutucados = 0;
  for (const [id, lista] of porResponsavel) {
    const fone = telefones[String(id)];
    if (!fone) continue; // sem telefone cadastrado, ninguem e cutucado
    const nome = users.get(id) || "voce";
    const msg = [
      `Oi ${String(nome).split(" ")[0]}, aqui e o Piloto Automatico da agencia.`,
      ``,
      `Voce esta com ${lista.length} tarefa(s) atrasada(s) no CRM:`,
      ...lista.slice(0, 8).map(linhaTarefa),
      lista.length > 8 ? `  - e mais ${lista.length - 8} tarefa(s).` : null,
      ``,
      `Da uma limpada nessa fila hoje.`,
    ].filter((l) => l !== null).join("\n");
    try {
      await enviarTexto(env, msg, fone);
      cutucados++;
    } catch (e) {
      console.log("cutucao/envio erro:", e.message);
    }
  }

  return `cutucao: ${tarefas.length} atrasada(s), ${cutucados} pessoa(s) cutucada(s)`;
}

// =====================================================================
// 9. AUTOMACAO 7 · FECHO DO DIA (18h30 BRT)
//    O placar do dia em uma mensagem: o que avancou, o que travou e o
//    que fica pra amanha. Leads novos e tarefas no Kommo, caixa no Asaas.
// =====================================================================

async function fechoDoDia(env) {
  const de = inicioDiaSP(0);
  const ate = inicioDiaSP(1) - 1;
  const hoje = hojeSP();

  // Leads que entraram hoje.
  let leads = [];
  try {
    const params = new URLSearchParams();
    params.set("filter[created_at][from]", String(de));
    params.set("filter[created_at][to]", String(ate));
    leads = await kommoTudo(env, "/leads", params, "leads");
  } catch (e) {
    console.log("fecho/leads erro:", e.message);
  }
  const valorLeads = leads.reduce((s, l) => s + (l.price || 0), 0);

  // Tarefas e reunioes concluidas hoje.
  let concluidas = [];
  try {
    const params = new URLSearchParams();
    params.set("filter[is_completed]", "1");
    params.set("filter[updated_at][from]", String(de));
    params.set("filter[updated_at][to]", String(ate));
    concluidas = await kommoTudo(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("fecho/concluidas erro:", e.message);
  }
  const idReuniao = Number(tipoReuniao(env));
  const reunioesFeitas = concluidas.filter((t) => t.task_type_id === idReuniao).length;

  // Tarefas que ficaram atrasadas (abertas com prazo ja vencido).
  let atrasadas = [];
  try {
    const params = new URLSearchParams();
    params.set("filter[is_completed]", "0");
    params.set("filter[complete_till][to]", String(agoraUnix() - 1));
    atrasadas = await kommoTudo(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("fecho/atrasadas erro:", e.message);
  }

  // O que fica pra amanha: tarefas abertas com prazo dentro do dia seguinte.
  let amanha = [];
  try {
    const params = new URLSearchParams();
    params.set("filter[is_completed]", "0");
    params.set("filter[complete_till][from]", String(inicioDiaSP(1)));
    params.set("filter[complete_till][to]", String(inicioDiaSP(2) - 1));
    amanha = await kommoTudo(env, "/tasks", params, "tasks");
  } catch (e) {
    console.log("fecho/amanha erro:", e.message);
  }

  // O que entrou no caixa hoje (Asaas).
  let recebido = 0, qtdRecebida = 0;
  try {
    const pagos = await asaasListarTudo(env, `/payments?status=RECEIVED&paymentDate[ge]=${hoje}&paymentDate[le]=${hoje}`);
    qtdRecebida = pagos.length;
    recebido = pagos.reduce((s, p) => s + (p.value || 0), 0);
  } catch (e) {
    console.log("fecho/recebido erro:", e.message);
  }

  const msg = [
    `*Fecho do dia · ${fmtDia(hoje)}*`,
    ``,
    `*O que avancou*`,
    `Leads novos: ${leads.length} (${brl(valorLeads)} em potencial)`,
    `Tarefas concluidas: ${concluidas.length}`,
    `Reunioes realizadas: ${reunioesFeitas}`,
    `Entrou no caixa: ${brl(recebido)} em ${qtdRecebida} cobranca(s)`,
    ``,
    `*O que travou*`,
    atrasadas.length
      ? `${atrasadas.length} tarefa(s) ficaram atrasadas:`
      : `Nenhuma tarefa atrasada. Dia limpo.`,
    ...atrasadas.slice(0, 8).map((t) => `- ${t.text || "(tarefa)"}`),
    atrasadas.length > 8 ? `- e mais ${atrasadas.length - 8}.` : null,
    ``,
    `*O que fica pra amanha*`,
    amanha.length ? `${amanha.length} tarefa(s) com prazo amanha:` : `Agenda de amanha vazia no CRM. Preencha hoje.`,
    ...amanha.slice(0, 8).map((t) => `- ${horaSP(t.complete_till)} ${t.text || "(tarefa)"}`),
    amanha.length > 8 ? `- e mais ${amanha.length - 8}.` : null,
    ``,
    atrasadas.length
      ? `Limpe a fila atrasada antes de abrir o dia de amanha.`
      : `Dia fechado. Amanha comeca na golden hour.`,
  ].filter((l) => l !== null).join("\n");

  const id = await enviarTexto(env, msg);
  return `fecho do dia enviado (messageId ${id})`;
}

// =====================================================================
// 10. ROTEAMENTO POR CRON
// =====================================================================

// UM cron so, de 5 em 5 minutos, e o despacho por horario acontece aqui dentro.
//
// Por que nao 7 crons: o plano gratuito da Cloudflare permite no maximo 5 cron
// triggers por Worker. Com 7 o deploy do cliente quebra. Como o alerta de lead
// ja precisa rodar de 5 em 5 minutos, todo o resto cabe dentro dessa mesma
// batida. Sobra folga de sobra no free e o cliente nao precisa mexer em cron
// nenhum pra ligar ou desligar automacao: e variavel de ambiente.
//
// Horarios em BRT (America/Sao_Paulo). O codigo converte, ninguem precisa
// pensar em UTC. `dia` = 1 (segunda) a 7 (domingo), ausente = todo dia.
const AUTOMACOES = [
  { chave: "alerta-lead-novo",       fn: alertaLeadNovo,        cada5min: true, silenciosa: true },
  { chave: "briefing-diario",        fn: briefingDiario,        hora: 7,  minuto: 0 },
  { chave: "review-semanal",         fn: reviewSemanal,         hora: 8,  minuto: 0, dia: 1 },
  { chave: "regua-cobranca",         fn: reguaCobranca,         hora: 9,  minuto: 0 },
  { chave: "cutucao-tarefa-vencida", fn: cutucaoTarefaVencida,  hora: 11, minuto: 0 },
  { chave: "relatorio-funil",        fn: relatorioFunil,        hora: 18, minuto: 0 },
  { chave: "fecho-do-dia",           fn: fechoDoDia,            hora: 18, minuto: 30 },
];

// Desligar automacao = variavel de ambiente, nunca editar codigo.
// Ex.: AUTOMACOES_DESLIGADAS = "relatorio-funil"  (e o downsell de R$147).
function estaLigada(env, chave) {
  const off = String(env.AUTOMACOES_DESLIGADAS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  return !off.includes(chave);
}

// Que automacoes devem rodar nesta batida de 5 minutos.
// O bloco e alinhado a grade de 5 min, entao um cron que atrasa alguns
// segundos ainda cai no bloco certo e nada roda duas vezes.
// Marca no KV que uma automacao diaria ja rodou hoje. Chave por dia, TTL 2 dias.
async function jaRodouHoje(env, chave, dia) {
  if (!env.ESTADO) return false;
  return (await env.ESTADO.get(`ran:${chave}:${dia}`)) !== null;
}
async function marcarRodouHoje(env, chave, dia) {
  if (!env.ESTADO) return;
  await env.ESTADO.put(`ran:${chave}:${dia}`, "1", { expirationTtl: 2 * 24 * 3600 });
}

async function automacoesDaVez(env, agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  }).formatToParts(agora);
  const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
  const hora = Number(p.hour) % 24;
  const minuto = Number(p.minute);
  const dia = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  const hojeStr = `${p.year}-${p.month}-${p.day}`;
  const agoraMin = hora * 60 + minuto;

  const due = [];
  for (const a of AUTOMACOES) {
    if (!estaLigada(env, a.chave)) continue;
    if (a.cada5min) { due.push(a); continue; }
    if (a.dia && a.dia !== dia) continue;

    if (env.ESTADO) {
      // Com KV: roda se a hora dela ja chegou hoje e ela ainda nao rodou.
      // Isso recupera atraso (cron que disparou 7h06 em vez de 7h) E tick
      // pulado (worker fora as 7h, volta as 8h): roda, uma vez so.
      const horaAlvoMin = a.hora * 60 + a.minuto;
      if (agoraMin < horaAlvoMin) continue;
      if (await jaRodouHoje(env, a.chave, hojeStr)) continue;
      due.push(a);
    } else {
      // Sem KV (deploy degradado): volta pro bloco exato de 5 min. Pode perder
      // um disparo se o cron atrasar, mas nunca repete nem vira spam.
      const blocoAtual = Math.floor(minuto / 5) * 5;
      if (a.hora === hora && Math.floor(a.minuto / 5) * 5 === blocoAtual) due.push(a);
    }
  }
  return due;
}

// Mapa por chave, usado pelo disparo manual de teste.
const POR_CHAVE = Object.fromEntries(AUTOMACOES.map((a) => [a.chave, a]));

// Executa uma automacao isolando o erro (nao derruba as outras execucoes).
async function rodarAutomacao(env, a) {
  try {
    const r = await a.fn(env);
    console.log(`[${a.chave}] ok: ${r}`);
    return { automacao: a.chave, ok: true, detalhe: r };
  } catch (e) {
    console.log(`[${a.chave}] FALHOU: ${e.message}`);
    // Tenta avisar o dono da falha, mas sem quebrar se o proprio aviso falhar.
    // Silenciosas (as que rodam de 5 em 5 min) so registram no log, senao vira spam.
    if (!a.silenciosa) {
      try {
        await enviarTexto(env, `*Piloto Automatico*\nA automacao "${a.chave}" falhou hoje: ${e.message}`);
      } catch (_) {}
    }
    return { automacao: a.chave, ok: false, erro: e.message };
  }
}

// Consciencia de versao (puxada). Checa o GitHub e avisa o DONO se estiver
// desatualizado. NAO manda nada pra ninguem: le so o VERSION do repo publico.
const OPERA_VERSAO = "1.0.0";
async function statusVersao() {
  const repo = "opera-piloto-automatico";
  let ultima = null, atualizado = null, aviso;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/igormoraesagl/${repo}/main/VERSION`, { cf: { cacheTtl: 3600 } });
    if (r.ok) { ultima = (await r.text()).trim(); atualizado = ultima === OPERA_VERSAO; }
  } catch (_) {}
  if (atualizado === false) {
    aviso = `Sua versao (${OPERA_VERSAO}) esta atras da ${ultima}. Reinstale pelo botao Deploy to Cloudflare do README para atualizar. Esta checagem le so o GitHub, nada e enviado a ninguem.`;
  }
  return { versao: OPERA_VERSAO, ultima, atualizado, aviso };
}

export default {
  // Um cron so (*/5). Aqui dentro decidimos o que roda nesta batida.
  async scheduled(event, env, ctx) {
    const daVez = await automacoesDaVez(env);
    if (!daVez.length) return;
    // Marca as diarias como "rodou hoje" ANTES de disparar. Se um segundo tick
    // rodar em paralelo, ele ja le a marca e nao repete. As de 5 min nao marcam
    // (o alinhamento de bloco ja dedup delas).
    const hoje = hojeSP();
    await Promise.all(
      daVez.filter((a) => !a.cada5min).map((a) => marcarRodouHoje(env, a.chave, hoje))
    );
    ctx.waitUntil(Promise.all(daVez.map((a) => rodarAutomacao(env, a))));
  },

  // Endpoint HTTP: healthcheck e disparo manual para teste.
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      const ligadas = AUTOMACOES.filter((a) => estaLigada(env, a.chave)).length;
      const versao = await statusVersao();
      return new Response(
        JSON.stringify({
          conector: "opera-piloto-automatico",
          automacoes_ligadas: `${ligadas} de ${AUTOMACOES.length}`,
          ...versao,
        }, null, 1),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Disparo manual para teste: POST /run  (corpo: {automacao, secret})
    // ou header  X-OPERA-SECRET: <MCP_SECRET>.
    // So POST: uma automacao dispara envio de WhatsApp e cobranca. Por GET, um
    // link vazado ou prefetch rodaria a regua. E o secret vai no header/corpo,
    // nunca na query, pra nao vazar em log nem no historico do navegador.
    if (url.pathname === "/run") {
      if (request.method !== "POST") {
        return new Response("use POST", { status: 405 });
      }
      let corpo = {};
      try { corpo = await request.json(); } catch {}
      const secret = request.headers.get("x-opera-secret") || corpo.secret;
      if (!env.MCP_SECRET || secret !== env.MCP_SECRET) {
        return new Response("unauthorized", { status: 401 });
      }
      const chave = corpo.automacao;
      const a = POR_CHAVE[chave];
      if (!a) {
        return new Response(
          `automacao desconhecida. Use uma de: ${Object.keys(POR_CHAVE).join(" | ")}`,
          { status: 400 },
        );
      }
      const out = await rodarAutomacao(env, a);
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
