# OPERA Piloto Automático · Guia de ativação

Sua agência mandando os relatórios sozinha, todo dia, no seu WhatsApp. Sem você abrir o CRM, sem você conferir o financeiro na mão, sem depender de ninguém do time lembrar. É isso que o Piloto Automático faz: um robozinho na nuvem que acorda no horário certo, lê seus números reais e te manda o resumo pronto.

São 7 automações rodando em cima dos seus sistemas (Kommo, Asaas e seu WhatsApp via Z-API):

1. **Briefing diário (7h):** agenda e tarefas do dia no CRM, mais saldo em caixa e o que entra nos próximos 7 dias.
2. **Régua de cobrança (9h):** varre os inadimplentes no Asaas e monta o lembrete certo por tempo de atraso.
3. **Cutucão de tarefa vencida (11h):** quem do time está com o que atrasado no CRM, agrupado por responsável.
4. **Relatório diário de funil (18h):** leads novos, reuniões marcadas e tarefas atrasadas travando a operação.
5. **Fecho do dia (18h30):** o placar do dia. O que avançou, o que travou e o que fica pra amanhã.
6. **Review semanal (segunda, 8h):** o placar da semana. Leads, reuniões, negócios fechados e financeiro.
7. **Alerta de lead novo (a cada 5 minutos):** lead que cai no CRM vira WhatsApp no seu celular na hora, com nome, valor, origem, etapa e link. E o robô já abre a tarefa de follow-up no Kommo pra quem for responsável.

A número 7 é a mais importante das três novas. Ela materializa a regra dos 5 minutos da rotina SDR AGL: lead respondido em até 5 minutos converte muito mais que lead respondido em uma hora. Sua agência para de perder lead por demora e passa a atacar no minuto em que ele levanta a mão.

Este produto ataca a donodependência de frente: o dono para de ser o painel de controle vivo da agência. Quem operava no escuro passa a começar o dia sabendo exatamente onde pisar.

---

## Antes de começar: pré-requisitos

Você precisa de três contas ativas e das chaves de acesso de cada uma. Separe tudo antes de subir o Worker.

**1. Kommo (CRM)**
- Conta Kommo com seu funil montado e leads entrando.
- Um token de acesso de longa duração (token de integração privada).
- O subdomínio da sua conta (a parte antes de `.kommo.com`).

**2. Asaas (financeiro)**
- Conta Asaas com suas cobranças cadastradas.
- A chave de API (encontra em Configurações, Integrações, API).
- A chave que começa com `$aact_hmlg_` é de teste (sandbox). A de produção não tem esse prefixo. O Worker detecta sozinho qual ambiente usar pelo formato da chave.

**3. Z-API (WhatsApp)**
- Instância Z-API com seu número de WhatsApp já pareado e conectado.
- ID da instância, token da instância e o Client-Token da conta.

**4. Ferramenta de deploy**
- Node.js instalado no computador.
- Wrangler, a ferramenta de linha de comando da Cloudflare (`npm install -g wrangler`).
- Uma conta Cloudflare gratuita. As 7 automações rodam dentro de um único agendamento, justamente porque o plano gratuito da Cloudflare permite no máximo 5. Com um só, sobra folga.

---

## Passo a passo do deploy

**1. Entre na pasta do Worker**

```
cd upsell-piloto-automatico/worker
```

**2. Faça login na sua conta Cloudflare**

```
wrangler login
```

Abre o navegador e pede pra você autorizar. O Worker vai publicar na conta em que você logar aqui.

**3. Crie o KV de estado (uma vez)**

A régua de cobrança guarda "esta cobrança já foi cobrada neste estágio" pra nunca cobrar o mesmo cliente duas vezes. Isso mora num KV, que você cria uma vez:

```
wrangler kv namespace create ESTADO
```

O comando imprime um `id`. Acrescente esse `id` no bloco `[[kv_namespaces]]` do `wrangler.toml`, na linha do binding `ESTADO`. (Se você instalar pelo botão Deploy to Cloudflare em vez do terminal, esse passo é automático: a Cloudflare cria o KV sozinha.)

**4. Cadastre os secrets (as chaves de acesso)**

Os secrets ficam guardados na Cloudflare, nunca dentro do código. Rode um comando por chave. O Wrangler pergunta o valor e você cola.

