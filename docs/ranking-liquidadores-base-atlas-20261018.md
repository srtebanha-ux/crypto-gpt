# TITAN — Ranking on-chain e engenharia reversa dos liquidadores vencedores da Base
Data da coleta: **2026-10-18 UTC**. Fontes: eventos emitidos no Morpho Blue e Aave V3, recibos e bytecode da Base; repo oficial do Atlas da FastLane Labs.

## Prova: ranking de SETE dias (nao apenas sinais)

**Blocos 52.480.736 até 52.783.136**, janela UTC de ~7 dias. Scanner `scripts/rankearLiquidadoresBase.cjs` concluiu **379 de 379** janelas, **787 eventos de liquidação** Aave+Morpho; relatório JSON no [GitHub Actions — Base Liquidator Leaderboard](https://github.com/srtebanha-ux/crypto-gpt/actions/runs/39164113577).

Critério: evento `LiquidationCall` da Aave pelo campo *liquidator*, e `Liquidate` do Morpho pelo campo *caller*; **não** o endereço `tx.from`. Contagens são de EVENTOS, não lucro em dólares.

| Liquidator no Morpho | Eventos confirmados | Transações | Devedores | Mercados |
| --- | ---: | ---: | ---: | ---: |
| `0x8b61f5925f4515edb0b7b76c38036aaf9a818472` | **317** | 62 | 303 | 10 |
| `0xd12810b19b596347a3afac206d3ca65d08594b3f` | 84 | 12 | 84 | 5 |
| `0x3ae5122d62e78dc14b98d8d30aca4faf9d1f1bba` | 59 | 6 | 59 | 2 |
| `0x2b68ca5006086dbee182463418782b504078778f` | 44 | 7 | 44 | 1 |
| `0x89d5388f301ce5ddcb332ff39e74518412333fec` | 24 | 24 | 24 | 4 |

**Três primeiros:** o destino (`tx.to`) dos exemplos examinados é `0x583dcfef0d240dc80753f0f0b26513fee27d9b77`, o mesmo *executor Atlas*, somando 460 eventos entre esses três endereços. Isso não prova titularidade comum nem lucro realizado.

## O contrato real: Atlas, não uma função secreta de Flash Loan

- Executor: [`0x583dcfef…d9b77` no Basescan](https://basescan.org/address/0x583dcfef0d240dc80753f0f0b26513fee27d9b77#code), bytecode 24.562 bytes.
- Identificação independente via [Sourcify](https://sourcify.dev/server/v2/contract/8453/0x583dcfef0d240dc80753f0f0b26513fee27d9b77?fields=abi,compilation), fonte `src/contracts/atlas/Atlas.sol`, nome `Atlas`, verificada em 2025-11-21; método `metacall` (selector `0x4317ca01`) na transação.
- Código público original: [FastLane-Labs/atlas](https://github.com/FastLane-Labs/atlas/blob/main/src/contracts/atlas/Atlas.sol), licença **BUSL-1.1**, não copiar partes extensas/redistribuir sem observar licença.
- Modelo: UserOperation + várias SolverOperation + DAppOperation + gasRefundBeneficiary. Atlas coordena relays/solvers, execução, bids e pagamentos, não é uma cópia de `CacadorMorpho`. [Documentação técnica](https://docs.atlasevm.com/atlas/contracts/technical-reference/v1.2/atlas-core/Atlas/).
- Contratos solvers `0x8b61...` (14.643 bytes) e `0x3ae...` (19.943 bytes) têm seletores de callback `onMorphoLiquidate`, `uniswapV3SwapCallback` e `pancakeV3SwapCallback`. Seletores no bytecode não comprovam qual rota foi usada em cada transação. Não localizamos os fontes completos verificados: Sourcify 404 nesses endereços; Blockscout 403.

## Três transações reais dissecadas

| TX / bloco | Morpho Liquidate | Mercados | Swaps detectados | Gás usado L2 |
| --- | ---: | ---: | ---: | ---: |
| [0x22982a…12459a](https://basescan.org/tx/0x22982ae30e036921c78ace99a2034f939e4c20f4a549ec1bb1a19c0e8f12459a) / 52741703 | 15 | 1 | 5 | 2.760.209 |
| [0xc0a519…1f9](https://basescan.org/tx/0xc0a51904f3bd704512b5c502e3812e7568cbbe6191c8110b4aa110899c26c1f9) / 52781521 | **32** | 1 | **0** | 3.726.889 |
| [0x350f36…cac](https://basescan.org/tx/0x350f36f5d4a812ba0bc45bb940848d87fba1a154cc96abdaaaafef9f7ead3cac) / 52741778 | 2 | 1 | 0 | 1.093.753 |

`0xc0a519...` tem 32 devedores Morpho diferentes na **mesma transação confirmada**, com `tx.to` Atlas. Os 0 eventos Swap V2/V3 reconhecidos nesse recibo NÃO provam ausência de conversão via outro mecanismo, nem flash loan, nem margem de lucro. É preciso decodificar `userOp`, `solverOps`, eventos internos e o movimento real de tokens. Nenhuma métrica deste estudo se refere a lucro líquido.

## Arquitetura reutilizável pelo TITAN

1. **Descoberta:** API Morpho -> cache por mercado/devedor, ordenado por risco e tamanho, revalidado no estado on-chain.
2. **Lens de leitura em lote:** extrair saúde + juros acumulados + preço para centenas de posições no MESMO bloco; não descartar mercado inteiro por falha de um empréstimo.
3. **Agrupamento:** agrupar candidatos do mesmo mercado ou com mesma dívida/garantia para **SIMULAR** múltiplas liquidações na mesma transação. Não assumir que todo ativo pode pagar dívida de outro nem que callback de uma operação permite outra.
4. **Financiamento/venda:** comparar Morpho onMorphoLiquidate, flashloan Aave, swap v3 e rota DEX; retorno da dívida e resultado líquido reais. A arquitetura Atlas não autoriza débito de terceiros nem gera taxa gratuita.
5. **Competição por qualidade:** cada candidata precisa de `eth_call`/fork e custo L1+L2 real; não dispensar piso de lucro, limite de gas, nonce compartilhado ou stop-loss.
6. **Detecção de rebotes:** novo `detectarRebotesMorpho` correlaciona `Liquidate` e `Swap` na mesma transação, usando os recibos que o scanner já lê. Sem evento Swap correlacionado, não promova piscina fictícia. Isso é inteligência para **arbitragem depois da liquidação**, não execução de liquidações Morpho.

## Limites da análise

O executor Atlas é de código aberto, mas o software off-chain das carteiras vencedoras (descoberta e seleção de operações) não pode ser inferido integralmente do bytecode. Não há evidência de que seus 460 eventos resultaram em 460 lucros; nem podemos comparar o resultado líquido sem analisar ingressos/saídas de tokens, rebates, bid e gas L1. O TIGER/TITAN atual ainda precisa completar o executador Morpho on-chain e sua rota antes de operar esses mercados. **Não declarar vitória de produção enquanto não houver TX + recibo + delta positivo do cofre.**
