# TITAN MEV — implementacao responsavel da pesquisa (19/10/2026)

**Fonte:** PDF da usuaria, *Engenharia Avancada de Bots MEV*, 24 paginas.
**Criterio:** nenhum retorno ou "execucao 100%" pode ser inferido de uma
formula, preco da API, simulacao simples ou teste com mocks.

## Mapa de aproveitamento

| Proposta no PDF | Situacao no TITAN | Implementacao / condicao |
| --- | --- | --- |
| Flashblocks a 200 ms (p. 2–4) | So gatilho newHeads fechado anteriormente | Novo `titanFlashblocks.ts`, somente leitura, opt-in `TITAN_FLASHBLOCKS_OBSERVAR=1` + `TITAN_FLASHBLOCKS_WSS`; rastreia `payload_id` sem fixar indice maximo 10. |
| Denim / migracao para 200 ms (p. 4–5) | Hardcode de data seria arriscado | Auto-detecta rejeicao/silencio da assinatura RPC `newFlashblocks` e tenta `newHeads`. Sem supor data mainnet e sem trocar signer/nonce. |
| Custo L1/Fjord/FastLZ (p. 5–7) | Ja presente em `custoDaBase.ts` | Preservar `getL1Fee(signedRawTx)` e `getL1FeeUpperBound`. **Nao** criar estimativa precisa a partir de um fastlzSize imaginado. Menos calldata so e melhoria se `getL1Fee` medido cair e a validacao onchain continuar idêntica. |
| Tamanho otimo analitico CPAMM (p. 8–9) | Grade BigInt existente em `titanOtimizadorTamanho.ts` | `titanTamanhoCpamm.ts`: formula fechada de **duas** pools CPAMM em BigInt, com fee e arredondamento conservador; tamanho entra como **semente** opcional no otimizador, mas precisa de cotacao real completa. |
| Pools CLAMM Slipstream/V3 (p. 8–9) | TITAN ja coteja V3 e Slipstream | A formula fechada CPAMM **NAO vale** atraves de ticks. Utilizar Quoter/eth_call, validar factory, impacto, gas, taxa de transferencia e state hash. |
| Morpho flashLoan a 0% e LIF (p. 9–11) | Morpho integrado no contrato Multi-Hop e radar | Maior prioridade futura: liquidacao de posicao atual na Base, saldo/repay e recuperacao do colateral em **mesma tx** em fork. Zero fee nao significa gas zero. |
| Oracle Pyth pull atomic (p. 11–12) | SVR Chainlink Atlas diferente de Pyth | Exigir **prova por mercado** de que o contrato usa Pyth e aceita atualizacao. Comparar `getPriceNoOlderThan`, `conf`, `publishTime` e payload Hermes; nao enviar atualizacao a mercado que usa Chainlink. |
| Executor Solidity/Yul (p. 13–19) | **Nao seguro para deploy** | O callback de pool `uniswapV3SwapCallback` mostrado nao autentica `msg.sender`, pode enviar fundos para qualquer chamador. Contexto de callback/reentrada, pagamento Morpho, lista de pools e invariantes de saldo devem ser reescritos e testados. |
| Motor Rust (p. 19–22) | TITAN existe em Node/TypeScript | Rust pode ser componente de ingestao no futuro, apos medir que CPU e o gargalo (hoje o throughput de RPC/cotacao e limitante). O exemplo usa reservas inventadas e fastlzSize=98 inventado; NAO envia ordem real. |
| 500% de ROI com US$2–5 (p.1–2,22–23) | Cenario ilustrativo | Sem valor garantido; perda de gas em falhas, competição, concorrencia e indisponibilidade de margens podem consumir todo o buffer. |

## Fonte vs documentacao oficial

- Flashblocks RPC application subscriptions: https://docs.base.org/base-chain/api-reference/flashblocks-api/newFlashblocks
- Base Flashblocks overview / raw infrastructure stream nao recomendado para apps:
  https://docs.base.org/base-chain/api-reference/flashblocks-api/flashblocks-api-overview
- Migracao Denim: o cronograma nao deve ser tomado como trigger automatico
  sem confirmacao oficial em cadeia e provedor.
- OP Stack Fjord GasPriceOracle: https://specs.optimism.io/fjord/exec-engine.html
- Pyth Core EVM/fee: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/evm
  e https://docs.pyth.network/price-feeds/core/current-fees
- Desde agosto de 2026, Hermes Pyth requer API key:
  https://docs.pyth.network/price-feeds/core/getting-started

## Operacao do novo observador (sem assinatura)

Nao ligar sem URL WSS de RPC Flashblocks compativel. O endpoint
`wss://mainnet.flashblocks.base.org/ws` e de infraestrutura e NAO e substituto
de `eth_subscribe` RPC da aplicacao.

```env
TITAN_FLASHBLOCKS_OBSERVAR=1
TITAN_FLASHBLOCKS_WSS=wss://SEU_PROVEDOR_COMPATIVEL
```

Sem essas duas variaveis, o observador permanece desligado, e o Caçador
mantem o seu proprio gatilho de blocos. Em rede com alteracao Denim,
`newHeads` funciona como fallback observavel. NENHUMA habilitacao de
`CACA_ENVIAR`, assinatura, financiamento ou mudanca de nonce e feita.

## Proximo portao de lucro

1. Identificar duas pools **v2 CPAMM** reais com rota fechada verificavel;
   rejeitar fee-on-transfer e pools opacas.
2. Estimar tamanho por `estimarTamanhoCicloCpamm`.
3. Passar `tamanhoSugerido` para `otimizarTamanhoTitan(...,sementesTeoricas)`;
   cotar com callback EVM no mesmo `pending` estado e manter min-profit.
4. Simular a operacao atomica **inteira** de flash loan, swaps, callback,
   repayment, L1 + L2 + slippage. Confirmar que o executor onchain e
   bytecode/config validos. Se falhar, nenhum broadcast.
5. Somente considerar deploy/financiamento real apos confirmar risco,
   budget, nonce exclusivo e permissao explicita para despesa.

**Nao houve deploy do novo executor nem movimentacao financeira nesta etapa.**