```
wrangler secret put KOMMO_TOKEN
wrangler secret put KOMMO_SUBDOMAIN
wrangler secret put ASAAS_API_KEY
wrangler secret put ZAPI_INSTANCE_ID
wrangler secret put ZAPI_INSTANCE_TOKEN
wrangler secret put ZAPI_CLIENT_TOKEN
wrangler secret put NOTIFY_PHONE
wrangler secret put MCP_SECRET
```

O que cada um guarda:

| Secret | O que é |
|---|---|
| `KOMMO_TOKEN` | Token de integração privada do Kommo |
| `KOMMO_SUBDOMAIN` | Seu subdomínio Kommo (a parte antes de .kommo.com) |
| `ASAAS_API_KEY` | Chave de API do Asaas |
| `ZAPI_INSTANCE_ID` | ID da instância Z-API |
| `ZAPI_INSTANCE_TOKEN` | Token da instância Z-API |
| `ZAPI_CLIENT_TOKEN` | Client-Token da conta Z-API |
| `NOTIFY_PHONE` | Seu WhatsApp, só dígitos com DDI e DDD (ex.: `5511999998888`). É pra onde vão os relatórios. |
| `MCP_SECRET` | Uma senha que você inventa. Protege o disparo manual de teste. |

Nenhuma chave nova entrou com as automações de lead novo, cutucão e fecho do dia. Elas usam as mesmas conexões de Kommo, Asaas e Z-API que você já cadastrou acima. O que existe são três ajustes opcionais, e todos têm padrão que funciona sem você mexer:

| Ajuste opcional | Para que serve | Padrão |
|---|---|---|
| `FOLLOWUP_MINUTOS` | Prazo da tarefa de follow-up criada no Kommo quando um lead novo entra. A urgência dos 5 minutos vive na mensagem de WhatsApp, que chega na hora. | `60` |
| `CUTUCAO_INDIVIDUAL_ATIVO` | Liga o cutucão direto no WhatsApp de cada pessoa do time | desligado |
| `CUTUCAO_TELEFONES` | Mapa de telefone por pessoa, usado só se o cutucão individual estiver ligado | vazio |

**5. Publique o Worker**

```
wrangler deploy
```

Pronto. A partir daqui as 7 automações estão agendadas e disparam sozinhas nos horários certos.

**6. Teste sem esperar o horário**

Você não precisa esperar até amanhã de manhã pra ver funcionando. Cada automação tem um disparo manual protegido pela sua `MCP_SECRET`. Depois do deploy, o Wrangler mostra a URL pública do Worker (algo como `https://opera-piloto-automatico.SEU-SUBDOMINIO.workers.dev`).

O disparo é por **POST**, não pelo navegador, de propósito: um endereço que roda a régua ou manda WhatsApp não pode ser aberto por engano num clique ou num prefetch. Rode no terminal, trocando a automação e a senha:

```
curl -X POST https://SEU-WORKER.workers.dev/run \
  -H "X-OPERA-SECRET: SUA_SENHA" \
  -H "Content-Type: application/json" \
  -d '{"automacao":"briefing-diario"}'
```

As chaves de cada automação:

| Automação | Chave |
|---|---|
| Briefing diário | `briefing-diario` |
| Régua de cobrança | `regua-cobranca` |
| Cutucão de tarefa vencida | `cutucao-tarefa-vencida` |
| Relatório de funil | `relatorio-funil` |
| Fecho do dia | `fecho-do-dia` |
| Review semanal | `review-semanal` |
| Alerta de lead novo | `alerta-lead-novo` |

Se o WhatsApp chegar, está no ar.

Um detalhe do teste do alerta de lead novo: ele olha só os últimos 5 minutos. Se você disparar o teste e não tiver entrado lead nenhum agora há pouco, ele responde que não achou nada, e isso é o comportamento certo. Para ver a mensagem chegando, cadastre um lead de teste no Kommo e rode o disparo manual logo em seguida.

---

## Nota sobre horários

Você não precisa pensar em fuso. O Worker roda um agendamento só, de 5 em 5 minutos, e decide na hora o que disparar já no horário de Brasília. Não existe conta de UTC pra fazer, nem cron pra editar.

| Automação | Horário |
|---|---|
| Alerta de lead novo | o dia inteiro, de 5 em 5 minutos |
| Briefing diário | 7h |
| Review semanal | segunda, 8h |
| Régua de cobrança | 9h |
| Cutucão de tarefa vencida | 11h |
| Relatório de funil | 18h |
| Fecho do dia | 18h30 |

