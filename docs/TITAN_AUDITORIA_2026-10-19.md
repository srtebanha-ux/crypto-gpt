# TITAN — auditoria inicial e primeira correção

Base inspecionada: `feat/caca-integracao-multihop-ativa`, commit
`2f2d7401f7d75f486cc1ebdb1812bc2ec7734d47`, confirmado por `git ls-remote`.
Esta é uma entrega parcial. Não constitui auditoria completa dos contratos,
comprovação de rentabilidade ou autorização para ativar execução real.

## Correções desta entrega

- `src/flashArbExecutor.ts`: leitura inválida de `balanceOf` lança erro em vez
  de assumir zero, preservando o saldo anterior no piso on-chain.
- `src/dexArbitrageSniffer.ts`: `eth_call` usa o `owner()` consultado no contrato.
  Antes, passava o próprio contrato como remetente, incompatível com `apenasDono`.
- Ensaio recusa executor sem bytecode e resposta ausente ou incompatível com o
  retorno vazio de `executarArbitragem`. Isso não autentica a identidade do bytecode.
- Antes de transmitir, o executor confere carteira versus proprietário e repete
  o ensaio com o remetente real. Uma reprovação impede a chamada ao transmissor.
- Piso inclui custo de gás informado mais a fração de lucro líquido exigida,
  preserva saldo anterior e arredonda para cima nas unidades do token.
  Não substitui medição atualizada de L1/L2 nem protege contra toda mudança de estado.
- Logs distinguem oportunidade teórica, simulação e confirmação sem reconciliação.
  Recibo com status 1 não é classificado como lucro realizado.
- Testes de regressão em `flashArbRpc.test.ts` e `flashArbExecutor.test.ts`;
  workflow `caca-multihop-integrado.yml` passa a executá-los e checar tipos.

## Mapa inicial e pendências

| Área | Evidência no código | Pendência |
| --- | --- | --- |
| Entrada de serviço | Dockerfile executa `dist/${APP_ENTRY}.js`, padrão `live`; railway.json não fixa startCommand | Conferir APP_ENTRY e override reais de cada serviço no Railway |
| Caçador | `cacarAoVivo.ts`, ponte `titanPonteMultiHop.ts` | Confirmar configuração, contrato e permissões efetivamente ativos |
| Arbitragem | `dexArbitrageSniffer.ts`, `ammMath.ts`, `flashArbExecutor.ts`, `FlashArb.sol` | Identificar factories/modelos/fees on-chain; leitura getReserves sozinha não prova CPAMM |
| CPAMM | `titanTamanhoCpamm.ts` só é referenciado por seus testes | Conectar sementes ao fluxo de arbitragem com reservas inteiras, snapshot consistente e tipos de pool comprovados; não aplicar ao caminho de liquidação como se fosse ciclo de dois pools |
| Otimizador | `titanOtimizadorTamanho.ts` é usado pelo planejador de liquidação | A callback precisa representar simulação completa; não trocar por lucro algébrico |
| Multi-hop | Ponte simula chamadas e estima gás, inclui reserva L1; revalida bytes finais | Validar em fork e medir custo L1/L2 atual; nenhuma prova econômica nova nesta sessão |
| Falsos positivos | Modelagem teórica separada de eth_call; piso e leituras corrigidos nesta entrega | Reproduzir tokens fee-on-transfer históricos com endereços/blocos reais |
| Nonce | Caçador usa LocalNonceManager; executor de arbitragem usa Wallet independente | Não há evidência de coordenação entre serviços; não ativar os dois signers para a mesma carteira sem resolver coordenação |
| Flashblocks | `iniciarObservadorFlashblocks` chamado pelo Caçador, opt-in; fallback newHeads e reconexão | Deduplicação, ordenação e integração ao estado do planejador ainda precisam revisão e testes de transporte; endpoint WSS não disponível |
| Morpho | Contratos CacadorMorpho/CacadorAaveMultiHopMorpho e radar multirrede | Testes locais existem; validar mercados, estado e transação integral em fork |
| SVR | Observador não envia; `titanSvrOperacao.ts` prepara EIP-712 e valida bond declarado | Verificar contrato, VERIFICATION, bond e simulação do lote no estado atualizado do oráculo on-chain; não confundir dados fornecidos ao validador com evidência on-chain |
| Pyth | Nenhuma implementação identificada na busca em src | Identificar mercados reais antes de implementar Hermes e atualização atômica |
| Otimização | Nenhum benchmark novo executado | Medir antes de introduzir Rust, FastLZ ou calldata compacta |

