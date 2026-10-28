# Corte de produção — candidato 53169975

## Evidência disponível em 27/10/2026

| Item | Valor e origem | Estado |
|---|---|---|
| PR | #121, commit `f0adf4077097ecb51b5320c2f6137e5dcf459164` | Três workflows aprovados, confirmação externa do operador |
| CHAT | `c40f1983c09c73237c93ccf63be312d903b0a167` | Consultada via Git; ancestral de f0adf40; merge sem conflitos |
| Deployment atual | `7711de0b`, iniciado às 07h50 | Informado pelo operador; não é um SHA Git comprovado |
| Log às 16h29 | `rota V3 ausente ou desabilitada` | Informado pelo operador; deployment antigo |
| Mercado | `0x8138047cee79f3f79c35d50e2c296f6f24e6789f38c255c67125d0de43968faa` | Candidato público fornecido pelo operador |
| Devedor | `0x73c2bcce6a57ea75b6f4450a13be23586baa6ef0` | Candidato público fornecido pelo operador |
| Bloco | `53169975` / `0x32b4f37` | Bloco solicitado; hash/timestamp ainda não obtidos |
| Elegibilidade real | **Indeterminada** | RPCs mainnet.base.org e base-rpc.publicnode.com bloqueados pelo proxy, CONNECT HTTP 403 |
| Executor Morpho V3 / codehash | **Não identificados** | Não confundir ausência de configuração/marcador com ausência onchain |
| Carteira, serviços e volume | Identificados pelo operador no manifesto público vinculado abaixo | Leitura atual, inventário completo e integridade ainda pendentes |

Os horários acima seguem o relato do operador, em São Paulo. Nenhum valor desta
tabela comprova lucro realizado. O candidato não foi declarado liquidável.

## Dados de infraestrutura recebidos do operador

O [manifesto público](titan-producao-publico.json) contém os IDs exatos. Carteira
informada: `0x3D310384d674532f5D41cF2D43B03001F3515AE8`.

- Projeto: `da583e14-f520-4090-9a9c-0de528ffea5c`.
- Ambiente production: `dd7ffbb5-0a0d-4aa7-b65a-9384a79d3ed5`.
- Serviço de destino titan-arbitragem: `3f298314-e80f-419f-bdcc-04e038c59317`.
- Outro assinador conhecido, renewed-sparkle: `ef919d74-5f8f-4457-9ce5-f769576fa4ed`.
- Volume titan-memoria: `27c07a9a-39d3-4358-969e-c812e7db6c9e`, mount informado `/app/data`.
- Diário anteriormente configurado: `/app/data/megazord-diario.json`.

Esses valores são informação do operador, não uma leitura independente do estado
atual. O marcador V3 foi identificado anteriormente, mas seu conteúdo segue
pendente. A lista de dois serviços não prova que inexistam outros assinadores.

A coleta agora usa somente módulos nativos do Node, **não acessa chaves privadas**
e inclui uma impressão SHA-256 dos arquivos lidos para comparar evidências. O
checksum identifica o conteúdo observado; não prova integridade histórica nem
reconciliação onchain. O caminho histórico do diário é consultado mesmo quando
MEGAZORD_DIARIO não está presente no processo antigo. Nenhum arquivo é criado.

Em um terminal com Railway CLI autenticado, no checkout desta PR, a coleta
somente leitura pode ser executada nos dois serviços existentes:

```sh
railway ssh --project da583e14-f520-4090-9a9c-0de528ffea5c --environment dd7ffbb5-0a0d-4aa7-b65a-9384a79d3ed5 --service 3f298314-e80f-419f-bdcc-04e038c59317 -- node -e "$(cat scripts/titanInventarioPublico.cjs)" > titan-inventario.json
railway ssh --project da583e14-f520-4090-9a9c-0de528ffea5c --environment dd7ffbb5-0a0d-4aa7-b65a-9384a79d3ed5 --service ef919d74-5f8f-4457-9ce5-f769576fa4ed -- node -e "$(cat scripts/titanInventarioPublico.cjs)" > cacador-inventario.json
```

Comandos preparados, não executados neste ambiente: não há conector Railway
nem sessão autenticada disponível. Os JSONs resultantes permitem avançar sem
solicitar segredos ou fazer deploy. Auditar também os demais serviços do projeto.

## Fechamento dos dados faltantes, sem deploy

1. Executar `scripts/titanInventarioPublico.cjs` **dentro de cada serviço
   existente** por sessão de leitura/execução do operador, disponibilizando o
   arquivo temporariamente; não trocar o deployment para obter o inventário.
   O script só lê ambiente, mountinfo e JSONs conhecidos. Não escreve arquivos,
   chama RPC, assina ou transmite. Não enviar dump de ambiente.
2. Agrupar os resultados pelos endereços públicos configurados. A coleta não lê chaves privadas e não comprova criptograficamente a identidade do signer. Registrar todos os
   service IDs com a mesma carteira, mesmo se `*_ENVIAR=0`. Conferir Start Command
   no painel, pois APP_ENTRY não revela overrides do Railway. Registrar também
   jobs/serviços pausados que possam reiniciar com essa carteira.
