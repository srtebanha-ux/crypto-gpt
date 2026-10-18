# TITAN — Autópsia comprovada do concorrente 0xD128 na Base

Data: 2026-10-18. Rede: Base (chainId 8453). Fontes primárias: `marketTransactions` da API GraphQL oficial da Morpho, transações/recibos obtidos por `eth_getTransactionByHash` e `eth_getTransactionReceipt`, eventos `SolverTxResult` e `MetacallResult` do Atlas v1.6.4, e documentação oficial da Chainlink/FastLane.

## Descoberta decisiva: o mecanismo é um leilão Chainlink SVR/Atlas

**O endereço `0xD12810B19B596347a3AFAC206d3cA65d08594b3f` é o contrato *solver*, não o receptor das transações externas.** As operações analisadas vão para o **Atlas `0x583dcFef0D240DC80753F0F0B26513feE27D9B77`** com função `metacall` (seletor `0x4317ca01`). A operação é validada por `DAppControl=0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83` da Chainlink SVR. A competição ocorre **por bidAmount na operação do solver**, não simplesmente pelo priority fee da transação.

O campo `tx.from` é o **bundler**; `solverOps[].from` é quem assina o lance; `solverOps[].solver` aponta para o contrato `0xD128...`. **Esses endereços não são a mesma coisa**. A investigação anterior que classificou todos os `tx.from` como múltiplas carteiras próprias de envio do bot estava incompleta. Chainlink escolhe e transmite o `metacall`.

Consegui a ABI do Atlas v1.6.4 das estruturas `UserOperation`, `SolverOperation`, `DAppOperation` no projeto FastLane-Labs/atlas e verifiquei que `Interface.getFunction('metacall').selector === 0x4317ca01`. Os eventos do recibo trazem `SolverTxResult(executed=true,success=true,solverTo=0xD128...)` nos exemplos.

### Operações verificadas (sem estimativas, quantias em ETH)

