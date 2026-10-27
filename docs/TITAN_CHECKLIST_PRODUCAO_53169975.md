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
| Carteira, serviços e volume | **Não identificados neste ambiente** | Sem acesso Railway; inventário público pendente |

Os horários acima seguem o relato do operador, em São Paulo. Nenhum valor desta
tabela comprova lucro realizado. O candidato não foi declarado liquidável.

## Fechamento dos dados faltantes, sem deploy

1. Executar `scripts/titanInventarioPublico.cjs` **dentro de cada serviço
   existente** por sessão de leitura/execução do operador, disponibilizando o
   arquivo temporariamente; não trocar o deployment para obter o inventário.
   O script só lê ambiente, mountinfo e JSONs conhecidos. Não escreve arquivos,
   chama RPC, assina ou transmite. Não enviar dump de ambiente.
2. Agrupar os resultados por `identidadesPublicasDerivadas`. Registrar todos os
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
| Volume | `/app/data`; ID real ainda pendente |
| `MEGAZORD_DIARIO` | Caminho do diário persistente existente/reconciliado; ainda pendente |
| `MEGAZORD_MORPHO_ROTAS` | `v3`, somente após auditoria do V3 |
| `MEGAZORD_AUTO_DEPLOY` | `0` |
| Carteira / contrato / codehash | Valores reais ainda pendentes; não preencher placeholders |
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