O alerta de lead novo é o único sem hora marcada, porque lead não escolhe horário pra entrar.

**Pra desligar uma automação**, não mexa em código nem em cron. Cadastre a variável `AUTOMACOES_DESLIGADAS` com as chaves separadas por vírgula:

```
wrangler secret put AUTOMACOES_DESLIGADAS
# valor, por exemplo: relatorio-funil,cutucao-tarefa-vencida
```


---

## Régua de cobrança: liga desligada de propósito

Atenção redobrada aqui. A régua de cobrança é a única automação que fala com o **cliente do cliente**, não com você. Um lembrete de cobrança mal disparado queima a relação com quem paga sua agência.

Por isso ela nasce em **modo revisão**. Enquanto você não liberar, ela varre os inadimplentes, monta as mensagens e manda só um resumo pra você conferir quem seria cobrado e com qual texto. Nenhum cliente recebe nada.

Quando você revisar a fila e confiar no texto, ligue o envio real com um secret:

```
wrangler secret put REGUA_COBRANCA_ATIVA
```

Coloque o valor `true`. A partir daí a régua passa a mandar o lembrete direto pro WhatsApp de cada inadimplente, com o tom ajustado por tempo de atraso (mais leve nos primeiros dias, mais firme conforme atrasa).

### A trava anti-spam (ligada sempre, não dá pra desligar por acidente)

A régua **não cobra todo mundo todo dia**. Ela trabalha por estágios de atraso: **1, 3, 7, 15 e 30 dias**. Cada cobrança em aberto recebe no máximo uma mensagem por estágio, cinco no mês inteiro, com o tom subindo conforme atrasa.

E cada mensagem sai **uma vez só**. A régua grava no KV de estado quando cobrou uma fatura num estágio, então nem um disparo duplicado da Cloudflare nem um teste manual repetem a cobrança. Se o robô ficar fora no dia exato de um estágio, ele recupera na próxima rodada, ainda uma vez só. O cliente do seu cliente nunca recebe a mesma cobrança duas vezes.

Isso protege duas coisas ao mesmo tempo. O seu cliente, que não recebe cobrança repetida e não passa a te odiar. E o seu número, porque WhatsApp bloqueia quem dispara repetição em massa.

Três ajustes opcionais, todos com padrão seguro:

```
wrangler secret put REGUA_ESTAGIOS      # padrão "1,3,7,15,30". Os dias de atraso que disparam cobrança
wrangler secret put REGUA_MAX_ENVIOS    # padrão 20. Teto de disparos por rodada, pra nunca virar rajada
wrangler secret put REGUA_PAUSA_MS      # padrão 1500. Pausa entre um envio e outro, em milissegundos
```

Quem passar do teto do dia não é esquecido, fica pra próxima rodada. E no modo revisão (o padrão), o resumo já te mostra quantos batem estágio hoje e quantos estão em atraso mas fora de estágio.

Dois secrets opcionais deixam a mensagem mais sua:

```
wrangler secret put NOME_EMPRESA     # nome da sua agência na assinatura do lembrete
wrangler secret put LINK_PAGAMENTO   # um link de pagamento fixo pra facilitar o acerto
```

Recomendação de dono pra dono: rode uma semana inteira em modo revisão antes de ligar o envio real. Você vai calibrar o texto e pegar confiança no alcance.

---

## Alerta de lead novo: a regra dos 5 minutos virando código

Essa é a automação que mais devolve dinheiro. A cada 5 minutos o Worker pergunta ao Kommo se entrou lead. Entrou, você recebe no WhatsApp: nome, valor, origem, etapa do funil, horário de entrada e o link pra abrir a ficha. No mesmo movimento ele cria a tarefa de follow-up no Kommo, no responsável do lead, com prazo de 5 minutos.

Por que 5 minutos e não 30: a rotina SDR AGL trata o inbound como perecível. Lead que levanta a mão está com o problema na cabeça naquele instante. Meia hora depois ele já falou com outros dois concorrentes ou já esqueceu que preencheu o formulário.

Se você quiser um prazo diferente na tarefa de follow-up, cadastre o ajuste:

```
wrangler secret put FOLLOWUP_MINUTOS
```

Coloque só o número de minutos. Sem esse ajuste, o padrão é 5.