3. Buscar V3 em `CACA_MORPHO_V3_CONTRATO`, no marcador
   `/app/data/titanMorphoV3Deploy.json` e no cache `<MEGAZORD_DIARIO>.contratos.json`.
   Se houver hash reservado, reconciliar nos dois RPCs; não repetir deploy.
   Se todos estiverem ausentes, consultar histórico de criações da carteira e
   recibos conhecidos. Só essa investigação pode sustentar ausência onchain.
4. Verificar que `RAILWAY_VOLUME_ID` pertence ao serviço, mount path é `/app/data`
   e `volumeMontadoEmAppData=true`. Um diretório existente não basta. Registrar
   qual diário será preservado. Não apagar ou reinicializar diários/locks.
   Persistência após reinício ainda precisa ser confirmada no corte autorizado.

## Investigação histórica pronta para executar

No checkout com dependências e `dist` compilado, usando um RPC Base de arquivo:

```sh
# BASE_FORK_RPC_URL fornecido pelo ambiente; não colar credenciais no relatório.
node scripts/titanCandidato53169975.cjs > candidato-53169975.json
```

O script fixa todas as leituras no bloco informado, verifica chainId, id do
mercado e hash do bloco antes/depois. Lê posição, totais e oracle. O radar é
apenas estimativa. Uma sonda direta `liquidate` de uma share inclui accrual:
`position is healthy` decodificado da reversão prova recusa por saúde naquele
contexto; falhas de repayment, callback ou RPC permanecem inconclusivas.
Mesmo sucesso nessa sonda **não** aprova o executor V3 nem prova lucro.

Depois de identificar e auditar o executor real, usar exatamente:

```sh
export TITAN_PREFLIGHT_MERCADO=0x8138047cee79f3f79c35d50e2c296f6f24e6789f38c255c67125d0de43968faa
export TITAN_PREFLIGHT_USUARIO=0x73c2bcce6a57ea75b6f4450a13be23586baa6ef0
export ARB_BLOCO=53169975
npm run megazord:preflight
npm run megazord:audit-contracts
npx hardhat test --config hardhat.config.cjs forkTests/titanMorphoPreflightFork.js
```

As auditorias iniciais são do estado atual; o último comando é o preflight no
fork histórico. `npm run megazord:preflight-morpho` isolado consulta o estado
atual, **não** aplica ARB_BLOCO. Não confundir os dois resultados. Se o executor
não existia no bloco histórico, esse fork não pode validar sua execução sem
alterar estado; registrar essa limitação, sem inventar implantação histórica.

## Configuração do mesmo serviço, preparada mas não aplicada

| Campo | Valor preparado / pendência |
|---|---|
| Config path | `railway.megazord.json` |
| Start Command efetivo | `node dist/megazord.js` |
| Réplicas | `1` |
| Volume | `/app/data`; ID `27c07a9a-39d3-4358-969e-c812e7db6c9e`, informado; mount atual pendente |
| `MEGAZORD_DIARIO` | `/app/data/megazord-diario.json`; conteúdo/reconciliação pendentes |
| `MEGAZORD_MORPHO_ROTAS` | `v3`, somente após auditoria do V3 |
| `MEGAZORD_AUTO_DEPLOY` | `0` |
| Carteira / contrato / codehash | Carteira no manifesto; contrato V3 e codehash ainda pendentes |
| RPC primário/secundário | Dois endpoints Base verificados, ainda pendentes |
| Aliases RPC | Alinhar CACA_RPC_URL, ARB_RPC_URL e TITAN_EXECUTOR_RPC_URL ao primário verificado |
| `MEGAZORD_MAX_TX_DIA`, `CACA_MAX_ENVIOS` | Proposta: `1` / `1` |
| Teto por tentativa e diário | Proposta: ambos `10000000000000` wei (0,00001 ETH); exige aprovação |
| `MEGAZORD_CANARIO_ATE_UTC` | Definir no corte autorizado; futuro, no máximo uma hora |
| Permissões de execução | Permanecem desligadas; habilitar só após autorização específica |

O boot financeiro habilita os protocolos selecionados após auditoria. Não usar
`MEGAZORD_MODO=execucao` como se fosse observação. Não ampliar pisos/budgets nem
escolher probabilidades de falha fictícias. A política dinâmica existente aceita
lucros pequenos quando cobrem L1/L2, taxas e a margem de risco aprovada.

## Condições para a primeira tentativa

