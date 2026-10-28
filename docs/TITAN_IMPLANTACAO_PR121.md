# PR #121 — preparação operacional, sem ativação

Esta alteração não modifica o serviço Railway. A produção permanece na `CHAT`.
Compatibilidade verificada com `CHAT` em `c40f198`: é ancestral da branch da PR,
e a simulação de merge não encontrou conflitos. O CI remoto permanece **não
verificado**: `gh pr view 121` retorna `Forbidden`. O workflow agora cobre toda
alteração destinada a CHAT, incluindo boot, emissor, EVM e imagem Docker.

## Diagnóstico Morpho

`rota V3 ausente ou desabilitada` não era um erro de liquidez. O diretor nem
chamava o executor quando `CACA_MORPHO_V3_CONTRATO` estava ausente ou
`CACA_MORPHO_V3_AVALIAR=0`. Agora informa a variável exata. Não há acesso às
variáveis/logs Railway neste ambiente para afirmar qual dos dois casos ocorre
no serviço atual. Uma posição que cruza o limite estimado ainda precisa passar
pelo `liquidar` integral; não comprova prontidão do executor.

`MEGAZORD_MORPHO_ROTAS=v3` permite preparar somente o V3 verificado; Aero ausente
não dispara deploy nem impede V3. O padrão continua `v3,aero`. Todos os motores
selecionados precisam passar na auditoria de identidade antes da habilitação.

## Dados reais obrigatórios antes de aprovar produção

- Serviço Railway existente, comando atual, branch, volume e lista de outros
  serviços que compartilham o endereço público. Não exportar chaves privadas.
- Endereço público da carteira, `CACA_MORPHO_V3_CONTRATO` e seu
  `CACA_MORPHO_V3_CODEHASH` auditado; Aero e respectivo codehash se selecionado.
  O codehash deve ser verificado contra o artefato/deploy conhecido; copiar o
  hash de um contrato desconhecido não prova sua autenticidade.
- `TITAN_V2_CONTRATO`, `FLASH_ARB_CODEHASH`, factories/codehashes/taxas auditados
  em `FLASH_ARB_CPAMM_FACTORIES` e dois pools reais em `TITAN_PREFLIGHT_POOLS`
  para a auditoria de uma rota CPAMM. Não há placeholders de endereço neste plano.
- Dois RPCs Base independentes em `MEGAZORD_RPC_URL` e
  `MEGAZORD_RPC_SECUNDARIO`. Alinhar `CACA_RPC_URL`, `ARB_RPC_URL` e
  `TITAN_EXECUTOR_RPC_URL` ao primário verificado; manter alternativos de leitura
  somente após verificar rede e disponibilidade.
- Uma posição: `TITAN_PREFLIGHT_MERCADO` (bytes32 real) e
  `TITAN_PREFLIGHT_USUARIO` (devedor real), além do bloco histórico para fork.

Executar no ambiente com acesso aos RPCs, usando apenas configuração pública:

```sh
npm run megazord:preflight
npm run megazord:audit-contracts
npm run megazord:preflight-morpho
```

O primeiro verifica rede, saldo, freshness e nonce. O segundo confere bytecode
fixado e owner/dono, cofre, Morpho, routers, factories e versão de rotas no mesmo
bloco em dois RPCs; opcionalmente audita pools CPAMM. FlashArb não tem `cofre`:
seu getter de identidade é `owner`. O terceiro usa o executor V3 existente,
remove credenciais/permissões de envio da cópia local do ambiente e revalida
uma posição. Só retorna `pronto=true` após produzir a transação não assinada
com nonce livre, saldo de gás suficiente, calldata e piso econômico aprovados.
Calldata é evidência de preflight, não um arquivo para transmissão posterior:
o envio sempre refaz a prova no estado atual.

Fork com contratos e posição reais, sem financiamento artificial nem deploy:

```sh
# Definir BASE_FORK_RPC_URL e ARB_BLOCO, além das variáveis públicas acima.
npx hardhat test --config hardhat.config.cjs forkTests/titanMorphoPreflightFork.js
```

Esse teste recusa dados ausentes; não substitui a posição por mocks. O proxy
deste ambiente recusou `mainnet.base.org` com CONNECT HTTP 403; os dois RPCs
públicos consultados via fetch também falharam. Portanto, **não houve fork
real aprovado nem preflight aprovado de posição real nesta entrega**.

## Corte para um único processo — somente após autorização

1. Confirmar CI remoto aprovado no SHA final e revisar diff contra CHAT. Não
   fazer merge automaticamente. Auditar os dados e executar os três comandos
   acima; guardar bloco, codehashes, calldata e resultado do fork.
