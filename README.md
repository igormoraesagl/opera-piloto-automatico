# Piloto Automático · OPERA

As 7 automações da sua agência rodando sozinhas, direto no seu WhatsApp:
alerta de lead novo (a regra dos 5 minutos), briefing das 7h, review de segunda,
régua de cobrança, cutucão de tarefa vencida, relatório de funil e fecho do dia.

## Instalar em um clique

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/igormoraesagl/opera-piloto-automatico)

**Sem terminal.** Você clica, autoriza, cadastra as chaves e acabou.

## Depois de clicar no botão

1. Autorize a Cloudflare (ela cria o Worker na sua conta).
2. No painel da Cloudflare, abra o Worker, vá em **Settings → Variables and Secrets**
   e cadastre as chaves do `.dev.vars.example` como **Secret**.
3. Pronto. As automações começam a rodar nos horários certos, no fuso de Brasília.

O passo a passo está no [guia-ativacao.md](guia-ativacao.md).

## Ligar e desligar automação

Você nunca precisa editar código nem mexer em cron. Use a variável
`AUTOMACOES_DESLIGADAS`, com as chaves separadas por vírgula:

```
AUTOMACOES_DESLIGADAS = relatorio-funil
```

Chaves válidas: `alerta-lead-novo`, `briefing-diario`, `review-semanal`,
`regua-cobranca`, `cutucao-tarefa-vencida`, `relatorio-funil`, `fecho-do-dia`.

## Uma nota técnica que importa

As 7 automações rodam dentro de **um único agendamento**, não sete. O plano
gratuito da Cloudflare permite no máximo 5 agendamentos por Worker, então sete
crons simplesmente não publicariam. O Worker bate de 5 em 5 minutos e decide na
hora o que disparar. Cabe no free com folga.

## Onde o seu dado fica

Na sua conta Cloudflare, com as suas chaves. Não existe servidor nosso no meio.

## Como saber se precisa atualizar

Abra a URL do seu Worker no navegador (a raiz, sem `/mcp`). Ela responde a versão que você está rodando e, se sair uma nova, avisa. Essa checagem lê só o número de versão aqui do GitHub. **Nada do seu dado é enviado pra ninguém**, coerente com a ideia de que a sua operação fica com você.

Pra atualizar quando aparecer versão nova: clique de novo no botão **Deploy to Cloudflare** acima. Ele republica o Worker com o código mais recente. As suas chaves e configurações continuam.

---
*Parte do [OPERA](https://github.com/igormoraesagl), o sistema operacional da agência rodando dentro do Claude.*
*Feito por Agências Lucrativas · Método AGL*