Se o volume de lead da sua agência for alto e o WhatsApp virar barulho, a saída não é desligar o alerta. É reduzir a janela de horário no `wrangler.toml`, como está explicado na nota de fuso acima.

---

## Cutucão individual: nasce desligado, e é de propósito

O cutucão de tarefa vencida manda, todo dia às 11h, a lista de quem está com o que atrasado no CRM. Por padrão essa lista vai só pro **seu** WhatsApp, o do `NOTIFY_PHONE`. Você olha o mapa e decide como cobrar cada pessoa.

Existe um segundo modo, em que o robô cutuca cada pessoa do time direto no WhatsApp dela. Ele vem desligado pelo mesmo motivo da régua de cobrança: mandar mensagem automática pro celular de alguém exige duas coisas que só você pode garantir. Primeiro, o telefone correto de cada pessoa. Segundo, o aceite dela, porque robô cobrando no WhatsApp pessoal sem combinar antes gera atrito no time em vez de resolver atraso.

Combine com o time, colete os telefones e só então ligue:

```
wrangler secret put CUTUCAO_INDIVIDUAL_ATIVO   # valor: true
wrangler secret put CUTUCAO_TELEFONES
```

O `CUTUCAO_TELEFONES` recebe um JSON que liga o ID do usuário no Kommo ao WhatsApp dele, só dígitos, com DDI e DDD:

```
{"1234567":"5511999998888","7654321":"5511988887777"}
```

Os IDs de usuário aparecem na tela de usuários do Kommo. Quem não estiver nesse mapa simplesmente não recebe cutucão nenhum. Você continua recebendo o resumo completo de qualquer jeito.

---

## Downsell R$147 (versão essencial)

A versão essencial custa R$147 e roda com 6 automações no lugar de 7. O que sai é o **relatório diário de funil**. Continuam de pé o alerta de lead novo, o briefing da manhã, o review semanal, a régua de cobrança, o cutucão de tarefa vencida e o fecho do dia.

Ligar essa versão é cadastrar uma variável. Nada de editar arquivo:

```
wrangler secret put AUTOMACOES_DESLIGADAS
# valor: relatorio-funil
```

Pronto. O relatório de funil para de disparar e o resto continua igual.

---

## Se der erro

**Não chegou nenhum WhatsApp no teste.**
Confira primeiro se a instância Z-API está pareada e conectada. Depois cheque se o `NOTIFY_PHONE` está só com dígitos, incluindo DDI 55. Os logs ajudam: rode `wrangler tail` e dispare o teste de novo pra ver a mensagem de erro na hora.

**Chegou o briefing mas veio sem os números do CRM ou do financeiro.**
Cada automação isola o próprio erro, então uma parte pode falhar sem derrubar o resto. Se faltou o dado do Kommo, revise `KOMMO_TOKEN` e `KOMMO_SUBDOMAIN`. Se faltou o financeiro, revise a `ASAAS_API_KEY`. Os logs em `wrangler tail` apontam qual chamada falhou.

**O horário chegou errado.**
Reveja a conta de fuso. O valor no `wrangler.toml` fica em UTC, que é o horário de Brasília mais 3 horas.

**O disparo manual respondeu "unauthorized".**
O `secret=` da URL precisa bater exatamente com o valor que você cadastrou em `MCP_SECRET`.

**O alerta de lead novo não chegou, mas o lead entrou.**
A janela é curta de propósito: ele olha o bloco de 5 minutos que acabou de fechar. Lead importado em lote ou cadastrado com data retroativa fica fora da janela. Confira também no `wrangler tail` se a chamada de criação de tarefa deu erro de permissão, porque o token do Kommo precisa ter direito de escrita, não só de leitura.

**O mesmo lead chegou duas vezes no WhatsApp.**
Não deve acontecer. As janelas são blocos fechados de 5 minutos que se encaixam sem sobrepor, então o mesmo lead não cai em duas. Se acontecer mesmo assim, é o lead que foi criado duas vezes no Kommo. Confira no CRM antes de suspeitar da automação.

**Números de fechados vieram zerados no review.**
A automação conta como fechado o lead na etapa de venda ganha do Kommo (a 142, que é o padrão). Se o seu funil usa outra etapa de ganho, cadastre o número dela em `KOMMO_STATUS_GANHO` com `wrangler secret put`. Não edite código.

---

*Feito por Agências Lucrativas · Método AGL*
