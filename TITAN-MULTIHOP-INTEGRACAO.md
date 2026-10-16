# TITAN Multi-Hop — extensao do CACA (uma unica carteira e um unico envio)

**Estado atual:** codigo conectado no `cacarAoVivo.ts` via opt-in. Nenhuma configuracao abaixo implanta ou ativa automaticamente o contrato.

## Arquitetura

1. O cacador encontra um alvo que JA esta liquidavel (nao usa modo especulativo).
2. A ponte `src/titanPonteMultiHop.ts` reusa as pools Base verificadas pelo CACA e, opcionalmente, aceita pools adicionais explicitamente autorizadas, le chainId 8453, verifica bytecode e getters imutaveis: `dono`, `cofre`, `aave`, `morpho`, `fabricaV3`.
3. `planejarLiquidacaoTitan` pede simulacoes reais ao contrato implantado: `eth_call` no mesmo bloco, `eth_estimateGas`, taxa L2 conservadora mais teto L1 medido pelo oraculo Base ja usado pelo CACA, convertidas para unidades do token da divida. O planejador otimiza tamanho e rota; falta de quote nao equivale a lucro.
4. A cotacao vencedora recebe `lucroMinimo` positivo e `eth_call` com os bytes finais; o candidatado so concorre com V1/V2 se `CACA_MULTIHOP_ENVIAR=1` e confirmacao especifica.
5. A transacao passa pelos freios de saldo, gas, disjuntor, cota, nonce e autorizacao do cacador existente. Antes de reservar nonce, um ultimo `eth_call` confere que continua liquidavel. O contrato faz flash loan Morpho, `liquidationCall`, swaps, paga o principal e manda o lucro ao cofre.
6. A transacao do Multi-Hop usa o MESMO envio unico que o legado — nao existem dois tiros para o mesmo alvo no mesmo ciclo.

## Variaveis do modo observacao (nao envia Multi-Hop)

```bash
CACA_MULTIHOP_AVALIAR=1
CACA_MULTIHOP_CONTRATO=0x...      # implantado e auditado
CACA_MULTIHOP_GAS_MAX=1500000
# CACA_MULTIHOP_L1_RESERVA_WEI e opcional como teto EXTRA.
# CACA_MULTIHOP_POOLS_JSON e opcional para pools extras.
# Factory V3, pools WETH/USDC/USDbC e custo L1 sao resolvidos pelo codigo.
```

Uma pool Aerodrome usa `"protocolo":"aerodrome","taxa":null,"permitida":true`. `permitida` e apenas a autorizacao de considerar a pool; para V3, o contrato exige `factory.getPool` correspondente, e para Aerodrome exige allowlist ONCHAIN anterior. Nao inventar enderecos ou marcar pool como autorizada sem verificacao.

Para o caçador antigo operar como antes, NAO e preciso configurar nada. Com `CACA_MULTIHOP_AVALIAR=1`, o Multi-Hop pode ser avaliado mas nao entra na disputa se nao houver autorizacao exclusiva.

## Habilitacao de envio, SOMENTE apos fork real e auditoria

```bash
CACA_ENVIAR=1
CACA_MULTIHOP_AVALIAR=1
CACA_MULTIHOP_ENVIAR=1
CACA_MULTIHOP_CONFIRMAR=OPERAR_BASE_REAL
```

O novo executor usa o proprio `CACA_CHAVE_PRIVADA` via `carteira` ja carregada no `cacarAoVivo.ts` e o mesmo `LocalNonceManager`. Nao ha segundo assinador no processo nem outra fonte de alvos. A mesma carteira exige **nonce exclusivo entre processos**: NAO manter outro emissor independente com a mesma chave. Para operacao com arbitragem simultanea, preferir contas distintas. Lucros estimados nao podem ser registrados como realizados: conferir o evento `LiquidouComRota`, recibo `status=1`, saldo do cofre e custo de gas L1+L2.

## Deploy isolado (com pagamento de gas real)

