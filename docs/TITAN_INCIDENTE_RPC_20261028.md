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
