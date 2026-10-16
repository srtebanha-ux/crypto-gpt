# CHECKPOINT — leia isto antes de abrir qualquer outro arquivo

Memória técnica curta, para a próxima sessão não refazer investigação já
concluída. Não é histórico de conversa. Atualize em vez de acrescentar.

## Último commit funcional

`8817b87` + esta rodada (ver `git log -1`). Branch isolada
`claude/morpho-auditoria-rest`. PR #4 fica em rascunho, sem merge.

## Comprovado (com o teste/medição que prova)

| O quê | Prova |
| --- | --- |
| Execução atômica V3+Aerodrome, lucro ao cofre | `forkTests/aMistaQueFecha.js` — recibo status=1, 59.853.488.504.744.915 wei (deslocamento INDUZIDO: prova o executor, não oportunidade) |
| Cotador por **state override**, sem deploy | mesma rota mista, `cotar` por override == contrato implantado, **diferença 0** |
| QuoterV2 `0x3d4e44eb…b76a` serve a fábrica `0x33128a8f…` | `quoter.factory() == pool.factory()`; V3+V3 confere ao wei (9.939.992.138.238.505) |
| `pending` é estado pré-confirmado real | leva 1–182 txs, lidera `latest`, cotação difere |
| `eth_call` com override de estado | aceito em `mainnet.base.org` (código de 10 bytes devolveu 42) |
| Lote JSON-RPC | aceito (3 pedidos → 3 respostas) |
| Multicall até 400 chamadas | 601 leituras em 3 pedaços, 0 perdidas |
| Detecção INTRABLOCO | `src/cotarMista.test.ts` (3 estados no mesmo bloco) **e** ao vivo: `mudancasIntrabloco: 3` |
| ESTADO_INCONSISTENTE | ao vivo, 3 e 1 ocorrências em corridas de 3 min |
| Teto de spread do Aerodrome volatile | demonstrado de `x·y=k`: `rSai/rEntra`. Stable NÃO é descartado |
| Dimensionamento por venue que empresta | `src/cacarArbitragem.test.ts` (A←Aerodrome, B←saldo do V3) |

## Hipóteses REFUTADAS — não reabrir sem contraexemplo novo

- "A gorjeta não compra posição na Base" — falsa: compra DENTRO da fatia
  (Flashblocks), `F(g)` medida.
- "36/36 expiraram no mercado" — era custo de laboratório (fork histórico).
  **Retirada.**
- "O mercado só tem 2 rotas mistas" — era o leitor: per-call lia 89 de 286;
  multicall lê 212 de 212 e dá 32 rotas.
- "`getAmountOut(epsilon)/epsilon` é razão máxima" — não é; produz falso
  negativo (reproduzido: rota com +0,0442 WETH era descartada).
- "Precisa gastar ETH/deploy para cotar" — falsa: override de estado.
- "O QuoterV2 oficial serve as rotas mistas" — falsa: **0 de 4**; as rotas
  mistas reais usam V3 de outra fábrica (medido em 15 blocos: zero rotas mistas
  com pool V3 canônico).

## OS VENCEDORES, classificados POR TRANSAÇÃO (2026-10-16)

`.tmp/reconciliado.json`: 7 de 40 operações com líquido reconciliado positivo,
**7/7 com recibo na corrente**. Sequência real de cada uma (C = pool
concentrado, A = Aerodrome), e se é CICLO FECHADO de 2 pools no mesmo par:

| tx | forma | ciclo fechado V3↔V3 | líquido (wei) |
| --- | --- | --- | --- |
| `0x0aa98647` | CC (2) | **NÃO** — pools WETH/USDC e USDC/TOKEN, não compartilham o par | 27.025.304.662.802.249 |
| `0x5b1a4ba5` | ACCC (4) | não (multihop) | 20.456.182.645.360.211 |
| `0x6966a108` | CA (2) | não (misto, já coberto) | 17.462.535.561.583.631 |
| `0xa72914e1` | AC (2) | não (misto, já coberto) | 1.907.651.085.753.665 |
| `0x12226f04` | CC (2) | **SIM** — WETH/USDC em duas fábricas (`0x33128a8f` e `0x38015d05`), fees 100/450 | 235.492.231.595.889 |
| `0x8d6dd352` | ACC (3) | não (multihop) | 225.701.082.603.133 |
| `0xd87a644b` | CCCA (4) | não (multihop) | 160.606.596.118.558 |

**CORREÇÃO REGISTRADA:** dizer "os vencedores são predominantemente V3↔V3" era
errado. Por transação: **1 de 7** é ciclo fechado V3↔V3, 2 de 7 são mistos de 2
pernas (forma já coberta) e 3 de 7 são multihop de 3–4 pernas (fora do
executor). A maior "CC" não é ciclo fechado — classificar por sequência de
topics sem conferir o grafo de tokens foi defeito meu.

Potencial ao vivo, 40 blocos, fee tiers LIDOS: 156 pares concentrados no mesmo
token (131 cruzando fábrica); **156 direções passam sem taxa** (filtro trivial)
e **21 sobrevivem às duas taxas** — todas em USDC, todas cruzando fábrica. É
potencial BRUTO no tamanho infinitesimal, não lucro líquido.

## MECANISMO vs RENTABILIDADE — separados (2026-10-16)

`forkTests/oCicloV3ContraV3.js`, fork no bloco ANTERIOR ao da operação
`0x12226f04` (a ÚNICA das 7 que é ciclo fechado de dois pools no mesmo par):

    GERADOR 2 rotas | FILTRO 1 passou, 1 descartada com prova
    COTAÇÃO por override: melhor BRUTO 108.878.689.617 wei
    EXECUÇÃO: recibo status=1 | gás MEDIDO 372.944 | cofre reconciliado
    cotação == realizado (asserido): 108.878.689.617

    TESTE_DE_RENTABILIDADE, custo COMPLETO:
      L2 9.145.984.301.168 (372.944 × 4.523.747+20.000.000) + L1 4.348.819.154 (teto)
      LÍQUIDO -9.041.454.430.705 wei   >>> DEFICITÁRIA
      ponto de equilíbrio 0,000291943 gwei contra baseFee+gorjeta 0,0245 gwei
      = 84x acima do que a operação suporta

**O executor é FUNCIONAL, não lucrativo.** Receber WETH não é ganhar dinheiro, e
o teste agora mede o líquido com gás do recibo, L1 por teto, gorjeta e margem.
A escada escolhe o melhor LÍQUIDO (o gás é quase constante no tamanho), e o
`assert.ok(true)` que fazia a prova nunca poder reprovar foi removido.

## O COMPARADOR DE ESTADO ESTAVA QUEBRADO — e a conclusão de latência caiu

**DEFEITO (achado por ela em `9f08261`):** havia DUAS serializações do snapshot,
escritas à mão, e discordavam por construção:

    antes da cotação:   `v3:${sqrt}/L${liq}`
    depois da cotação:  `v3:${sqrt}`

Todo pool V3 comparava DIFERENTE mesmo parado. Daí os "5.819 de 5.823
ESTADO_INCONSISTENTE" — número do meu comparador, não do mercado. **A conclusão
de que a latência era o impedimento principal está RETIRADA.**

CONSERTO: `impressaoDosPools` é UMA função pura, chamada pelos dois lados, e
`compararEstados` tem TRÊS respostas — CONSISTENTE, INCONSISTENTE e
NAO_VALIDADA. Leitura incompleta tem classificação própria: não é mudança
confirmada nem estado validado. Sete testes de regressão, um deles lendo o
CÓDIGO para proibir uma segunda serialização à mão.

