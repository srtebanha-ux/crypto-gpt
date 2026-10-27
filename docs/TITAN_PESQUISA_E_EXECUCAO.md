# TITAN: pesquisa aplicada e validação econômica

Continuação da PR #55, branch `codex/titan-validation`. As 24 páginas de
**Engenharia Avançada de Bots MEV.pdf** foram lidas como referência, não como
instruções para executar contratos, assinar operações ou prometer retorno.
Foram preservados os oito commits externos posteriores a `924ebb9`, até
`4f4fab4`, incluindo a ponte CPAMM e as correções do censo histórico.

## O que mudou no caminho real

`dexArbitrageSniffer` usa a ponte CPAMM existente para levantar candidatos.
O teto usa a reserva do token de entrada, sem comparar reservas denominadas
em ativos distintos. A busca Decimal agora inclui a taxa proporcional do
empréstimo na função otimizada; descontá-la apenas depois escolhia tamanho errado.

Os melhores candidatos teóricos, em orçamento limitado por varredura, passam
por `prepararCpammAtomico`. Esse novo caminho:

1. Confere chainId 8453, hash do bytecode do executor e seu owner.
2. Confere factories explicitamente auditadas, runtime dos pares, tokens,
   `getPair`, reservas inteiras e taxa fixa 997/1000. O FlashArb atual não
   implementa outro modelo: V3, Slipstream e pools estáveis não entram aqui.
3. Relê as reservas em um bloco fixo e dimensiona com BigInt. O pagamento
   do flash swap usa exact-output com `+1`, como o contrato existente.
4. Recusa saldo ALT prévio no executor legado para não subsidiar transferências
   taxadas. Preserva o saldo anterior de WETH no piso final.
5. Estima execução, adiciona margem de gás e consulta o teto L1 do GasPriceOracle
   usando o tamanho do envelope real não assinado. Um custo ausente recusa a rota.
6. Executa `eth_call` do calldata final com o owner, gás limitado, pagamento
   completo e piso que cobre L1/L2 e lucro líquido mínimo. Reversão ou retorno
   inválido não é oportunidade simulada.
7. Rejeita resultado quando o bloco mudou durante a avaliação. Uma prova no
   snapshot não autoriza assumir que a oportunidade sobreviverá à inclusão.

A avaliação é restrita a ciclos com lucro em WETH: comparar lucro em USDC com
custo em ETH sem conversão verificável seria incorreto. Estima no máximo três
quantias próximas da semente por candidato. RPCs independentes de identidade e
reservas dos pares são paralelos; cálculos continuam inteiros.

O scanner não faz broadcast, mesmo se `FLASH_ARB_LIVE=true`. Antes havia um
`Wallet` independente do Caçador: flags locais não coordenam nonces entre
máquinas Railway. A próxima integração de envio deve usar o emissor único do
Caçador, com reserva de nonce, revalidação e reconciliação. Não declarar esse
problema resolvido por um mutex local ou uma variável que afirma exclusividade.
O Caçador e seus modos de envio existentes não foram ativados nem alterados aqui.

## Configuração para observação sem envio

- `FLASH_ARB_CONTRACT`: executor existente, confirmado na Base.
- `FLASH_ARB_CODEHASH`: keccak256 do runtime auditado, incluindo imutáveis.
- `FLASH_ARB_CPAMM_FACTORIES`: JSON de objetos com `endereco`, `poolCodeHash`,
  `taxaNumerador: 997`, `taxaDenominador: 1000`. Identidades devem vir da
  validação da implementação, não de confiar automaticamente em qualquer
  resposta `getReserves` ou aceitar o hash de um contrato desconhecido.
- `FLASH_ARB_MIN_NET_WEI`: piso líquido em WETH, inteiro positivo; padrão
  1.000.000.000.000 wei. É um piso por operação, não meta em dólares por hora.
- `FLASH_ARB_MAX_SIMULATIONS_PER_SCAN`: padrão 12, intervalo 1–128. Limita
  candidatos; os demais continuam explicitamente não simulados.
- RPC Base com histórico `eth_call`, `eth_getCode`, `eth_estimateGas` no bloco
  escolhido e acesso ao GasPriceOracle. Não requer chave privada para simular.

Hash do executor autentica a identidade esperada; não substitui auditoria. O
hash de runtime do FlashArb inclui o proprietário imutável. Registre a versão,
bloco, factory e bytecode de referência antes de preencher essas variáveis.
Não publique configuração com valores fictícios só para liberar a validação.

## Pesquisa: decisões e correções

