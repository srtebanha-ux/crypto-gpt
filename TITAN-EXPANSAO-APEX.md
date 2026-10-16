# TITAN — revisão da pesquisa de Flash Swap e Flashblocks (16/10/2026)

## Contexto

O repositório hospeda dois processos separados: TITAN arbitragem (CacadorV3 com
flash swap encadeado, já implantado) e `caca` liquidações Aave/Morpho.
A estratégia enviada pelo usuário descreve **liquidação Aave dentro do
callback de swap V3**, algo que NÃO é a mesma coisa que o flash swap
de arbitragem do TITAN. Por segurança, o contrato novo não substitui nenhum
dos contratos existentes.

## Implementado e testado

| Mecanismo | Estado |
|---|---|
| `contracts/CacadorAaveFlashSwap.sol` | Código novo, isolado, **não implantado** |
| Guarda HF < 1e18 ANTES do swap | Implementado, mas HF sozinho não basta para validar uma liquidação |
| Exact-output V3 (dívida adiantada, colateral pago no callback) | Implementado; taxa V3 incorporada no input exigido |
| Checagem factory.getPool e token0/token1 | Implementado; somente V3 canônica |
| Max colateral, lucro mínimo, saldo anterior não contado | Implementado |
| Testes locais Aave (8 casos) | Sucesso com tokens mock, **não é fork real** |
| Flashblocks `src/titanFlashblocks.ts` | Diagnóstico read-only opt-in, sem alterar os sinais/ordens |
| Split `src/titanSplitRoute.ts` | Escolha entre 2 quotes independentes em memória, ainda sem executor split |
| `CacadorArbMorpho.sol` | Flash loan zero fee Morpho alternativo: testes locais, **não implantado** |
| `TITAN` original no Railway | Permanece ativo com fonte flashswap atual; código novo não fica onchain sozinho |

## Premissas da pesquisa QUE NÃO podem virar regra automática

1. **"Taxa zero" de flash swap**: não paga outro flash loan, mas swap da V3
   tem taxa e impacto de preço. Não multiplicar quantidade de oportunidades
   sem teste econômico.
2. **"1 wei economiza 46 mil gas"**: o custo de SSTORE depende de como
   o ERC20 implementa os saldos e da transição de slots; não confundir
   slot de saldo de token com conta de armazenamento do executor.
   Não depositar dinheiro em contratos por padrão.
3. **"Revert custa 22.500 gas"**: HF envolve consulta externa de Aave e
   oráculos. Medir gas de revert em fork antes de assumir orçamento.
4. **`tx.origin`**: não usar como autenticação. `immutable dono` e
   `msg.sender` já protegem as funções que exigem autorização.
5. **"Priority fee faz passar primeiro sempre"**: há limites de entrada e
   Flashblocks finalizados não podem ser reordenados retroativamente.
   Não implementar ladder de múltiplas carteiras sem coordenação de nonces,
   custos de falhas e comprovação de risco ajustado.
6. **"Binance prevê a atualização Chainlink"**: preço externo é indício,
   não prova de HF/liquidabilidade na Aave.
7. **Calldata compactado**: FastLZ no OP Stack importa, mas tabelas
   de índices usam leituras de storage e acrescentam superfície de ataque.
   Comparar a taxa L1 via `getL1Fee(bytes)` com transações realmente assinadas,
   antes de alterar ABI.
8. **Aerodrome Slipstream**: não assumir que a verificação de factory Uniswap
   serve à Slipstream; tickSpacing, factory e implantação exigem adapter testado.
9. **Split entre duas pools**: 65/35 é exemplo, não proporção universal; a
   melhor divisão exige quotes nos MESMOS estados, gas incremental e colateral
   liquidado efetivamente disponível.

## Necessário para operação REAL do novo caminho

- Criar e verificar, por leitura onchain, a factory Uniswap V3, o Aave Pool
  e as pools exatas de colateral/dívida na Base.
- Executar testes **fork Base** com ativos reais (USDC com 6 decimais,
  WETH com 18), liquidação elegível e swap exact-output. O mock não reproduz
  a liquidez e as reservas reais.
- Comparar gás L1/L2 e lucro líquido com o contrato Aave FlashLoan original.
- Passar por revisão independente do contrato e da autenticação do callback.
- Somente então implantar um contrato específico e integrar o caçador com
  `eth_call` + `estimateGas` + teto de perda, sem aumentar limites já vigentes.
- Só habilitar Flashblocks nos sinais quando o RPC confirmar suporte a
  `pending` e for possível distinguir preconfirmação de estado final.

**Não implantamos CacadorAaveFlashSwap na Base. Nenhuma carteira foi debitada
por testes locais. A arbitragem TITAN atualmente continua no executor CacadorV3.**

## Referências primárias

- Uniswap v3-core IUniswapV3SwapCallback: verificar factory canônica.
- Uniswap V3 PoolActions: quantidade negativa significa exact output.
- Aave V3 Pool docs: getUserAccountData, liquidationCall.
- Base Flashblocks: 200ms, estado pending e limitações do builder.
- OP Stack Fjord specification: FastLZ no cálculo de tarifa L1.
