# CACA / TITAN Oracle Shadow (Base)

## O que ja esta codificado
- Leitura de trades do Binance Spot e ticker Coinbase Exchange via WebSocket.
- Binance market-data-only em `data-stream.binance.vision:443` com dois endpoints oficiais alternativos.
- Reconexao com backoff progressivo, filtro de preco invalido ou antigo (>2,5s), descarte de divergencia >35 bps.
- Fallback para os tres endpoints REST existentes em `precoDeMercado.ts`.
- Reutiliza o fluxo ja existente de Aave: precos sao **sinais para antecipar a leitura**, nunca autorizacao automatica de liquidacao.
- Nao armazena chaves, nao assina e nao envia tx no novo modulo.

## Validacao exigida antes da producao
```bash
npm ci
npm run typecheck
npm run build
node --require ts-node/register --test src/oracleShadow.test.ts src/precoDeMercado.test.ts
```
Verificar os nomes reais dos testes de mercado antes de executar; os comandos nao devem envolver `CACA_CHAVE_PRIVADA`.

## Railway
O servico `renewed-sparkle` e quem roda `npm run caca:prod`. Na leitura de
17/10/2026, a fonte estava pinada em `569cc0036723ad24e877bf91148830d25f7643db` na branch
`feat/caca-integracao-multihop-ativa`: alterar a branch GitHub **nao** atualiza o
deploy automaticamente enquanto esse commit fixo continua configurado.
O processo reportou `envio desligado`, ou seja, ainda nao pode executar liquidacoes reais.

Para teste sem risco: subir a nova versao primeiro mantendo `CACA_ENVIAR=0`,
confirmar nos logs `[ORACLE-SHADOW/WS]` e `[ORACLE-SHADOW]` e conferir
as mediçoes em `[POSTURA]`; depois auditar RPC, saldo em ETH nativo,
gas, simulacao EVM e acesso aos contratos. O recurso se desliga por
`CACA_ORACLE_SHADOW=0` e volta as leituras REST existentes.

**Nunca use o movimento da Binance como prova de HF<1**: a liquidacao depende
do estado do oraculo da Aave na Base no instante do envio. Acesso a SVR/Atlas
usa garantias e regras proprias. Custos da Base e reversoes sao despesas reais.

## Alteracao pendente
Comparar a branch `feat/caca-oracle-shadow-20261017` com
`feat/caca-integracao-multihop-ativa`. O pull request e a alteracao de
workflow foram bloqueados pelas ferramentas; nenhum bypass e permitido.