| Páginas | Proposta | Aplicação no TITAN |
| --- | --- | --- |
| 1–2 | Flash loan e retorno de 500% com microcapital | Não é previsão demonstrada. Medir taxas de inclusão, reversão, infraestrutura, lucro e perdas reais. |
| 2–5 | Flashblocks/Denim | Observador existente corrigido para duplicatas, eventos fora de ordem, reconexão e encerramento durante handshake. Fallback por capacidade observada, sem datas de fork presumidas. |
| 5–7 | FastLZ e piso Fjord | Consultar GasPriceOracle. `getL1Fee` recebe envelope NÃO assinado; Fjord já acrescenta 68 bytes. Corrigidos helper e preflight de implantação, sem implantar contrato. |
| 8–9 | Tamanho analítico CPAMM | Semente inteira aplicada ao fluxo real e subordinada à simulação. Não aplicar essa fórmula a ticks V3 ou a uma rota aberta de colateral para dívida. |
| 10–11 | Liquidação Morpho | Reusar CacadorMorpho e ponte MultiHop. O exemplo mistura LIF e desconto: LLTV 75% dá LIF aproximadamente 1,081081, não 1,06. Replays precisam juros e arredondamentos on-chain. |
| 12 | Pyth | Só integrar após comprovar mercado → oracle → feeds. Atualizar Pyth não move um mercado que usa Chainlink. Atomicidade não elimina concorrência ou reversões. |
| 13–19 | Executor compacto Solidity/Yul | Não copiar: callback V3 sem autenticação, segunda perna ausente e mantissa `[4..5]` extraída como `[5..6]`. Pode gastar saldo prévio de colateral. |
| 19–22 | Rust e codec | Exemplo usa reservas fictícias, f64 e tamanho FastLZ fixo de 98 bytes. Não prova execução nem economia. Medir gargalo antes de migrar a linguagem. |
| 22–24 | Síntese e fontes | Não transformar garantias de ROI/“zero frontrun” em requisitos do sistema. Priorizar implementações oficiais e evidência no estado da rede. |

O contrato da pesquisa permite que qualquer chamador invoque
`uniswapV3SwapCallback` para pedir transferência de tokens do executor. O código
existente de Morpho/MultiHop já possui verificações melhores de contexto e pools;
substituí-lo pelo exemplo seria uma regressão de segurança.

Fonte oficial consultada para envelope/assinatura e fórmula Fjord:
[GasPriceOracle.sol — Optimism](https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol),
`getL1Fee`, `_getL1FeeFjord` e `getL1FeeUpperBound`. O limiar de 170 bytes do
modelo não significa que sete bytes de calldata sempre produzam esse tamanho
comprimido. Endereços, assinatura, nonce e envelope também importam. Um codec
compacto só deve ser implantado após comparação de custo total, incluindo
registro de endereços e amortização do deploy.

## Evidência e limites

Validação final desta entrega: **1.912 testes TypeScript aprovados, zero falhas;
9 testes EVM locais aprovados; build e typecheck aprovados.** Os testes locais
de contrato incluem Morpho, Atlas e CPAMM. Nenhum teste foi pulado nessas execuções.

- Suíte geral após integrar os commits externos e melhorias preliminares:
  1.908 testes aprovados, nenhuma falha. As três falhas históricas do censo
  foram resolvidas pelos commits externos preservados; não foram apagadas.
- Testes novos `titanCpammAtomico.test.ts`: identidade, factory, taxas, custos,
  unidade de lucro, saldo prévio, estado desatualizado e ausência de broadcast.
- `titanCpammLocal.js` usa o FlashArb real e pares/token/oráculo de teste na EVM
  local: operação com piso positivo, token taxado revertendo em `UniswapV2: K`
  apesar de lucro teórico positivo, e bloqueio de saldo ALT prévio.
- Esse teste reproduz o mecanismo de falha; NÃO é replay de uma transação
  histórica da Base. Os testes históricos permanecem separados, com seus
  endereços e blocos. O RPC público ainda retornou HTTP 403 nesta continuação.
- As regressões Flashblocks exercitam transporte e relógio simulados, não
  comprovam a disponibilidade ou o comportamento atual de um fornecedor WSS.
- Mocks de Atlas/Morpho não comprovam implantação do solver, bond ou lucro no
  Atlas real. Nenhum bid, depósito ou deploy foi feito.

## Meta econômica e próximos critérios

US$1/h mínimo e US$2/h desejável são metas para observar, não pressupostos do
planejador. Lucro realizado por hora deve reconciliar recibos e diferenças de
saldo, descontar gás L1/L2 de sucessos E reversões e custos operacionais. Sinais
repetidos, oportunidades teóricas, bônus protocolar e simulações não entram
nessa soma. Abaixo da meta, não reduzir o piso nem enviar sem prova econômica.

Para avançar de simulação para execução, faltam evidências externas concretas:

1. Identidades auditadas do executor/factories e RPC que permita os replays
   históricos. Conferir APP_ENTRY e configuração de cada serviço Railway.
2. Transmissor único para a carteira compartilhada; filas, nonce pendente,
   substituição de transação e recuperação após reinício testados entre serviços.
3. Revalidação imediatamente antes do envio, custos atualizados e reconciliação
   de recibos. Deploy ou transação paga só com autorização específica.
4. Morpho: mercado real, fonte do oráculo, liquidação e venda de colateral no
   mesmo fork. SVR: preço futuro aplicado na ordem correta, Atlas/VERIFICATION,
   solver e bond comprovados. Pyth: primeiro provar mercado compatível.

IMPLEMENTADO e TESTADO localmente não significam IMPLANTADO, VALIDADO
ECONOMICAMENTE na Base ou LUCRO REALIZADO. Esta entrega mantém essas distinções.