E consertando eu APAGUEI o bloco de deduplicação por impressão. O próprio funil
denunciou na mesma corrida — "0 ESTADO(S) DISTINTO(S)" ao lado de "136 com pool
de rota alterado" — e está restaurado.

## OBSERVAÇÃO COM O COMPARADOR CORRIGIDO — 5 min, teto de 60 estados

    64 amostras lidas -> 62 ESTADOS DISTINTOS (2 repetidos descartados)
    19 mudanças INTRABLOCO | 298 rotas | 223 pools V3 + 25 Aerodrome

    ESTADO:  116 CONSISTENTE | 114 INCONSISTENTE | 2.683 NÃO VALIDADO
    SINAIS:  2.913 = 1.287 cotação LEGÍVEL + 1.626 OPACA  (a soma fecha)
    42 sinais com lucro BRUTO positivo | 0 com lucro LÍQUIDO positivo

**Das inconsistências que o comparador pode julgar, 114 de 230 (49,6%) são
reais** — não 99,9%. As 2.683 NÃO VALIDADO são releitura incompleta (RPC
público com 298 rotas), antes contadas como "inconsistente" por comparar nulo
com nulo: eram falsas. **Lucro líquido: ZERO.**

E a reconciliação que ela pediu: SINAL ≠ COTAÇÃO. Cada sinal é uma rota avaliada
num estado; cada um gerou um `eth_call` de cotação, enviados em LOTE JSON-RPC
(um lote por estado, N pedidos). Na corrida anterior os "101" eram lotes
contados errado contra 5.823 sinais; agora as duas contas fecham.

## CONCORRENTE 0x7b579d9d… — o que É verificável na corrente (2026-10-16)

    bytecode                 13.091 bytes (o nosso: 6.794)
    MIN_PROFIT               ENCONTRADA no bytecode
    POOL_FLASH_FAILED        ENCONTRADA
    NO_CALLBACK_ADAPTER      ENCONTRADA
    TAIL_NOT_AFTER_LOOP      ENCONTRADA
    seletores de callback conhecidos, como substring:  NENHUM

As quatro strings que a fonte dela cita existem de fato. A ausência dos
seletores de callback como substring é **indício, não prova**: ela é compatível
com despacho dinâmico — e `NO_CALLBACK_ADAPTER` sugere um REGISTRO de
adaptadores em vez de nomes fixos, que é a diferença arquitetural observável.

**NÃO verificado por mim:** volume de US$ 9,9M, 17.122 transações, 137 EOAs e
95,6% de reversões vêm da fonte dela, não da minha medição. **Lucro líquido do
concorrente: DESCONHECIDO.** Volume não é lucro, e não reconciliei nenhuma
operação dele.

## QUAL CALLBACK CADA FÁBRICA EXIGE — medido pela própria corrente

Método: uma SONDA de 12 bytes (`6004600060003760206000fd`) injetada por override
de estado no `recipient` do `swap`. Ela copia os 4 primeiros bytes do calldata
que recebe e REVERTE com eles — então o pool diz o nome do callback, em vez de
eu adivinhar.

    0x5e7bb104 / 0xf8f2eb49 / 0x33128a8f / 0x0fd83557 / 0xaa5865dc / 0xc35dadb6
       51 pools  ->  uniswapV3SwapCallback (0xfa461e33)   TITAN JÁ COBRIA
    0x6e606cf9   1 pool   ->  algebraSwapCallback (0x2c8958f6)   FALTAVA
    0x70fe4a44   1 pool   ->  0x3a1c453c (nome NÃO determinado)  continua fora

**PancakeSwap V3 (`pancakeV3SwapCallback`) NÃO apareceu nesta janela.** A
ressalva dela era prudente, mas não é o bloqueio atual: 51 de 53 pools com par
WETH usam o callback que já tínhamos.

## A MELHORIA DESTA RODADA — só o callback comprovadamente ausente

