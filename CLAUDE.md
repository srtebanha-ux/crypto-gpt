# Regras deste projeto

Escritas em 2026-09-27, depois de dez leituras erradas minhas em um dia. A dona
do bot perguntou: "o que precisamos pra voce parar de errar?". Eu classifiquei
os dez erros e todos caíram em quatro causas. Nenhuma delas era falta de
pesquisa, prompt ruim ou informação que faltasse dela.

Estas quatro regras existem para as próximas sessões, que não vão lembrar de
nada disto.

## 1. Nunca afirme um número que você não RODOU

Três dos dez erros foram aritmética minha numa mensagem:

- "o lance sai inteiro até US$ 11,69" — era US$ 6,90. Eu olhei o corte do gás
  adiantado e esqueci que `gorjetaQueCabeNoSaldo` corta antes, pela fração de
  risco.
- "o bot para de atirar em US$ 11,69" — para em US$ 66,76. Eu misturei duas
  perguntas diferentes.
- "a baleia de US$ 95M dá prejuízo de US$ 44M" — dá lucro de US$ 1.986, porque
  cobrir metade é escolha nossa e não obrigação da Aave.

E o inverso vale: **todo número que eu acertei veio de rodar código.** Todo
número que eu errei veio da minha cabeça.

Então: antes de escrever um número numa resposta, escreva um arquivo temporário
que importe a função de verdade e a rode. Se isso não for possível, diga que é
estimativa, em voz alta, na mesma frase.

## 2. Procure a medição que já existe ANTES de calcular

Dois erros foram eu inventando um número que o repositório já tinha medido:

- O log imprimiu "uma queda de 10% vale US$ 2.161.328". O verdadeiro é uns
  US$ 2.000. `src/venda.ts` já tinha a curva de escorregamento medida no pool, e
  o cabeçalho dele AVISA deste exato erro. Eu calculei de novo em vez de usar.
- "CONCENTRADO em poucos endereços" para 17 liquidantes com o maior levando 20%.
  Eu inventei o limiar `liquidantes < liquidações/2`, que não mede concentração
  nenhuma.

Então: `grep` o repositório pela grandeza antes de escrever uma fórmula nova.
`src/contratos.ts` guarda medições com endereço e data. `src/venda.ts` tem a
curva do pool. Se já existe, use; se discordar, diga por quê.

## 3. Uma regra em dois lugares é a mesma regra. Conserte os dois

Três erros foram eu consertar uma ponta e deixar a gêmea:

- O modo prova soltou o portão do TIRO e não soltou o filtro da SELEÇÃO — os
  alvos que ele existe para atirar ficaram fora da brasa.
- `pisoUsado` caiu no default porque o saldo era lido DEPOIS do placar.
- `faixaQueAtira` passou a devolver `null` na ponta de baixo ("não há piso") e
  continuou devolvendo o chão da varredura na ponta de cima. Mesma função, mesmo
  dia.

Então: depois de mudar uma regra, `grep` por todos os lugares que a implementam
— e por todos os lugares que a LEEM. Se dois lugares calculam a mesma coisa,
junte num só em vez de sincronizar na mão.

## 4. Não extrapole de uma janela pequena quando o histórico está disponível

Eu disse "a Aave da Base pode ter secado" a partir de 23 horas de observação. O
censo de 9,3 dias mostrou **61 liquidações, 6,6 por dia, ~198 por mês**.

A função `quandoFoiAUltimaLiquidacao` parava na primeira janela com achado e
jogava 8,7 dias de histórico fora. A resposta estava a um `eth_getLogs` de
distância, custando 3.000 CUs.

Então: antes de concluir "não tem", varra o histórico. Ele é barato e não
depende de esperar nada acontecer.

## A rede: LIBERADA em 2026-09-27

`mainnet.base.org` está na allowlist do ambiente. Dá para conferir a Base
direto daqui, em segundos. Isto resolveu a causa-raiz de metade dos dez erros:
antes, cada fato da rede custava um deploy e alguém colar o log — vinte minutos
por pergunta — e era esse atrito que me fazia preencher buracos com inferência.

Duas armadilhas medidas na hora de usar:

1. **O `fetch` do Node ignora o `HTTPS_PROXY`** e cai num caminho de rede com
   política mais estreita: ele devolve `Host not in allowlist` enquanto o
   `curl` passa, no MESMO instante. Use um dispatcher explícito:

   ```ts
   import { ProxyAgent, fetch } from 'undici';
   const agente = new ProxyAgent(process.env.HTTPS_PROXY!);
   await fetch(RPC, { dispatcher: agente, ... });
   ```

2. **O RPC público tem limites**, e eles falham em silêncio se você não olhar:
   `eth_getLogs` recusa acima de 2.000 blocos, e requisições em rajada são
   barradas. Sem repetição com espera, uma varredura devolve "0 encontrados",
   que é resposta falsa com cara de medição. Na primeira tentativa eu li 86,3%
   dos devedores e o script se recusou a concluir; com espera maior deu 100%.
   **Sempre declare a cobertura ao lado do resultado.**

Primeiro uso, em 2026-09-27: varri 3.286 devedores da Base e medi o degrau de
2% de forma independente. Deu US$ 89,55; o bot, com outro RPC, outra janela e
outro código, dizia US$ 91. **1,6% de diferença.** Foi a primeira vez que os
números do bot foram conferidos por fora.

Ainda assim: **peça o log quando a dúvida for sobre o que o bot ESTÁ fazendo.**
A rede diz o que é verdade na blockchain; só o log diz o que o bot entendeu.

## Como este projeto mede o próprio erro

O defeito que mais aparece aqui tem nome: **ausência com cara de resposta** —
um número que o algoritmo inventou (o chão de uma varredura, um default
esquecido, um piso desatualizado) publicado como se fosse medição.

Todo conserto vira teste com o caso real que o expôs, e o comentário diz o
número medido e a data. Não é zelo: é o único jeito de a próxima sessão não
repetir. Em 2026-09-27 os testes foram de 949 para 1.214 por causa disso.
