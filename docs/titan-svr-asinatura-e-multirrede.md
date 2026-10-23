# TITAN-SVR: Assinatura real e radar multirrede (18/10/2026)

## Escopo implantável nesta etapa

- `src/titanSvrOperacao.ts` prepara o `SolverOperation` no formato da documentação oficial Atlas v1.6.4 e FastLane Go SDK. Usa assinatura EIP-712 no *hash* tipado, não `wallet.signMessage` (que adicionaria prefixo EIP-191). Retorna o envelope JSON-RPC `solver_submitSolverOperation` sem o transmitir.
- Obriga `chainId=8453`, os contratos conhecidos de Atlas/DAppControl, `gas <= getSolverGasLimit()`, leilão não vencido, solvente com capital vinculado suficiente e `solver` implantado. Respeita o `maxFeePerGas` provido pela Chainlink. Precisa de simulação real, verificação onchain do contexto e signer antes de transmitir.
- `src/titanRadarMorphoMultirrede.ts` consulta a API Morpho em modo leitura para Base, Arbitrum, OP Mainnet, Polygon, Unichain e Ethereum: uma rede a cada 30 segundos. 50 eventos recentes por amostra, sem RPC onchain, sem enviar transação, sem chave. Ativação em Railway via `TITAN_RADAR_MULTIRREDE=1`.
- `scripts/titanRadarMorphoMultirrede.cjs` faz uma leitura de 100 eventos por rede e guarda JSON `.tmp/titan-multirede-morpho.json`. Os resultados são um recorte das últimas operações do indexador, não comparação de oportunidades de mesma janela temporal.
- `scripts/titanAtlasLeiturasPublicas.cjs` consulta Atlas e DAppControl diretamente na Base. Em 18/10/2026, leu `VERIFICATION() = 0x6e1886aEca75160BAa5610B7c1D3a895198C61cf` e `getSolverGasLimit() = 6000000`.
- `scripts/titanAtlasBondPublico.cjs`: leitura `balanceOfBonded(signer)`, sem acesso à chave. Resultado para a conta pública que opera o Cacador: **0 ETH vinculado ao Atlas** em 18/10/2026. Portanto o envio de novas SolverOperations **NÃO está ativo**.

## Resultado da amostra Morpho

Consulta da API às 22:08 UTC, 18/10/2026.

| Rede | Eventos recentes indexados | Transações distintas na amostra |
|---|---:|---:|
| Base | 100 | 19 |
| Arbitrum | 85 | 85 |
| OP Mainnet | 37 | 37 |
| Polygon | 100 | 100 |
| Unichain | 100 | 96 |
| Ethereum | 100 | 96 |

O caso Base mostra lote de muitas liquidações em poucas transações, mas não é ranking universal nem frequência medida por hora. Ethereum usa mecanismo distinto de SVR (Flashbots MEV-Share, não Atlas). Arbitrum e BNB Chain suportam SVR Atlas; BNB Chain requer módulo Venus/Compound, não o Morpho da API.

## Próximos bloqueios reais

1. **Bond insuficiente**: `balanceOfBonded` retornou **0**. O onboarding Chainlink recomenda 0,1 ETH para Base e Arbitrum. Sem capital bonded, ofertas não são aceitas e tentativas falhas podem ter cobrança por gás. Qualquer depósito exige aprovação explícita do usuário para **valor e conta**.
2. **Contrato SVR ainda não foi implantado**: `TitanAtlasMorphoLote.sol` foi testado em mocks, porém ainda não foi validado contra Atlas real com fork do bloco do leilão.
3. **Descoberta de oportunidades acionáveis**: o radar multirrede só contabiliza liquidadores *históricos*. A decisão de envio precisa consumir mercados/devedores, preço futuro confirmado pelo feed SVR, simulador de liquidação, rota de venda, gas L1/L2, bid+fundo e saldo líquido.
4. **Execução externa**: o campo `solverOperation.signature` é assinatura EIP-712; o controle real precisa validar o tipo de bidToken permitido e o requerimento de gas. A função `atlasSolverCall` precisa de auditoria com o Atlas v1.6.4 implantado.
5. **Nenhuma garantia de ganho**: o fato de enxergar leilões e ter assinatura válida não garante competir com os maiores participantes, receber o leilão ou lucrar.

## Reprodutibilidade

```sh
npm ci
npm run build
node --require ts-node/register --test src/titanSvr.test.ts src/titanSvrOperacao.test.ts src/titanRadarMorphoMultirrede.test.ts
node scripts/titanRadarMorphoMultirrede.cjs
node scripts/titanAtlasLeiturasPublicas.cjs
```

Fontes:
- https://docs.chain.link/data-feeds/svr-feeds/searcher-onboarding-atlas
- https://github.com/FastLane-Labs/atlas-sdk-go/blob/main/types/solver_operation.go
- https://docs.morpho.org/developers/api/get-started/

**Este PR não movimenta, autoriza ou assina transações de produção e não altera a política de gasto do bot de Aave já ativo.**
