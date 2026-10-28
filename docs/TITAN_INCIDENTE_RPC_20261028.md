# TITAN/MEGAZORD — incidente real de preflight da Base, 28/10/2026

## Status verificado (sem inferir lucro)

- Railway: projeto `da583e14-f520-4090-9a9c-0de528ffea5c`, produção `dd7ffbb5-0a0d-4aa7-b65a-9384a79d3ed5`, serviço `titan-arbitragem` (`3f298314-e80f-419f-bdcc-04e038c59317`).
- Deploy `dc8f9a76-effc-4c9f-b145-00ddbda13514`, commit `1fa70b891636ede42fc095c6f8db60e113e700fb`, em `/app/data`. O status Railway SUCCESS/Online não comprova boot: log às **11:37:51 UTC** marcou `Megazord interrompido` antes de carregar os motores.
- Erro final: `fase=rede_pre_contratos: preflight bloqueado: 7 primarios independentes indisponiveis para quorum de dois RPCs; categorias=p1_eth_chainId_body_invalido,p2_eth_getBlockByNumber_body_invalido,p3_sem_quorum_secundario,p4_eth_getBlockByNumber_body_invalido,p5_eth_getBlockByNumber_body_invalido,p6_eth_getBlockByNumber_body_invalido,p7_eth_chainId_transporte; sem envio`.
- Correções colocadas em produção: novos operadores independentes de RPC (PublicNode, dRPC, Pocket, BlockPI, Alchemy público), categorias sanitizadas de falha, fallback de bloco numérico explícito quando `latest` devolve resposta nula, sem afrouxar chainId=8453, idade de bloco, nonce, saldo, bytecode ou quorum 2.
- GitHub [PR #121](https://github.com/srtebanha-ux/crypto-gpt/pull/121), commit `1fa70b8`: quatro workflows concluíram `success` (readiness regressions, public Base candidate, Morpho discovery, CPAMM integration). CI verde NÃO é produção lucrativa.
- Auditoria de volume **real**, lida dentro do container às 11:35 UTC: montagem confirmada, `titanMorphoV3Deploy.json` e `titanMorphoAeroDeploy.json` estruturalmente legíveis com `status=confirmed`, cache de contratos legível, `MEGAZORD_DIARIO` ausente, lock do diário ausente, `titanMorphoV3Tx.json` ausente. Ausência NÃO equivale a reconciliação histórica.
- Canário de execução real autorizado até **11:54 UTC** de 28/10/2026, uma única tentativa, teto de **10000000000000 wei (0,00001 ETH)** tanto por transação quanto por dia, sem auto-deploy. Foi renovado após `prazo_expirado`. Essa janela não constitui prova de que alguma transação foi enviada.
- **Nenhuma transação lucrativa comprovada** via hash, status de recibo e diferença patrimonial líquida. O bloqueio na fase de rede impede afirmar envio real.

## Próximo bloqueio a eliminar

É necessário prover **dois RPCs Base mainnet autenticados e verdadeiramente independentes**, acessíveis do Railway, que respondam de forma íntegra e recente a `eth_chainId`, `eth_getBlockByNumber`, `eth_getTransactionCount`, `eth_getBalance` e `eth_getCode`. A configuração existente usa valores privados/redigidos que não podem ser lidos pela conexão OAuth. Não há justificativa para remover o quorum, falsificar bloco, ignorar nonce ou liberar gas sem essa prova.

Após os endpoints funcionarem: revalidar imutáveis/codehash V3/Aero, conciliar os assinadores antigos e qualquer recibo pendente, observar `Preflight de execucao aprovado`, executar somente um candidato economicamente comprovado sob o teto atual e contabilizar hash+recibo+saldo antes de afirmar lucro. Não repetir canário expirado automaticamente.

**Segurança:** este documento não contém tokens, URLs privadas, chaves ou dados sensíveis. As correções não comprovam lucro ou operação saudável.

## Atualização comprovada — recuperação do boot, 28/10/2026 12:50 UTC

- **Causa raiz RPC identificada:** o `eth_getBlockByNumber` retornava HTTP 200 com corpo de 9–10 KB inválido como JSON; ao enviar `Accept-Encoding: identity`, passou a retornar JSON íntegro (~16–26 KB), `jsonrpc=2.0`, ID correto e resultado não nulo em provedor principal, secundário e PublicNode. Correção aplicada em `src/megazordRpcLeitura.ts` e nos leitores Morpho.
- **Segundo problema eliminado:** o dRPC gratuito recusava lotes acima de três requisições. Configurado `batchMaxCount:1` nos `JsonRpcProvider` financeiros, de preço e Morpho; limitações de vazão e backoff em `rpcCoordenado`.
- **Trava obsoleta recuperada com prova:** deploy `95fe7aca-bf1f-4c41-b37c-06526f98f6b9` gravou `[TITAN/LOCK-RECUPERACAO-CONTROLADA] {\"recuperado\":true,\"categoria\":\"lock_obsoleto_arquivado\"}` após checagem de nonce em dois RPCs, arquivo antigo/de outro host e diário financeiro ausente. A trava foi preservada com backup hardlink; a variável opt-in `MEGAZORD_RECUPERAR_LOCK_OBSOLETO` foi devolvida a `0` sem redeploy.
- **Boot REAL confirmado:** no mesmo deploy, o log de 12:50:20 UTC registrou `Preflight de execucao aprovado` com dois RPCs e `Motores unidos no mesmo processo`, `modo=execucao`, `executorFinanceiroUnificado=true`; Morpho HOT registrou `envioConfigurado=true`. O `CACA_ENVIAR != 1` do motor legado é esperado enquanto V1/V2 não são liberados, NÃO bloqueia o envio Morpho V3 armado.
- **CI:** commit `e79880c3`, quatro workflows completos `success` (readiness, Morpho, candidato público, CPAMM).
- **Ainda sem transação rentável confirmada:** posições Morpho avaliadas às 12:50–12:52 UTC reverteram `position is healthy` no `eth_call` integral. Não é elegível liquidar saudáveis. O scanner de arbitragem encontrou spreads estimados, mas sem prova atômica: histórico demonstra token com taxa de transferência elevada (48%), que reverte `UniswapV2: K`; não tratar estimativas como lucro. Sem hash novo + recibo sucesso + diferença líquida do cofre, `lucroComprovado=false`.
- Canário ativo até **13:19:44 UTC de 28/10/2026**, máximo uma tentativa e teto total de gas de **0,00001 ETH** por transação e no dia. Esta autorização **expira e não se renova sozinha**. Não há garantia de captura de uma posição liquidável dentro da janela.
- **Operacional:** o deploy `95fe7aca` estava `Online/SUCCESS` e motores emitindo logs de scanning no momento da verificação; status Railway sozinho nunca representa lucro ou sucesso onchain.
