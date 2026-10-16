# CACA Multi-Hop — primeira operacao live controlada

Data: 16/10/2026. Esta nota registra **FATOS da blockchain** vs configuracao de autorizacao.

## Contrato comprovado no Base mainnet

- Contrato: `0x53982353F5de46736848bFAEd98D43D06BA41874`
- Tx deploy: `0x6a4ddce2f495e4ecf4b28d5113d72106424f5b258efaafd868090c5ed3cea7d0`
- Bloco: `52702518`, recibo `status=1`, gas `1705880`, code bytes `7637`.
- Proprietario `dono()`: `0x3D310384d674532f5D41cF2D43B03001F3515AE8`.
- Cofre: `0x3dffA934170bdD491724747Be2c4F56E3f1512A7`.
- Aave V3 Base: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`.
- Morpho: `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`.
- Uniswap V3 Factory: `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`.
- Verificado por `titan-multihop-readonly` com eth_getTransactionReceipt, eth_getCode e getters do contrato.
- O RPC PublicNode confirmou broadcast mas respondeu 403 ao consultar a transacao (endpoint exigiu token para arquivo); isso **nao** era falha de deploy: a leitura alternativa confirmou status1. O erro nao justificaria repetir o deploy.

## Primeira tentativa autorizada na carteira ORIGINAL do CACA

- O `renewed-sparkle` e o UNICO emissor que pode usar `CACA_CHAVE_PRIVADA`.
- `CACA_SOMENTE_MULTIHOP=1` retira V1/V2 da lista de candidatos e impede os historicos tiros especulativos.
- `CACA_ENVIAR=1`, `CACA_MULTIHOP_AVALIAR=1`, `CACA_MULTIHOP_ENVIAR=1`, `CACA_MULTIHOP_CONFIRMAR=OPERAR_BASE_REAL` habilitam a nova rota APENAS se todos os freios passarem.
- Um arquivo exclusivo `/app/data/caca-multihop-primeiro-envio.json` e reservado atomicamente ANTES do nonce. Depois disso, qualquer reinicio evita uma segunda transacao ate conciliacao manual.
- `CACA_MULTIHOP_GASTO_MAX_WEI=650000000000000` limita **gas L1 + gas L2 pelo maxFee** por tentativa a `0.00065 ETH`.
- `CACA_MULTIHOP_GAS_MAX=2000000`, `CACA_MAX_ENVIOS=1`, `CACA_TIRO_DE_PROVA=0` e `CACA_ATIRAR_NA_ESCRITA=0`.
- O assinador, saldo, cotacoes, preco ETH, busca de devedores Aave, nonce manager e envio foram reutilizados do CACA sem segunda carteira.
- O `titan-arbitragem` fica explicitamente com `ARB_ENVIAR=0`, `TITAN_ENVIAR=0`, `CACA_ENVIAR=0` evitando dois processos pagando gas pelo mesmo nonce.
- `TITAN_MULTI_DEPLOY=0` impede novos deployments do contrato.

## Distincao importante

Deploy contrato status1 **nao e** liquidacao. Habilitar a primeira tentativa **nao e** ter encontrado oportunidade nem ter lucro. Uma operacao de liquidacao so deve ser registrada como realizada apos recibo status1, evento `LiquidouComRota` com usuario/quantia e contrato corretos, reconciliacao do cofre, gasto L1/L2 e diferenca de saldo.

O contrato foi revisado em engenharia e testado em fork real de Base, mas **nao houve auditoria independente**. Por isso a configuracao de producao limita a primeira tentativa, sem liberacao ilimitada.

## Confirmacao do primeiro boot com envio autorizado

- Railway `renewed-sparkle`, deploy `afd5b31b-3f43-4f62-8ac4-5aaffde9a591` = **SUCCESS** (2026-10-16).
- Log `[CONTA]` confirmou carteira original via chave existente, `assinador: CARREGADO: pode assinar e transmitir`.
- Log `[BLOCO 52702715]` confirmou `v 6251886 · ... envio AUTORIZADO`.
- Monitor independente `titan-multihop-readonly` = **SUCCESS**, getters do contrato validados.
- `titan-arbitragem` continua monitorando com todas as flags de envio desabilitadas para nao disputar nonce.
- Na ultima observacao, **nenhum `TIRO SAIU` ou `MULTIHOP NO COFRE` confirmado**. O envio esta **habilitado e limitado**, mas ainda nao existe prova de liquidacao lucrativa.
- Risco do contrato nao foi objeto de auditoria independente. A trava de 1 unico envio nao libera transacoes continuas ate reconciliar resultado real.
