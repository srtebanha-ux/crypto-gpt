# TITAN: inspeção de liquidadores reais da Base (18 de outubro de 2026)

## Objetivo e regra de evidência

Descobrir quem mais **executou** liquidações Aave V3 e Morpho Blue na **Base 8453**, sem confundir volume, lucro estimado, quantidade de eventos ou atividade em outras redes. Um contrato implantado e uma fonte ABI não provam resultado positivo em dólares.

Dune 1inch: https://dune.com/1inch/morpho-liquidators. O dashboard por padrão agrega diversas redes (`blockchain=all`) e intervalos históricos; o endereço abaixo aparece na tabela cross-chain. **Não chamar a coluna de 726 trabalhadores de 726 liquidações**. A contagem exata por Base nos últimos 7 dias exige varredura com cobertura completa.

Fonte de leitura onchain: GitHub Actions (não se usa chave de carteira): `scripts/inspecionarLiquidadoresBase.cjs`. Execução bem-sucedida em 18/10/2026 19:52:57 UTC.

## Candidato A: endereço 0xd12810b19b596347a3afac206d3ca65d08594b3f

- BaseScan: https://basescan.org/address/0xd12810b19b596347a3afac206d3ca65d08594b3f#code
- Bytecode na Base: **170 bytes**, proxy que usa `DELEGATECALL`.
- Slot EIP-1967 efetivamente lido por `eth_getStorageAt`: `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`.
- Implementação observada no bloco `latest`: **0x5d9ba03e166058dd369e43e054b0cf79c55e9064**, com **24.547 bytes**.
- https://basescan.org/address/0x5d9ba03e166058dd369e43e054b0cf79c55e9064#code
- Seletores detectados via instruções `PUSH4` do runtime (candidatos, não provas de invocation):
  - `executeOperation(address,uint256,uint256,address,bytes)`
  - `onMorphoLiquidate(uint256,bytes)`
  - 36 valores `PUSH4` únicos.
- O proxy é atualizável; uma implementação atual NÃO prova ser a mesma usada na liquidação histórica. Ao atribuir cada evento, capturar `eth_getStorageAt` no bloco respectivo (RPC histórico necessário).
- APIs de fonte para `base.blockscout.com` retornaram HTTP 403; Sourcify lookup com campos tentados retornou HTTP 400. **Não foi obtido o Solidity verificado**. Não inventar função de execução ou proprietário.

## Candidato B: endereço 0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03

- BaseScan: https://basescan.org/address/0xb949a57ac64be7a9dbe535e14f859e4c56a0cf03#code
- Bytecode: **13.765 bytes** direto.
- Slot EIP-1967 vazio; isso não exclui outro mecanismo de upgrade, mas não é o mesmo proxy A.
- Seletores reconhecidos:
  - `onMorphoLiquidate(uint256,bytes)`
  - `uniswapV3SwapCallback(int256,int256,bytes)`
  - `pancakeV3SwapCallback(int256,int256,bytes)`
- Outros PUSH4 podem ser chamadas internas de tokens e não funções públicas. Não presumir que suporta arbitragem V3 lucrativa só pelo selector.
- Fonte verificada indisponível no mesmo método (HTTP 403 Blockscout, HTTP 400 Sourcify).

## Ferramenta para obter o número 1 reproduzível

Branch `feat/ranking-liquidadores-base-20261018`:
- `scripts/rankearLiquidadoresBase.cjs`: 7 dias de eventos `LiquidationCall` no Aave Base e `Liquidate` no Morpho. Agrupa por `liquidator` (Aave) e `caller` (Morpho), nunca só por `tx.from`.
- Verifica cobertura de todos os intervalos; **se faltar janela, NÃO publica um vencedor**.
- Separa contagem de eventos, transações únicas, devedores únicos, número de mercados e prova por hashes.
- Depois da atribuição lê o bytecode, `tx.to`, `tx.from`, gás e implementação ERC1967 atual.
- Testes artificiais `scripts/rankearLiquidadoresBase.test.cjs` comprovam atribuição de eventos.
- Workflow `.github/workflows/base-liquidators-ranking.yml` publica `.tmp/rankingLiquidadoresBase.json` como artefato caso chegue ao final da execução.
- Status ao escrever esta nota: workflow iniciou, **ainda sem resultado final**. Não alegar “líder confirmado”.

## Engrenagens transferíveis para o TITAN

**Motor de descoberta offchain**: estudar `morpho-org/morpho-bots` (https://github.com/morpho-org/morpho-bots):
- Lente Solidity deployless batched `eth_call` para muitos pares (mercado, devedor) no mesmo estado.
- Simulação de accrual de juros para obter dívida efetiva e Health Factor antes do spread.
- `liquidate` de tamanho exato, com arredondamentos de shares conservadores.
- Escolha da melhor rota de venda de colateral/underlying; `eth_call` da transação completa, e só enviar se aprovação, saldo e lucro líquido fecharem.
- Classificação explícita de perdas (fora do universo, saudável, liquidação detectada, sem rota, rejeitada por simulação, enviei, comprovante).

**Contrato na Base**: estudar implementações A e B depois de obter código verificado ou mapear selectors e amostras históricas; separar real comportamento do dispatcher e de funções estáticas no bytecode.

**Não é lição técnica**: copiar funções `fallback` ou `Yul` indiscriminadamente, pagar gorjetas impossíveis, alegar arbitragem “sem competição”, ou afirmar que `try/catch` elimina reversões de transação inteira (depende de design, chamadas externas e limites de gás).

## Próxima validação

1. Ranking onchain por eventos no período escolhido; se RPC falhar, reduzir a janela com advertência de escopo, nunca afirmar top geral.
2. Obter tx de cada concorrente no evento e seu input/trace; comparar gastou, taxa, DEX e tokens de receita.
3. Estudar a implementação do bloco da execução, não a atual por padrão.
4. Porta para TITAN: leitura em lote + maturação de dívida + cotação multivenue + prova em fork antes de qualquer deploy onchain.
