# TITAN — Engenharia reversa de executores públicos na Base (18/10/2026)

## Referência inspecionada

- [kameron222/liquidation-bot](https://github.com/kameron222/liquidation-bot) — MIT, contratos `MorphoLiquidator.sol` e `Liquidator.sol`, adaptadores Morpho/Moonwell e monitoramento de blocos.
- [Moonwell contract divulgado pelo autor](https://basescan.org/address/0xfc6678D9F62DA7875dc1ABE11D2A86C1e59C4617#code). **A alegação do autor de que o contrato está verificado não substitui inspeção independente do explorer.**
- [Documentação do Morpho Blue](https://docs.morpho.org/developers/contracts/blue/): `liquidate` recebe `data` opcional, entrega a garantia, chama `onMorphoLiquidate` e depois cobra a dívida.
- [OpenZeppelin SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20): `forceApprove`, tokens sem retorno e retorno `false`.

**Verificação de resultado:** o README do concorrente reconhece expressamente que **nunca venceu uma liquidação competitiva em produção**. Contrato publicado, callback funcionando e tests em fork **não são prova de PnL**. Não chamar esse concorrente de vencedor apenas pela publicação.

## Comparação concreta

| Capacidade | TITAN anterior | Referência pública | Conclusão |
|---|---|---|---|
| Morpho sem flash loan separado | `CacadorMorpho.sol` já executa via `onMorphoLiquidate` | Também executa via callback | **Já tínhamos**. Não copiar como novidade. |
| Receita do operador | Cofre imutável, mesmo com vazamento de chave | Envio ao `owner()` | Preservar destino imutável do TITAN. |
| Venda da garantia | Rota Aerodrome direta, `amountOutMin` de repay + mínimo de lucro | Uniswap V3 multihop ou Aerodrome | Estudar extensão de rotas, medir custo real e provar contra factory/pool. |
| Saldo anterior | Antes o lucro era todo `balanceOf` final, mesmo com saldo velho no contrato | Mesma contagem ampla no `_sweep` | Corrigido no TITAN desta branch: apenas delta positivo conta como lucro. |
| ERC20 não padronizado | `approve` e `transfer` podiam retornar `false` sem reverter | SafeERC20 + forceApprove | Corrigido nesta branch com helper local que aceita sem retorno e rejeita `false`. |
| Autenticidade do callback | `msg.sender == Morpho` + estado de caça | `msg.sender == Morpho` | Já mais restritivo. Passamos a conferir também o devedor recebido no callback. |
| Varredura de contas | Aave amplo, descoberta Morpho recente sem executor automatizado | Adaptadores Morpho e Moonwell por mercado, concorrência limitada e shards | **Nosso gargalo é off-chain**, após descobrir 6.227 e validar 29 candidatos; conectar identificadores, snapshots, viabilidade e execução. |
| Lucro observado | Não confirmado para Morpho | Autor também informa zero vitórias competitivas | Nenhuma afirmação de vantagem econômica. |

## Teste de regressão desta branch

`forkTests/morphoAuditoriaLocal.js` usa Morpho/Roteador/Tokens **falsos na EVM Hardhat local**, sem chaves e sem gastar ETH real. Casos obrigatórios:

1. Contrato recebe previamente 25 unidades de dívida e 7 de garantia; liquida 100, vende 110, devolve 100: cofre recebe **apenas 10** e ambos os saldos originais continuam intocados.
2. Tentar piso de lucro 11 quando só houve 10 novos: transação reverte (sem consumir depósito antigo).
3. ERC20 cuja `transfer` retorna `false`: `resgatar` reverte e o saldo permanece.
4. Callback direto de estranho e resgate por terceiro são recusados.

O fork end-to-end original `forkTests/oMorphoDePonta.js` permanece como teste separado contra o protocolo real (ainda precisa de RPC com histórico), e deve ser repetido antes de qualquer proposta de deploy.

## Próxima frente de trabalho mensurável

1. De cada mercado Morpho confirmado, transformar os 29 endereços verificados em fila persistente com `position`, `market`, `price()`, taxa de juros e altura do bloco, sem misturar devedores distintos com mercados.
2. Calcular saúde pela dívida **atualizada para o bloco**, nunca por snapshot antigo do indexador; comparar o limiar em fork com o julgamento real de `liquidate`.
3. Traçar rotas de garantia→dívida entre Aerodrome e V3; exigir `minAmountOut` que cubra repayment e lucro mínimo, senão descartar com motivo.
4. Simular o calldata de `CacadorMorpho` do mesmo estado e medir gás L2/L1 e saldo do cofre antes/depois. Registrar `eth_call` falho como falha, não como inexistência de oportunidades.
5. **Não ativar envios para Morpho nesta branch.** Só considerar deploy depois de suite de fork real, bytecode, nonce, owner e receipt confirmarem a operação.

Não executar testes de exploração de callbacks alheios nem manipular oráculos de terceiros. Essas vulnerabilidades podem ser documentadas na revisão defensiva dos próprios contratos.
