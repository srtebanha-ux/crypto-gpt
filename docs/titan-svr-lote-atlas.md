# TITAN-SVR / Executor Atlas + Morpho por lote

**Estado em 18/10/2026:** implementado em branch de desenvolvimento, compilação e testes locais. **Não implantado em mainnet; não há dinheiro/ETH gasto e nenhum envio assinado pelo módulo SVR.**

## Capacidades copiadas — e aprimoradas — do liquidador 0xD128

O contrato competidor `0xD12810B19B596347a3AFAC206d3cA65d08594b3f` tem evidência de `Atlas.metacall`, transações com 23 liquidações e lances de 0,720835 / 0,207190 / 1,315524 ETH. O código-fonte privado do solver não foi obtido; os recursos a seguir reproduzem **comportamentos observados**, não código copiado.

1. `contracts/TitanAtlasMorphoLote.sol` expõe a interface real `atlasSolverCall` de Atlas v1.x, verifica o `msg.sender` Atlas e o signer `solverOpFrom` (dono imutável), aceita apenas lances ETH. Transações revertidas são atômicas.
2. Até **16 posições Morpho em lote** num mesmo `atlasSolverCall`, com callback `onMorphoLiquidate` por posição. Cada alvo usa payout da garantia para quitar a dívida, sem flash loan separado quando a DEX suporta a rota.
3. Inicialmente suporta **somente mercados com dívida em WETH**. Cada garantia precisa ter par direto na Aerodrome clássica (stable/volatile). Sem "emprestar de conta própria" saldos anteriores para mascarar lucro: o saldo WETH inicial é protegido por deltas por posição e por lote.
4. O **lance ao ambiente Atlas** sai de WETH gerado pelo lote: `WETH.withdraw(bidAmount)`, pagamento em ETH, `IAtlas.reconcile` e só então remessa do lucro restante ao cofre imutável. O ambiente de leilão deve ser definido pelo Atlas, não por dados arbitrários do público.
5. `src/titanSvr.ts` implementa **planner econômico** com `BigInt`, reserva de gás da operação+oráculo, slippage, taxa de venda, margem de segurança, lucro líquido mínimo, teto de oferta 80% do excedente por padrão e preço competitivo só quando há referência confiável. Sem lance de referência, falha fechado; jamais assume lucro.
6. `src/titanSvrObservador.ts` recebe eventos `solver_subscribe` do Gateway Chainlink com reconexão automática e processamento de leilões **paralelos independentes**; IDs diferentes **não** são descartados só por terem o mesmo userOpHash. Integrado ao Caçador, mas **somente se `TITAN_SVR_OBSERVAR=1`**. Não contém carteira, assinatura nem envio de SolverOperation.
7. `forkTests/titanAtlasMorphoLocal.js` simula 3 devedores no mesmo lote e verifica que o bid sai do lucro novo, sem tocar saldo antigo; saldo do cofre; rollback completo da operação se qualquer devedor falhar; callback público não autorizado; signer indevido; mercados WETH-only.
8. O Caçador Aave e o restante dos serviços são independentes e permanecem em operação. Não alterar por acidente as regras de nonce, gas, perdas ou janela de transação deles.

## O que **ainda precisa** antes de competir com o 0xD128

- Obter um **RPC confiável e dados de posições Morpho atuais** para montar lotes realmente liquidáveis. Não basta que a API encontre empréstimos.
- Testar em fork com o **Atlas/DAppControl reais e transações SVR** do bloco correspondente, comprovando assinatura EIP-712/EIP-191, `shortfall`, `reconcile`, formato `forwardedData`, gás consumido e caminho de execução.
- Associar um solver signer autorizado a um depósito atlETH válido; conferir a versão exata do Atlas na Base, `getSolverGasLimit` do DAppControl e a necessidade do depósito de gás antes de conectar o envio.
- Implementar **gateway completo de montagem e submissão** (`solver_submitSolverOperation`) com assinatura validada, `bond` e cotação atual. O observador não assina nem envia.
- Substituir rota direta WETH para mercados com empréstimos em USDC/EURC/cbBTC, com multihop testado, mantendo o mesmo invariante de lucro novo.
- Auditar por terceiros e testar em Base fork a versão final antes de implantar. Código compilado e mocks verdes não significam executabilidade real nas condições SVR.

## Como rodar os testes

```sh
npm ci
npm run build
node --require ts-node/register --test src/titanSvr.test.ts
npx hardhat compile --config hardhat.morpho-local.cjs
npx hardhat test --no-compile --config hardhat.morpho-local.cjs forkTests/titanAtlasMorphoLocal.js
```

## Fontes oficiais

- [Chainlink SVR Atlas Searcher Onboarding](https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas)
- [Atlas SolverBase (autenticação/reconcile/bid)](https://github.com/FastLane-Labs/atlas/blob/main/src/contracts/solver/SolverBase.sol)
- [Atlas SolverOperation](https://github.com/FastLane-Labs/atlas/blob/main/src/contracts/types/SolverOperation.sol)
- [Morpho liquidate callback](https://docs.morpho.org/developers/contracts/blue/)
- [Investigação do contrato concorrente](docs/atlas-chainlink-svr-forense-0xd128-base.md)

**Observação econômica:** o depósito atlETH é capital separado do lance e paga o gás do solver e do oráculo conforme regras do Atlas. A recomendação de 0,1 ETH no onboarding não é evidência de que uma conta sem depósito pode atuar com apenas US$30. Zero transações de produção foram enviadas por este PR.