```bash
npm ci
npx hardhat compile --config hardhat.config.cjs
npx hardhat test --config hardhat.morpho-local.cjs forkTests/titanMultiHopLocal.js
npm run build

# Revisar carteira, cofre, pool Aave e factory ANTES.
# Colocar no Railway um volume persistente /app/data.
TITAN_MULTI_DEPLOY=1
TITAN_MULTI_CONFIRMAR_DEPLOY=IMPLANTAR_MULTIHOP_BASE_REAL
TITAN_NONCE_EXCLUSIVO=1
TITAN_MULTI_DEPLOY_MARCADOR=/app/data/titan-multihop-deploy.json
TITAN_MULTI_DEPLOY_TETO_WEI=1000000000000000
CACA_ENVIAR=0 # obrigatorio: nao disputar nonce com o CACA no deploy
# CACA_CHAVE_PRIVADA ja esta no servico do CACA. NAO duplicar segredos.
# CACA_RPC_URL e CACA_ENDERECO_PUBLICO ja estao no servico.
# Cofre e Pool Aave sao herdados do codigo CACA e validados.
npm run titan:deploy-multihop
```

O comando tem que rodar com as variaveis do proprio CACA, durante janela em que o emissor nao transmite, e nunca num segundo bot com a mesma chave. O script usa o artefato `.tmp/artifacts/contracts/CacadorAaveMultiHopMorpho.sol/CacadorAaveMultiHopMorpho.json` e Morpho Base singleton fixo. Mede gas, L1 por oracle e impede deploy acima do teto. Antes da tentativa paga cria marcador exclusivo e duravel. Se houver falha/restart apos o broadcast, consultar recibo e nonce; **nao apagar marcador nem repetir automaticamente**.

## Criterios obrigatorios de aceitacao

- `npm run build`, testes unitarios e contrato local passando.
- Testes de fork Base em posicoes elegiveis com USDC 6 decimais/WETH 18, swaps V3/Aerodrome, gas e slippage real, e resultado liquido positivo apos L1/L2.
- Auditoria independente dos callbacks, verificacao do factory Morpho/Aave, reservas de tokens e contabilidade de cofre.
- RPC que suporte eth_call/estimateGas no bloco do quote; provedor que nao suporta falha fechado.
- Cofre confirmado ONCHAIN. Sem endereco implantado, o opt-in nao pode transmitir.
- Primeira operacao real autorizada separadamente, limite financeiro e observacao de recibo antes de ampliar.

## O que ja foi aproveitado do CACA

- **Sem nova carteira**: o caca carrega `CACA_CHAVE_PRIVADA` uma unica vez e compartilha a carteira ao decidir entre V1, V2 e Multi-Hop.
- **Sem segunda fila**: o codigo segue a lista `caidos`, `montarAlvos`, `alvo.dividaCrua`, `alvo.dividaUsd`, `cobrir(alvo)` e `precos/casas` do CACA.
- **Sem segundo nonce manager**: qualquer envio ocorre no UNICO `carteira.sendTransaction` apos `nonceManager.getNextNonce()` do CACA.
- **Sem segundo banco de pools**: usa por padrao pools V3 previamente confirmadas na Base; JSON somente se houver pools extras.
- **Sem planilha de L1 paralela**: usa `codificarTetoDeL1` do `custoDaBase.ts` do CACA; erros no oraculo impedem a avaliacao.
- **Sem segundo worker transmissor**: `titan-multihop-readonly` monitora infraestrutura e nao possui chave. O deploy financeiro separado e apenas instalacao de contrato, nunca outro bot procurando oportunidades.

**Atencao:** o Railway `renewed-sparkle` ainda esta ligado a branch antiga e esta com `envio desligado`. Os commits deste PR devem ser revisados/integrados no CACA antes de ativar qualquer operacao real. Nao mudar de branch automaticamente, pois a feature branch tambem tem alteracoes historicas nao relacionadas.
