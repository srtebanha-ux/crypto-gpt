# Cobertura e rotas Morpho

Esta atualização corrige os mecanismos de omissão apontados na revisão de `5d7c190`. Não estima receita perdida e não comprova lucro em produção.

1. Cada mercado retoma a paginação de devedores do último offset aceito. Cursor e endereços descobertos são gravados atomicamente no arquivo `<CACA_CACHE_MORPHO>.devedores.json`. No fim da lista o cursor volta a zero; falhas conservam a página não lida. A ordenação da API pode mudar durante a passagem: a cobertura é observada e parcial, não um snapshot integral garantido.
2. Posições próximas entram em sondas limitadas do `liquidar()` completo. O Morpho atualiza juros dentro dessa chamada antes de verificar saúde. São até quatro combinações para posições próximas, uma posição por ciclo quente ou até três por rodada lenta. Uma classificação de risco nunca substitui prova de execução, lucro mínimo, custos L1/L2 e revalidação.
3. V3 e Aero têm habilitação e pré-requisitos independentes. O diretor mantém mutex único e não tenta outra rota após hash, resultado desconhecido, confirmação ou aprovação simulada. Aero exige seus próprios `CACA_MORPHO_AERO_ENVIAR`, `CACA_MORPHO_AERO_CONFIRMAR=OPERAR_MORPHO_BASE` e `CACA_MORPHO_AERO_NONCE_EXCLUSIVO=1`; habilitar V3 não arma Aero. Os tetos econômicos continuam compartilhados pela política Morpho.
4. A descoberta percorre RPCs alternativos, exige chain 8453 e a superfície do Morpho canônico usado pelos executores. O bloco fica ancorado; o fallback só fornece leituras se chain e hash do mesmo bloco coincidirem. Candidatos de outro endereço não podem trocar silenciosamente a identidade do protocolo.
5. Páginas REST, ranking e páginas de devedores consomem o mesmo orçamento HTTP. Parte das requisições fica reservada para devedores. O prazo cancela o transporte real; validação RPC tem teto próprio de 240 operações e o mesmo prazo. O preflight também recebe o cancelamento. Isso não representa nem mede CU cobradas pelo provedor.
6. O governador Aave concede vagas por prioridade e reserva a vaga antes de acordar quem espera. A cada oito concessões prioritárias admite a solicitação mais antiga, permitindo avanço do histórico. Não atribui a esse governador a latência do worker Morpho.
7. Planner e contratos V3/Aero suportam até duas pernas por WETH ou USDC. Cada pool deve existir na fábrica imutável; intermediários devem estar permitidos no executor. A cotação de valor em WETH usa o caminho completo. O calldata integral de liquidação, swap e pagamento é simulado e revalidado com piso econômico. São no máximo 80 combinações por posição cruzada, quatro por próxima, quatro sondas simultâneas e 240 operações por preflight. Não há mistura de protocolos dentro da mesma rota nesta versão.

## Implantação dos contratos

Os novos contratos expõem `versaoRotas() == 2` e `liquidarRota()`. Contratos antigos continuam aceitando sua chamada direta original; o planner detecta a ausência da versão e informa `rota_nao_suportada` se não existir pool direta. Atualizar o código do Railway **não atualiza o bytecode já implantado**.

Para usar duas pernas na Base é necessário implantar os novos artefatos `TitanCacadorMorphoV3` e `TitanCacadorMorphoAero`, confirmar imutáveis/dono/cofre e configurar seus endereços. Os scripts existentes `implantarTitanMorphoV3.ts` e `implantarTitanMorphoAero.ts` usam os artefatos recompilados. Essa implantação gasta gás; não foi executada nesta alteração. A ativação financeira e a operação exclusiva da carteira continuam exigidas.

## Validação

A suíte dedicada cobre cursor após reinício, quarta página, orçamento, cancelamento, fallback com hash/chain diferentes, Aero sem V3, mutex, hash incerto e prioridade sem starvation. Os testes EVM locais cobrem accrual antes da saúde, posição ainda saudável, duas pernas sem pool direta, allowlist, rota/fábrica inválida, piso insuficiente, pagamento integral e preservação de saldos anteriores. São mocks locais; validar com ativos e liquidez atuais em fork antes da implantação financeira.
