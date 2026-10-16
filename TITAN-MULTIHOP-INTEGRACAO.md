# TITAN Multi-Hop — caminho financeiro separado

**Estado atual:** codigo conectado no `cacarAoVivo.ts` via opt-in. Nenhuma configuracao abaixo implanta ou ativa automaticamente o contrato.

## Arquitetura

1. O cacador encontra um alvo que JA esta liquidavel (nao usa modo especulativo).
2. A ponte `src/titanPonteMultiHop.ts` carrega as pools explicitamente autorizadas, le chainId 8453, verifica bytecode e getters imutaveis: `dono`, `cofre`, `aave`, `morpho`, `fabricaV3`.
3. `planejarLiquidacaoTitan` pede simulacoes reais ao contrato implantado: `eth_call` no mesmo bloco, `eth_estimateGas`, taxa L2 conservadora mais provisao explicita de L1, convertidas para unidades do token da divida. O planejador otimiza tamanho e rota; falta de quote nao equivale a lucro.
4. A cotacao vencedora recebe `lucroMinimo` positivo e `eth_call` com os bytes finais; o candidatado so concorre com V1/V2 se `CACA_MULTIHOP_ENVIAR=1` e confirmacao especifica.
5. A transacao passa pelos freios de saldo, gas, disjuntor, cota, nonce e autorizacao do cacador existente. Antes de reservar nonce, um ultimo `eth_call` confere que continua liquidavel. O contrato faz flash loan Morpho, `liquidationCall`, swaps, paga o principal e manda o lucro ao cofre.
6. A transacao do Multi-Hop usa o MESMO envio unico que o legado — nao existem dois tiros para o mesmo alvo no mesmo ciclo.

## Variaveis do modo observacao (nao envia Multi-Hop)

```bash
CACA_MULTIHOP_AVALIAR=1
CACA_MULTIHOP_CONTRATO=0x...      # implantado e auditado
CACA_MULTIHOP_FACTORY=0x...       # Uniswap V3 Base aprovada
CACA_MULTIHOP_L1_RESERVA_WEI=...  # provisao conservadora, obrigatoria e > 0
CACA_MULTIHOP_GAS_MAX=1500000
CACA_MULTIHOP_POOLS_JSON='[{"endereco":"0x...","token0":"0x...","token1":"0x...","protocolo":"v3","taxa":500,"permitida":true}]'
```

Uma pool Aerodrome usa `"protocolo":"aerodrome","taxa":null,"permitida":true`. `permitida` e apenas a autorizacao de considerar a pool; para V3, o contrato exige `factory.getPool` correspondente, e para Aerodrome exige allowlist ONCHAIN anterior. Nao inventar enderecos ou marcar pool como autorizada sem verificacao.

Para o caçador antigo operar como antes, NAO e preciso configurar nada. Com `CACA_MULTIHOP_AVALIAR=1`, o Multi-Hop pode ser avaliado mas nao entra na disputa se nao houver autorizacao exclusiva.

## Habilitacao de envio, SOMENTE apos fork real e auditoria

```bash
CACA_ENVIAR=1
CACA_MULTIHOP_AVALIAR=1
CACA_MULTIHOP_ENVIAR=1
CACA_MULTIHOP_CONFIRMAR=OPERAR_BASE_REAL
CACA_MULTIHOP_NONCE_EXCLUSIVO=1
```

O executor novo nao cria carteira e nao substitui `CACA_CHAVE_PRIVADA`. A mesma carteira exige **nonce exclusivo**: NAO manter outro emissor independente com a mesma chave. Para operacao com arbitragem simultanea, preferir contas distintas. Lucros estimados nao podem ser registrados como realizados: conferir o evento `LiquidouComRota`, recibo `status=1`, saldo do cofre e custo de gas L1+L2.

## Deploy isolado (com pagamento de gas real)

```bash
npm ci
npx hardhat compile --config hardhat.morpho-local.cjs
npx hardhat test --config hardhat.morpho-local.cjs forkTests/titanMultiHopLocal.js
npm run build

# Revisar carteira, cofre, pool Aave e factory ANTES.
# Colocar no Railway um volume persistente /app/data.
TITAN_MULTI_DEPLOY=1
TITAN_MULTI_CONFIRMAR_DEPLOY=IMPLANTAR_MULTIHOP_BASE_REAL
TITAN_NONCE_EXCLUSIVO=1
TITAN_MULTI_DEPLOY_MARCADOR=/app/data/titan-multihop-deploy.json
TITAN_MULTI_DEPLOY_TETO_WEI=1000000000000000
TITAN_MULTI_AAVE=0x...
TITAN_MULTI_FACTORY=0x...
TITAN_COFRE=0x...
ARB_RPC_URL=https://...
TITAN_CHAVE_PRIVADA=... # somente em secret store, jamais no git
npm run titan:deploy-multihop
```

O script usa o artefato `.tmp/artifacts/contracts/CacadorAaveMultiHopMorpho.sol/CacadorAaveMultiHopMorpho.json` e Morpho Base singleton fixo. Mede gas, L1 por oracle e impede deploy acima do teto. Antes da tentativa paga cria marcador exclusivo e duravel. Se houver falha/restart apos o broadcast, consultar recibo e nonce; **nao apagar marcador nem repetir automaticamente**.

## Criterios obrigatorios de aceitacao

- `npm run build`, testes unitarios e contrato local passando.
- Testes de fork Base em posicoes elegiveis com USDC 6 decimais/WETH 18, swaps V3/Aerodrome, gas e slippage real, e resultado liquido positivo apos L1/L2.
- Auditoria independente dos callbacks, verificacao do factory Morpho/Aave, reservas de tokens e contabilidade de cofre.
- RPC que suporte eth_call/estimateGas no bloco do quote; provedor que nao suporta falha fechado.
- Cofre confirmado ONCHAIN. Sem endereco implantado, o opt-in nao pode transmitir.
- Primeira operacao real autorizada separadamente, limite financeiro e observacao de recibo antes de ampliar.