`algebraSwapCallback` adicionada ao `CacadorV3` como APELIDO do mesmo corpo
(`_pernaConcentrada`), com os mesmos portões. Não é lógica nova: o Algebra
herdou a interface do V3 e trocou o nome. Contrato em 6.794 bytes.

Nada foi adicionado para `0x3a1c453c`: o nome não foi determinado, e declarar
um callback por adivinhação abriria uma porta cujo chamador não sei
identificar. Limitação medida: 1 pool de 53.

**A/B VÁLIDO, com controle positivo (2026-10-16).** O A/B anterior era inválido
e está substituído. Método: o MESMO bytecode, com o seletor `0x2c8958f6`
trocado por `0x2c8958f7` — ablação que torna a função inalcançável e deixa todo
o resto idêntico. Mesmo pool, mesmo estado, mesmo tamanho:

    pool Algebra WETH/USDC 0x256f3997… (de `poolByPair`, não de memória)

    rota COM o pool Algebra   COM alias -> LEGÍVEL (LucroInsuficiente)
                              SEM alias -> SEM DADO (opaca)
    rota COM o pool Algebra   COM alias -> LEGÍVEL (PagamentoCurto)
                              SEM alias -> SEM DADO (opaca)
    CONTROLE só Uniswap       COM alias -> LEGÍVEL | SEM alias -> LEGÍVEL

O controle legível nas duas versões é o que torna o teste válido: a ablação não
quebrou nada além do que devia. Um `LucroInsuficiente` quer dizer que o ciclo
FECHOU e sobrou — **e isso não é lucro**: o líquido continua negativo.

E a matemática local com ticks em memória NÃO foi implementada: a auditoria
achou primeiro a incompatibilidade de callback, e a ordem dela é corrigir só
essa.

## Problema atual

**VANTAGEM ECONÔMICA NÃO COMPROVADA.** O único ciclo fechado histórico é 84x
abaixo do ponto de equilíbrio no nosso gás, e a medição ao vivo está ilegível
pelos dois limites acima. Lucro capturado na rede: ZERO.

## Próxima ação objetiva

UMA: um A/B válido do pool Algebra (cotar a mesma rota com e sem o apelido, no
mesmo estado) para medir quantas rotas o conserto desbloqueia de fato — e, no
mesmo run, reduzir o conjunto cotado por estado para caber na janela de
consistência (`ESTADO_INCONSISTENTE` em 5.819 de 5.823 com 380 rotas). **NÃO
ampliar para 3–4 pernas** e **não implementar matemática local com ticks** sem
antes medir a latência que ela economizaria no caminho real.

## Limites conhecidos do ambiente

- `wss://mainnet.base.org` → 405. Sem WebSocket: o ciclo acorda por tempo.
- O provedor público não expõe versão de estado pré-confirmado (hash de
  `pending` é zero) → identificação por fingerprint dos pools, com a limitação
  declarada (duas mudanças que se cancelem leem como uma).
- `eth_getLogs` recusado; `eth_getBlockReceipts` funciona (1 chamada/bloco).
- Fork do Hardhat não tem `eth_getBlockReceipts` nem `callTracer`.
- O ciclo do caçador custa ~3,6s e o bloco da Base ~2s → o intrabloco só
  aparece com amostras espaçadas dentro do ciclo (`ARB_AMOSTRAS_PENDING`).
- `CACA_ENVIAR=0` obrigatório. Nenhum deploy, nenhum ETH, Railway intocada.

## Variáveis da observação

`ARB_MINUTOS`, `ARB_ATUALIZACOES` (teto de estados distintos),
`ARB_AMOSTRAS_PENDING`, `ARB_ESPACO_AMOSTRA_MS`, `ARB_ETIQUETA=latest|pending`,
`ARB_ATIVIDADE_BLOCOS`, `ARB_ATIVIDADE_TETO`, `ARB_POOLS`, `ARB_ROTAS`.
