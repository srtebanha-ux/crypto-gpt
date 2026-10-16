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

## O QUE OS VENCEDORES USAM — medido de `.tmp/reconciliado.json` (40 ops) e da corrente

| Pergunta | Resposta medida |
| --- | --- |
| A) lucrativas comprovadas (líquido reconciliado > 0) | **7** de 40; 5 delas envolvem Aerodrome+V3 |
| hashes conferidos na corrente | **7 de 7 têm recibo** (nenhum inventado) |
| pools distintos das 7 lucrativas | 8 — **7 concentrados + 1 Aerodrome** |
| fábricas concentradas entre eles | **4**: `0x33128a8f`, `0xade65c38`, `0x5e7bb104`, `0x38015d05` |
| B/C) rotas que `candidatasMistas` forma com os pools DOS vencedores | **2** (ela só pareia Aerodrome com V3) |
| C) V3+Aerodrome com 2–4 trocas (forma do executor) | 15 de 40 |
| D) dependência de estado intrabloco | **LACUNA**: `reconciliado.json` não guarda o estado anterior, e o nó público não é arquivo nessa profundidade. Não respondível com o que está armazenado |
| E) não reproduzíveis | 33 de 40 ficaram sem líquido reconciliável (`liquidoReconciliado: null`) |

Universo ao vivo, 40 blocos: 48 pools concentrados com WETH em **6 fábricas**,
8 Aerodrome. Pares no mesmo token: **47 concentrado↔concentrado** (41 cruzando
fábrica) contra **13 Aerodrome+concentrado**. A ampliação abriria ~94 rotas.

## Problema atual

O gerador de rotas é o gargalo, não o mercado: `candidatasMistas` SÓ pareia um
pool Aerodrome com um pool V3. Os vencedores usam majoritariamente
concentrado↔concentrado entre fábricas diferentes — forma que o **executor já
suporta** (duas pernas `tipo 0`, validada ao wei por override:
9.939.992.138.238.505) e que o gerador nunca emite.

## Próxima ação objetiva

UMA: emitir pares concentrado↔concentrado em `candidatasMistas` (mesma função,
mesmo executor, mesmo filtro — a razão das duas pernas já sai de
`razaoMaximaV3`). Ampliação limitada: ~94 rotas contra ~26 hoje, com evidência
dos vencedores. Não exige contrato novo.

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
