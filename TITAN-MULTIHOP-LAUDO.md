# TITAN Multi-Hop — laudo de validacao tecnica e bloqueios para mainnet

Data: 2026-10-16. Revisao tecnica de engenharia (NAO e auditoria independente).

## Provas reproduziveis

- CI offline: build TypeScript, testes de unidade, contratos Solidity locais.
- Base fork historico fixo, bloco **52.418.045**:
  - Aave V3 Base Pool REAL: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.
  - Morpho Blue REAL: `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`.
  - Uniswap V3 Factory REAL: `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`.
  - Token USDC nativo REAL (6 casas), WETH REAL (18 casas), USDbC bridge REAL (6 casas).
  - Aave liquidavel apenas apos forcar oraculo EM FORK (nao no protocolo real).
  - Flash loan Morpho, liquidationCall Aave, pagamento e recibo na copia da Base.
  - Rota de 1 pool: WETH -> USDC. Liquidação de **1000 USDC**, lucro bruto **88,344249 USDC**, gas L2 **815496**.
  - Rota de 2 pools: WETH -> USDbC -> USDC. Liquidação de **1000 USDC**, lucro bruto **76,832995 USDC**, gas L2 **1322949**.
  - O planejador integrado a ABI do contrato implantado temporariamente no fork escolheu a rota DIRETA economicamente superior. Revalidacao do calldata: OK.
  - Prova em: https://github.com/srtebanha-ux/crypto-gpt/actions/runs/38979158237
- Teste local do contrato (mocks): teste com V3/V3, V3/Aero allowlisted, HF >= 1, callbacks falsos, piso nao atendido.
- Registro de lucro: `lucroConfirmadoPorEventoMulti` exige evento `LiquidouComRota` do contrato correto, usuario e valor da cobertura identicos ao enviado; ausencia de evento nao vira prova de lucro.

## Limitacoes (NAO reclassificar como pronto para lucros reais)

1. O teste de fork manipula apenas a fonte de preco historica para fazer uma posicao liquidavel. Nao e comprovacao de liquidez, frequencia ou lucro na Base HOJE.
2. L1 (data fee OP Stack), spread de mercado, gorjeta, falhas e concorrencia MEV precisam ser incluidos no lucro liquido, nao somente L2. O `CACA_MULTIHOP_L1_RESERVA_WEI` deve ser calculado de modo conservador/medido na transacao final; um valor meramente positivo nao e suficiente para prova economica.
3. Falta revisao independente do contrato e dos callbacks; testes nao equivalem a auditoria de seguranca.
4. Sem contrato Multi-Hop implantado na Base, nao ha endereco para assinar execucoes Multi-Hop.
5. O servico Railway de liquidacoes `renewed-sparkle` roda `claude/hft-triangular-arbitrage-jsq4i4`, cerca de 129 commits atras da branch deste PR. Log atual: `envio desligado`. Nao sincronizar versoes automaticamente: risco de trazer alteracoes antigas e execucoes financeiras inadvertidas.
6. `titan-arbitragem` e um OUTRO servico Railway, com executor CacadorV3. Nao modificar nem compartilhar a mesma carteira emissora sem coordenacao de nonce.
7. Retorno bruto historico de 2 swaps foi MENOR que o da rota de 1 swap, e consumiu MAIS gas. O motor deve escolher pelo lucro liquido, nunca pelo numero de saltos.
8. Nenhuma das aprovacoes de pool Aerodrome do ambiente local deve ser copiada para a Base sem conferencia de bytecode, token0/token1 e autorizacao do contrato novo.
9. Confirmar `getPool()` no PoolAddressesProvider atual da Aave (o Pool e proxy) e conferir as factories on-chain, imediatamente antes de implantar.

## Requisitos antes de enviar dinheiro real

- PR revisado/aprovado, CI e fork verdes no SHA FINAL (nao somente commits anteriores).
- Auditoria independente de Solidity, callbacks V3/Morpho, reentrancia, balances anteriores, fee-on-transfer, autorizacao, saldo residual, slippage e permissao de pools.
- Endereco de implantacao controlado, carteira exclusiva e saldo de ETH para GAS, cofre confirmado, sem bot concorrente na mesma chave.
- Validar custo L1+L2 com recibos no fork e simular fracassos/expiracao de quote; log do primeiro broadcast economico com hash e limite.
- Deploy do contrato isolado e registro do hash; nao usar auto-deploy do servico de arbitragem.
- Primeiro habilitar somente observacao no novo servico. Ativar envio apenas apos um canary restrito e reconciliacao do cofre em USDC e gas L1/L2. Desabilitar imediata e explicitamente quando houver divergencia.

**Estado:** implementacao e testes historicos aprovados; NAO implantado na mainnet; nenhuma transferencia ou tx paga efetuada por esta integracao.