2. Inventariar todos os assinadores da carteira e seus diários. Desabilitar os
   envios e parar os processos antigos antes de subir o novo; reconciliar cada
   hash pendente nos dois RPCs. Não apagar diários/locks para contornar pendência.
3. No **mesmo serviço**, selecionar `railway.megazord.json` como config path
   (ou substituir seu Start Command por `node dist/megazord.js`). Este arquivo
   não é o railway.json ativo; nenhuma mudança foi aplicada ao painel. Uma
   réplica; volume persistente `/app/data`; preservar o diário de nonce.
   Não usar processo paralelo, sobreposição de deployments ou segundo serviço
   assinando. Lock de arquivo não coordena volumes independentes.
4. A identidade pública precisa corresponder à credencial existente. Definir
   `MEGAZORD_DIARIO` no volume; selecionar protocolos com contratos auditados;
   `MEGAZORD_AUTO_DEPLOY=0`. Ausência de contrato exige uma decisão separada de
   implantação, nunca auto-deploy durante este corte.
5. Após autorização específica, ativar `MEGAZORD_MODO=execucao`, confirmação e
   exclusividade requeridas. Isso habilita os protocolos Morpho selecionados
   após auditoria; não é um modo de observação. CPAMM também exige suas próprias
   autorizações V2 existentes. Autorizar somente os motores pretendidos.

## Canário proposto, ainda não autorizado

- Uma tentativa **total**, limitada por `MEGAZORD_CANARIO_ATE_UTC`, com prazo
  futuro de no máximo uma hora; `MEGAZORD_MAX_TX_DIA=1`, `CACA_MAX_ENVIOS=1`.
  Reinício ou mudança de dia não libera outra tentativa no mesmo diário.
- Teto proposto para aprovação: `MEGAZORD_GAS_MAX_TX_WEI=10000000000000` e
  `MEGAZORD_GAS_MAX_DIA_WEI=10000000000000` (0,00001 ETH, não uma conversão USD
  fixa). Se não cobrir o custo máximo L1+L2, recusar e não aumentar sozinho.
- O prazo é conferido antes da assinatura e novamente antes da reserva/envio.
  Timeout mantém o hash reservado para reconciliação. Reversão trava o circuito.
  Não reiniciar com outro diário para repetir o canário.
- Lucros de centavos podem passar com `MEGAZORD_PISO_DINAMICO=1` e limites
  explícitos de falha/margem aprovados pelo operador. Preservar pisos explícitos
  e custos máximos. Não inventar taxa de sucesso nem reduzir gás para atingir meta.
- Aceite: recibo em dois RPCs, nonce consumido, diário reconciliado, estado do
  contrato e transferências corretos. FlashArb reconcilia líquido somente com
  taxa L1 real; Morpho em token de dívida requer valorar/converter a receita
  antes de afirmar lucro líquido em USD. Não chamar cotação de lucro realizado.
- Interromper após a tentativa; revisar recibo/custo/resultado antes de qualquer
  ampliação. Rollback: parar Megazord, reconciliar pendências e só então iniciar
  **um** processo da versão anterior, mantendo o diário e os gates desligados.

## Evidência local e limites

Validação final: 2.380 testes TypeScript aprovados, zero falhas e zero ignorados;
10 testes EVM aprovados (CPAMM, Morpho V3 e emissor compartilhado); build e
typecheck aprovados. Logs locais: `/tmp/titan-ready-final-full.tap` e
`/tmp/titan-ready-evm.log`.

O teste CPAMM na EVM local cobre candidato → prova integral → revalidação →
emissor único → transação → recibo/nonce reconciliado. O token de teste emite
Transfer; taxa L1 real ausente continua produzindo lucro líquido desconhecido.
Os testes Morpho V3 locais cobrem callback/repagamento/rota/piso e controle de
acesso. Eles não substituem o teste da posição real no fork.

A imagem Docker foi construída usando a CA do proxy em um segredo temporário
de build (sem desabilitar TLS). `scripts/validarMegazordRuntime.cjs`, executado
na imagem com `--network none`, verificou artefatos, carregamento dos dois motores
e recusa de configurações sem autorização. O script não inicia scanners reais.

Bloqueios externos restantes: leitura do CI, configuração/contratos Railway,
acesso RPC e candidato histórico. Não existe evidência de US$ 1–2/h ou de captura
de todas as liquidações. Esses objetivos exigem medições de execução real após
autorização, não aumento de tentativas antieconômicas.
