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

## PROVA DE PONTA A PONTA V3↔V3 — estado REAL, sem deslocamento artificial

`forkTests/oCicloV3ContraV3.js`, fork no bloco ANTERIOR ao da operação
`0x12226f04` (52631813):

    GERADOR 2 rotas (as duas ordens) | FILTRO 1 passou, 1 descartada com prova
    COTAÇÃO por override: sobra 108.878.689.617 wei em 0,001289 WETH
    EXECUÇÃO ATÔMICA: recibo status=1, gás 372.944, COFRE 0 -> 108.878.689.617

O líquido não foi asserido neste teste (só o bruto e o gás); a forma, o crédito
quitado e o saldo reconciliado estão provados.

## Problema atual

Não há lucro capturado na rede. A expansão V3↔V3 está integrada e provada em
fork; o que falta é evidência de que alguma dessas rotas feche com líquido
positivo em observação ao vivo.

## Próxima ação objetiva

UMA: observação curta com a expansão ligada, medindo quantas das rotas
concentrado↔concentrado produzem sobra bruta e líquida positivas em estado
atual. As 3 de 7 operações multihop (3–4 pernas) ficam FORA: o executor aceita
2–4 pernas, mas o gerador só monta 2 — ampliar para 3 pernas é a decisão
seguinte, e só com evidência.

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