- [x] CI de f0adf40 confirmado externamente pelo operador; CHAT compatível.
- [x] Entry point único, imagem e canário persistente testados localmente na entrega anterior.
- [x] Candidato histórico e consultas reproduzíveis preparados; nenhuma alteração dos motores nesta entrega.
- [ ] Identificar todos os serviços/signers da carteira e registrar IDs.
- [ ] Identificar executor real, verificar codehash, dono/cofre/factories e versão em dois RPCs.
- [ ] Obter hash do bloco e resultado real da posição histórica; se inelegível, registrar recusa.
- [ ] Confirmar volume/diário montado e reconciliar todos os hashes pendentes.
- [ ] Parar os assinadores antigos **antes** de iniciar Megazord, sem rolling overlap.
- [ ] Autorizar explicitamente corte, motor(es), teto e janela do canário.
- [ ] Revalidar uma oportunidade elegível no estado atual; não reutilizar calldata histórica.
- [ ] Após a única tentativa, guardar hash/nonce/recibos/L1/L2 e reconciliar antes de qualquer ampliação.

Rollback preparado: parar Megazord, preservar volume, reconciliar a tentativa
e só então restaurar o deployment/comando anterior com envios desligados. Não
restaurar simultaneamente outro assinador nem trocar o diário para liberar uma
segunda tentativa. Caso não apareça oportunidade econômica, o resultado correto
é zero tentativas; a meta de US$ 1–2/h não autoriza operações deficitárias.


## Auditoria independente de 28/10/2026 (sem envio, via GitHub Actions e Railway)

Fonte imutavel do corte: [workflow GitHub Actions 40672436143](https://github.com/srtebanha-ux/crypto-gpt/actions/runs/40672436143). Os JSONs foram recuperados e examinados diretamente do artefato da execucao, **nao** da anotacao anterior do operador.

- **V3 existente validado na Base, no bloco 53197009**: contrato `0x8F5268D7cBb4597321EB886c4Ef0CE75a6C8C317`, codehash `0x85a04d2c4496ecbfcfa9f594a9d6d4b3a4fce2571c997cee1cb24c161fecce4a`. Bytecode igual em dois RPCs, `versaoRotas=2`, dono/cofre/Morpho/router/fabrica coincidem. `compiledExecutableMatchesOnchain=true`, compilador Solidity 0.8.26, EVM Paris, optimizer 200, 0 bytes divergentes apos mascarar os 16 imutaveis. Artefato: `titan-existing-v3-railway-audit/executor-v3-railway.json`. Essa prova e limitada ao bloco; **nao autoriza transacao paga**.
- **V2 corrente nao autorizado**: os tres FlashArb V2 examinados possuem bytecode igual nos dois RPCs, mas `matchesCurrentFlashArbArtifact=false` nos tres e `readyForExecution=false`. Artefato `titan-base-flasharb-v2-identity/flasharb-v2-publico.json`. Nao habilitar V2 com o artefato atual.
- **Candidato historico 53169975**: hash do bloco `0x1c2c40d2f4a9c2c9dcf2ad46d91a372fc6eebcfdd16b81056edc9b967d1f90d5`, distancia estimada `-77` bps (cruzado), mas a sonda de liquidacao reverteu com `transferFrom reverted`. Resultado `gate_saude_passou_mas_repagamento_falhou`, sem prova de execucao do V3 ou lucro. Artefato `titan-base-candidate-53169975/candidate.json`. **Nunca tentar replay**.
- **RPCs publicos no runner GitHub**: mainnet.base.org, base-rpc.publicnode.com e 1rpc.io/base retornaram envelope valido em chainId e getBlock; llama respondeu HTTP 403. Artefato `titan-base-rpc-envelope/rpc-envelope-publico.json`. Em contraste, o Railway exibiu resposta nula de bloco no principal em 28/10; sucesso no runner GitHub nao substitui o teste de quorum no Railway.
- **Inventario Railway confirmado por conector**: sete servicos no ambiente production. `titan-arbitragem` com volume `titan-memoria` montado em `/app/data`, uma replica, `node dist/megazord.js`, logs indicando modo medicao, `CACA_ENVIAR != 1` e HOT `envioConfigurado=false`. `renewed-sparkle` ativo com variavel de chave presente e logs recentes de envio desligado para o motor principal (permissoes de outros modulos ainda indeterminadas). `titan-implantacao-unica` com chave configurada, Start Command de auditoria somente leitura, deploy `SKIPPED`. `railway-arbitrage-bot` possui `PRIVATE_KEY` configurada, mas uso do assinador indeterminado. `titan-multihop-readonly` registra carteira nenhuma e envio inexistente; `aave-multichain-observer` e `invigorating-courtesy` sao observadores segundo seus comandos configurados.
- **Pendente e bloqueante**: conteudo real de `/app/data/titanMorphoV3Deploy.json` e `MEGAZORD_DIARIO`, checksums/reconciliacao de hashes pendentes, permissoes efetivas de todos os assinadores, quorum dos RPCs *no Railway* e aprovacao de um `eth_call` integral economicamente positivo no bloco atual. Os valores de variaveis Railway sao ocultados pelo conector; **nao inferir os flags de envio a partir da presenca dos nomes**.

Patch auxiliar na [PR #122](https://github.com/srtebanha-ux/crypto-gpt/pull/122): corrige prioridade de candidatos cruzados/proximos no HOT e reduz a espera de 45s para o proximo ciclo quando o unico preflight esta ocupado por outro worker. Testes de regressao adicionados. PR isolada, sem deploy financeiro.
