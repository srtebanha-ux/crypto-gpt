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

## OBSERVAÇÃO AO VIVO COM A EXPANSÃO LIGADA — 9 min, teto de 100 estados

    380 ROTAS distintas monitoradas (186 pools V3 + 16 Aerodrome)
    5.823 sinais | 101 cotações executadas
    74 sinais com lucro BRUTO positivo registrado
    0 com lucro LÍQUIDO positivo | 0 expirados
    23 mudanças INTRABLOCO detectadas
    latência de observação p50 577ms p95 749ms p99 982ms; cotação p50 380ms

**DOIS LIMITES QUE TORNAM ESSA ECONOMIA ILEGÍVEL, e ficam declarados:**

1. `ESTADO_INCONSISTENTE` em **5.819 de 5.823** sinais: com 380 rotas, a janela
   entre ler o estado e cotar (~0,4–0,6s) é maior que o intervalo em que os
   pools mudam. Nenhum líquido deste run é confiável — a trava fez o certo, e o
   conserto é cotar um subconjunto pequeno por estado, não 380.
2. Na amostra de 40 sinais detalhados, **31 eram REVERSÃO OPACA** (o `cotar`
   reverteu com seletor que não é `LucroInsuficiente` nem `PagamentoCurto`) e 9
   `SEM SPREAD`. Cotação que não devolve número não decide nada.

## Problema atual

**VANTAGEM ECONÔMICA NÃO COMPROVADA.** O único ciclo fechado histórico é 84x
abaixo do ponto de equilíbrio no nosso gás, e a medição ao vivo está ilegível
pelos dois limites acima. Lucro capturado na rede: ZERO.

## Próxima ação objetiva

UMA, e é de legibilidade, não de estratégia: diagnosticar a REVERSÃO OPACA do
`cotar` nas rotas concentrado↔concentrado ao vivo (ler o seletor devolvido) e
reduzir o conjunto cotado por estado para caber na janela de consistência. Sem
isso, nenhuma decisão econômica sobre esta expansão é confiável. **NÃO ampliar
para 3–4 pernas**: não há evidência que a justifique.

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
