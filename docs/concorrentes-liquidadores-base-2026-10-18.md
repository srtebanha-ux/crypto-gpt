# Engenharia reversa: liquidadores profissionais na Base — 18/10/2026

## Resultado verificável e limitação do ranking

Fonte: [1inch / Dune — Morpho liquidators](https://dune.com/1inch/morpho-liquidators), leitura pública do painel (data_from 2026-01-01, blockchain=all). A tabela de relações `liquidator ↔ wallet` mostra:

| Protocolo/rede | Contrato liquidator | Liquidações indicadas **na Base** |
|---|---|---:|
| Morpho Base | `0xd12810b19b596347a3afac206d3ca65d08594b3f` | **726** |
| Morpho Base | `0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03` | **356** |

**Interpretação:** 726 e 356 são os totais por liquidator na Base **associados nas frases sobre participação das carteiras operadoras** (ex.: 11 liquidações por worker ≈ 1% das 726 do contrato), não o total das liquidações **realizadas por cada worker**. Dune apresenta também 1.441 liquidações para `0xD128...` e 560 para `0xB949...` **em todas as cadeias incluídas na agregação por liquidator**. Os valores US$ 33,48 milhões / US$ 1,77 milhão estimado para `0xD128...` não são exclusivos da Base. O cálculo de PnL do Dune = spread estimado − custo do gás; nem sempre precifica o colateral e **não reflete necessariamente todo lucro realizado**.

A consulta independente para os últimos 7 dias, criada em `scripts/rankearLiquidadoresBase.cjs`, foi iniciada em Actions e **cancelada sem cobertura**. Seus logs mostram 140 de 202 janelas falhas por RPC, zero eventos coletados, portanto NÃO deve ser usada para declarar um líder recente. Deve ser refeita com RPC dedicado ou exportação Dune filtrada para `blockchain=base` e datas recentes, separando Aave e Morpho.

## Contrato #1: arquitetura encontrada na blockchain

- Proxy: [`0xd12810b19b596347a3afac206d3ca65d08594b3f`](https://basescan.org/address/0xd12810b19b596347a3afac206d3ca65d08594b3f#code), 170 bytes.
- Slot EIP-1967: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.
- Implementação ATUAL no instante da leitura: [`0x5d9ba03e166058dd369e43e054b0cf79c55e9064`](https://basescan.org/address/0x5d9ba03e166058dd369e43e054b0cf79c55e9064#code), **24.547 bytes**.
- Extração `PUSH4` (não é ABI completa) encontrou 36 candidatos a seletores, com correspondências de `executeOperation(address,uint256,uint256,address,bytes)` e `onMorphoLiquidate(uint256,bytes)`. **A simples presença de um seletor no bytecode não prova a execução, utilização de flash loan ou o controle de autorização**.
- Código-fonte verificado não foi obtido automaticamente: Base Blockscout API HTTP 403; consulta Sourcify v2 feita retornou 400. Não afirmar que foi lido Solidity do executor.
- Como o proxy é atualizável, documentar implementações por bloco antes de comparar liquidações históricas.

## Contrato #2: diferenciais observáveis

- Contrato: [`0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03`](https://basescan.org/address/0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03#code), 13.765 bytes no runtime.
- Slot EIP-1967 vazio na leitura; não declarar ausência de outros padrões de proxy sem auditoria.
- 29 candidatos a seletor `PUSH4`. Coincidem `onMorphoLiquidate(uint256,bytes)`, `uniswapV3SwapCallback(int256,int256,bytes)` e `pancakeV3SwapCallback(int256,int256,bytes)`.
- **Hipótese a investigar:** rotas com swaps concentrados V3, possivelmente callbacks de múltiplas DEXs. Para provar, precisa de ABI confirmada ou tracing de transações, não apenas seletores.

## Comparação com o nosso TITAN

O TITAN já tem `CacadorMorpho.sol` com `onMorphoLiquidate` e pode pagar a dívida depois de vender a garantia; não precisa copiar essa função como novidade. O nosso scanner também já observa operações Aave e arbitragem no mesmo ecossistema.

**Prioridades com maior potencial:**

1. **Descobrir posição realmente liquidável.** O Morpho oficial open source `morpho-org/morpho-bots` usa uma lente de leitura em lote sem deploy, com juros acumulados e oráculo do mesmo bloco (arquivos `bots/blue-liquidation/src/state/lens.sol.ts` e `src/runner/tick.ts`). O TITAN precisa ligar descoberta de devedores às leituras atômicas *sempre* atualizadas, sem ficar restrito a alguns mercados.
2. **Roteamento multivenue com validação do mínimo de saída**: comparar Aerodrome / Slipstream / V3 após o resgate do colateral; medir o empréstimo a ser quitado usando arredondamento a favor do protocolo e PnL em token de pagamento.
3. **Analisar transações dos concorrentes**: para cada `Liquidate` histórico, pegar `tx.from`, `tx.to`, trace, `gasUsed`, eventos token transfer/swap; classificar transações que fazem `liquidate` + `swap` no mesmo pacote. Esse caminho identifica ganhos técnicos demonstrados, diferente da inspeção pura de bytecode.
4. **Preço total e viabilidade**: gás Base L2 e eventual custo L1, fee de flash loan se aplicável, slippage, operação reverte cedo se `pnl < piso`, e controle de nonce.

Não fazer broadcast da carteira com hipóteses. Priorizar testes fork e recibos, sem afirmar ganhos que ainda não ocorreram.

## Execução e reprodução

- Inspetor: `node scripts/inspecionarLiquidadoresBase.cjs` (chama endpoints públicos, sem carteira).
- Ranking 7 dias: `node scripts/rankearLiquidadoresBase.cjs` (**falha fechado se faltar cobertura**; precisa de endpoint/archive confiável).
- GitHub Actions: `inspecao-liquidadores-base.yml` foi executado com sucesso e mostra implementações e seletores; `base-liquidators-ranking.yml` foi cancelado após falhas RPC e não é ranking validado.

Próximo passo operacional: obter fonte/traces do primeiro candidato e transações selecionadas de diferentes mercados em Base, comparar `gas`, callback, swaps e posição de bloco. E construir um índice de leaderboard diário, com comparação separada Aave vs Morpho.