## Validação e limites

Comandos de preparação: `npm ci --cache /tmp/titan-npm-cache --no-audit --no-fund`.
Node usado: 24.19.0; Docker/CI especificam Node 22. Lockfile preservado.

- Build TypeScript e typecheck executados.
- Regressões do executor: 18 testes de planejamento e 7 testes RPC passam.
- Solidity 0.8.26: 10 arquivos compilados.
- EVM local: 6 testes passam em `morphoAuditoriaLocal.js` e
  `titanAtlasMorphoLocal.js`, incluindo preservação de saldo, transfer false,
  signer inválido e reversão integral de lote. Usam mocks, não estado da Base.
- Nesta máquina Hardhat requer XDG_CONFIG_HOME, XDG_CACHE_HOME e XDG_DATA_HOME
  em diretórios graváveis sob /tmp. A restrição de subprocessos causou saída
  vazia de solc; a execução autorizada fora dessa restrição resolveu a compilação.
- A primeira execução do runner Node no sandbox reportou apenas arquivos,
  não casos internos. Não usar esses números como aprovação da suíte.
- A suíte completa foi reexecutada com subprocessos funcionais: 1.890 casos,
  1.887 aprovados e 3 reprovados (antes da adição do sétimo teste RPC,
  validado separadamente). Encontrou
  falhas nos testes estáticos de censo em `capacidade.test.ts` e
  `disponibilidadeReal.test.ts`: esperam orçamento/retry e autorizarVarredura
  do fluxo antigo, enquanto o código usa RPC histórico dedicado. Esses arquivos
  e o Caçador não foram alterados nesta entrega. É necessário revisar o contrato
  de disponibilidade do censo e atualizar testes comportamentais; não apagar
  assertions apenas para obter CI verde. Reproduzidas as mesmas três falhas
  em uma cópia temporária intacta de 2f2d740: 64 testes, 61 aprovados e 3
  reprovados. Isso confirma que essas falhas precedem esta correção.

Comando local de contratos:

```sh
XDG_CONFIG_HOME=/tmp/titan-config XDG_CACHE_HOME=/tmp/titan-cache \
XDG_DATA_HOME=/tmp/titan-data npx hardhat test --config hardhat.morpho-local.cjs \
  forkTests/morphoAuditoriaLocal.js forkTests/titanAtlasMorphoLocal.js
```

## Bloqueios externos verificados

- Git HTTPS permite consultar e baixar a branch. `gh api` para o próprio
  repositório retorna Forbidden; criação de PR/consulta do CI requer acesso API.
- Conector Railway e CLI Railway indisponíveis; nenhum binding Railway/RPC
  identificado entre os nomes de variáveis presentes. Não foram lidos valores
  de segredos. Estado, saldo e deploy históricos não foram revalidados.
- Consulta `eth_chainId` a `https://mainnet.base.org` e leitura de
  `https://docs.base.org/base-chain/network-information/flashblocks` retornaram
  HTTP 403. Não se afirma suporte atual a endpoints nem ocorrência de Denim.
- O teste de fork `titanMultiHopBaseFork.js`, bloco 52418045, foi tentado
  com `--no-compile` e interrompido por timeout de 45 s (exit 124), sem
  concluir nenhum caso. Não conta como teste aprovado.
- O único anexo recebido foi a missão em texto. Falta o PDF
  **Engenharia Avançada de Bots MEV.pdf**; comparação das 24 páginas pendente.

## Status

IMPLEMENTADO: primeira correção de segurança do executor e testes/CI associados.
TESTADO: regressões específicas, build/tipos e seis casos EVM locais; suíte
completa tem falhas, fork real depende de RPC acessível.
IMPLANTADO: nenhuma mudança desta entrega.
VALIDADO ECONOMICAMENTE: nenhuma oportunidade nesta sessão.
LUCRO REALIZADO: nenhum recibo ou reconciliação nesta sessão.

Nenhuma transferência, depósito, deploy pago ou ordem real foi executada.