| Tx (BaseScan) | Liquidações Morpho no mesmo receipt | Lances de solver 1 e 2 (ETH) | Vencedor | Custo de gás L1+L2 da transação (ETH) |
|---|---:|---|---|---:|
| [0x7802fc…8fed7](https://basescan.org/tx/0x7802fcdbf5759506bdebfa2b82a43d6d46cab5f47c675ed022d0cff32fe8fed7) | **23** | **0.720835462860623117** vs 0.546939858325166030 | 0xD128 | **0.001104350922591372** |
| [0x90850f…4e36e](https://basescan.org/tx/0x90850fe22bde38d649ca2c04f4b4050bf790c55b4b4537de059882fa0714e36e) | **5** | **0.207190062534399208** vs 0.196428550654494691 | 0xD128 | **0.000073230859880013** |
| [0x2c3266…6e5](https://basescan.org/tx/0x2c3266f04cd1e6b902005e03ce68311d92157a143eb672c7806bc832108b26e5) | **2** | **1.315524410773955028** vs 0.782454213291803977 | 0xD128 | **0.000026101812698365** |
| [0xa26111…507c](https://basescan.org/tx/0xa26111f3a1160c5e7c4998f9960eb829c4edb67041a91a4e8041bf568717507c) | **5** | **0.083594236708213108** vs 0.080288308368793232 | 0xD128 | **0.000230971983977159** |
| [0x75dfa…52e1](https://basescan.org/tx/0x75dfa94a8db019468fe9d02316add47974e9fc56d47e077297f93c4041d952e1) | **3** | **0.019770124812481985** vs 0.002936404026852149 | 0xD128 | **0.000285243729151496** |

O recebimento do **lance (bid)** é separado do custo de gás visível no `receipt`. O `bidAmount` é a quantia em ETH oferecida ao mecanismo SVR e não deve ser confundido com lucro, nem somado indiscriminadamente ao gás do bundler como se tudo tivesse saído da mesma carteira. Para provar o PnL do solver seria necessário reconciliar venda da garantia, quaisquer flash loans, pagamento real do bid, saldos do solver e subvenções/reembolsos Atlas.

A amostra de **100 eventos** mais recentes do liquidator via Morpho API corresponde a **14 hashes distintos**. Isso é um recorte de resultados indexados, não a proporção histórica completa. Uma única operação tem **23 empréstimos de usuários diferentes liquidados no mesmo mercado**. Isso economiza vários overheads comuns e permite consolidar liquidez, mas não prova uma diferença percentual constante de eficiência energética.

No receipt de 23 posições foram usados **3.545.016 gas**. Dois eventos de swap V3 ocorreram, conforme os logs da transação; nas transações de 5 e 2 posições mais recentes o receipt não incluiu eventos `Swap` V2/V3 conhecidos, embora tenha incluído movimentos de tokens. Isso prova que não há uma única rota de liquidez fixa identificável só pelos swaps.

## Por que ele ganha os leilões

1. **Participa do canal certo**: assina e envia operações solver para Chainlink SVR, onde se disputa o direito de executar uma liquidação junto a uma atualização de feed. Não exige ganhar um leilão público de `maxPriorityFeePerGas` no mesmo sentido de uma disputa no mempool.
2. **Oferece um lance alto e competitivo**: nos 5 exemplos o seu `bidAmount` supera o do outro candidato incluído no Atlas. A emissão de `SolverTxResult` confirma que seu caminho executou com sucesso.
3. **Liquida posições em lote**: os recibos de 23, 5 e 2 posições evidenciam batching real, inclusive em um único mercado.
4. **Tem integração com o Atlas v1.6.4**: função solver `0xd7e2f757` no concorrente, userOp Chainlink `0x02a688ed`, e lógica protegida pelo controle de DApp. Ter callback Morpho isolado não confere essa integração.
5. **Infraestrutura relay/bundler**: diferentes `tx.from` participam do metacall, mas a documentação Chainlink afirma que **o oracle network** é quem submete o pacote. Não inferir que os bundlers são necessariamente carteiras proprietárias do solver.

## Diferenças concretas para o TITAN

- `contracts/CacadorMorpho.sol` contém `onMorphoLiquidate` mas **não contém `atlasSolverCall`**. O executor atual, mesmo sem flash loan separado, **não pode participar diretamente dos leilões SVR**.
- O TITAN já descobre mercados/devedores e tem rotas Aerodrome, mas não agrega múltiplas posições num único `metacall` e não está inscrito no fluxo `solver_subscribe`/ `solver_submitSolverOperation` do gateway.
- Precisamos de um módulo **TITAN-SVR**: listener WebSocket autenticado quando requerido, decodificador de userOp, cálculo de bônus e de bid máximo, solver compatível com Atlas, simulação EVM, assinatura EIP-191, gerenciamento de bonding e registros de resultados. Não desligar Aave nem o scanner de arbitragem existente.
- Custo inicial **não é necessariamente zero**: [a Chainlink recomenda 0.1 ETH bonded na Base](https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas), e a restituição do gás da operação do solver e da atualização do oracle é debitada desse depósito. Esse número é uma recomendação operacional, não preço obrigatório do lance. O bid pode ser pago durante a execução, mas o depósito de gás e os requisitos de saldo não desaparecem.
- Regra de decisão: `lucroExecutavel = valorRealizavelGarantia - dividaReembolsada - bid - gasDoSolverEOracle - feesDeSwap - slippage - margemDeSeguranca`. **Nunca tratar os lances observados como lucro**, nem gastar a reserva do TITAN para entrar sem simulação, teste fork e confirmação do mecanismo de bonding.
- `tx.from` múltiplos devem ficar como infraestrutura de bundling distinta dos endereços `solverOps[].from`, para não inflar falsamente o número de operadores.

## Reproduzir sem custos nem chaves

- `node scripts/probeMorphoLiquidatorApi.cjs`: descobre `MarketTransactionFilters.liquidatorAddress_in` e retorna transações reais.
- `node scripts/forenseRecibosMorphoBase.cjs`: 100 eventos Morpho + 7 recibos reais, com gás, borrow, transfers e swaps.
- `node scripts/decodificarAtlasMorphoBase.cjs`: decodifica completamente `Atlas.metacall`, lances, `solver.from`, `tx.from`, `SolverTxResult` e reembolso de bundlers.
- **Não utilizar `scripts/forenseLiquidacoesVencedorBase.cjs` sem RPC histórico pago**: o antigo scanner de `eth_getLogs` recebeu HTTP 403. O novo fluxo pela API Morpho e `eth_getTransactionReceipt` passou nos testes e obtém transações completas.

**Não foi realizada nenhuma transação, depósito, assinatura ou contratação de RPC para essa investigação**. O fluxo Atlas de envio continua **não implementado no TITAN**, e nenhum lucro novo do TITAN foi afirmado.

Referências: [Chainlink SVR Atlas onboarding](https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas), [FastLane Atlas source](https://github.com/FastLane-Labs/atlas), [Morpho API docs](https://docs.morpho.org/developers/borrow/tutorials/get-data/).
