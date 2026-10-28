# Migração segura TITAN/MEGAZORD: Railway -> Render

## Status da preparação (2026-10-28)
- Fonte: `srtebanha-ux/crypto-gpt`, branch `feat/titan-cpamm-atomico-chat-20261027`.
- Imagem atual: `Dockerfile.railway`, compilação Node.js 22 + contratos; entrada `node dist/megazord.js`.
- Memória financeira Railway: volume `titan-memoria`, 100 MB provisionados, montado em `/app/data`.
- Nova Blueprint: `render.yaml`, **worker** `titan-megazord`, região Virginia, 1 instância, 2 GB RAM, disco persistente inicial de 1 GB em `/app/data`, auto-deploy **OFF**.
- Modo inicial Render: `MEGAZORD_MODO=observacao`, todas as flags de envio desarmadas; sem chaves privadas no repositório. O primeiro deploy não valida lucro nem habilita carteira.
- A conectividade Render e a transferência real de volume **ainda exigem acesso à conta Render**.
- O conector Railway com OAuth expõe **nomes**, mas não valores, das variáveis; não é possível copiá-las automaticamente deste acesso. Não cole segredos em chats, PRs, logs ou arquivos versionados.

## Ordem de execução (não inverter)
1. **Preparar no Render sem transações:** conectar a conta Render, importar a Blueprint e informar endpoints RPC por meio das variáveis privadas no painel Render. A criação do worker/disco causa cobrança conforme plano escolhido. NÃO copiar chaves privadas para o Render nesta fase. Validar build, logs, leitura da Base e estabilidade em modo `observacao`.
2. **Inventariar estado antes de desligar Railway:** obter uma exportação íntegra do volume `titan-memoria` via acesso autorizado ao volume/console Railway, contendo pelo menos:
   - Caminho EXATO do `MEGAZORD_DIARIO` (valor privado de runtime, com prefixo `/app/data/`), seu `.lock`, eventuais `.orphan-*` e `.contratos.json`.
   - `titanMorphoV3Deploy.json`, `titanMorphoAeroDeploy.json`, `titanMorphoV3Tx.json` se existirem e demais arquivos de `/app/data`.
   - Recibos e nonces pendentes, conferidos independentemente na Base (dois RPCs distintos). Não remover, recriar ou zerar o diário para contornar o lock.
   - Verificar serviços paralelos `renewed-sparkle`, `titan-implantacao-unica`, `railway-arbitrage-bot` e quaisquer outros com a mesma chave: a exclusividade não depende apenas do nome do processo principal.
3. **Janela de corte:** desarmar/parar TODOS os assinadores no Railway, aguardar conclusão/recibos pendentes, exportar o volume sem escrita concorrente e manter backup fora do Render. A carteira não pode ficar ativa em duas hospedagens.
4. **Restaurar estado:** importar os arquivos do snapshot para o disco do Render, mantendo caminho `/app/data` e as permissões apropriadas. Não iniciar envio se faltar diário, marcador confirmado, cofre ou contrato esperado. O Render Disk é acessível somente à instância em runtime; não está disponível na etapa de build/pre-deploy nem em job isolado.
5. **Preparar habilitação:** configurar, apenas no painel de ambiente Render, os valores originalmente auditados (sem aumentar tetos) para `MEGAZORD_DIARIO`, `MEGAZORD_RPC_URL`, `MEGAZORD_RPC_SECUNDARIO`, `CACA_...`, `ARB_...`, `TITAN_...` e chave privada. Confirmar consenso entre RPCs, endereço da mesma carteira, saldos, nonce, recibos, marcadores de contratos, gastos cumulativos e lock. Provedor RPC com respostas 429/408 precisará de ajuste de cota ou substituição, independentemente do host.
6. **Ligar produção somente após gates:** habilitar `MEGAZORD_MODO=execucao` e confirmações já auditadas, limites de gás existentes, `MEGAZORD_EXCLUSIVO=1` e, quando apropriado após prova de órfão, `MEGAZORD_RECUPERAR_LOCK_OBSOLETO=1`. Não habilitar duas carteiras assinadoras. Manter auto-deploy off enquanto houver risco financeiro.
7. **Aceite:** logs `[TITAN/LOCK-RECUPERACAO-CONTROLADA]` se aplicável, `Motores unidos no mesmo processo.`, blocos atuais, scanner Morpho + arbitragem rodando sem crash loops; assinar somente alvos com prova de lucro líquido e teto de gás. Lucro *realizado* só após receipt onchain bem-sucedido e reconciliação financeira.
8. **Migrar auxiliares:** o projeto Railway contém 7 serviços e 5 volumes; NÃO executar todos indiscriminadamente. Revisar propósito e chaves de `renewed-sparkle`, `aave-multichain-observer`, `titan-multihop-readonly`, `titan-implantacao-unica`, `invigorating-courtesy` e `railway-arbitrage-bot` antes de criar workers pagos ou duplicar assinadores. Desligar Railway gradualmente após validação.

## Restrições específicas
- `MEGAZORD_MODO=observacao` verifica que variáveis `*_ENVIAR` não estão em `1`. A configuração inicial lista explicitamente alguns desligamentos e **não** herda automaticamente as demais variáveis antigas.
- Render `Background Worker` executa 24/7; `disk.mountPath=/app/data` preserva dados e evita mais de uma instância compartilhando o mesmo disco.
- Usar `Dockerfile.railway` no Render **não** obriga continuar pagando Railway: é apenas o nome do Dockerfile versionado.
- Branch fixa no Blueprint; `autoDeployTrigger: off` exige iniciar builds/deploys conscientemente.
- Falha de RPC, ausência de alvo liquidável e limite de gás são questões separadas de hospedagem.

## Referências
- https://render.com/docs/migrate-from-railway
- https://render.com/docs/background-workers
- https://render.com/docs/disks
- https://render.com/docs/blueprint-spec
