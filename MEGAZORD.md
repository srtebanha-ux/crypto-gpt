# Megazord: estado da integracao

Esta branch reune os fontes dos dois motores e permite executar descoberta e
simulacao no mesmo processo. **O executor financeiro unico ainda nao existe.**
Nao implantar esta versao como substituta financeira dos servicos existentes.

## Executar o modo de observacao

1. Instalar dependencias com `npm ci` e compilar com `npm run build`.
2. Usar um ambiente isolado, sem nenhuma variavel terminada em `_ENVIAR=1`.
3. Manter as configuracoes RPC, mercados, contratos e autenticacao do painel
   necessarias aos motores. Nao copiar segredos para documentos ou logs.
4. Executar `MEGAZORD_MODO=observacao node dist/megazord.js`.

O painel existente pertence ao motor de arbitragem. A consolidacao dos estados
do liquidante no mesmo painel ainda precisa de integracao. Os limites RPC de
cada motor continuam independentes; nao afirmar que existe cota global.

## Pendencias para um executor unico

- Remover assinadores dos motores e transportar apenas candidatos tipados.
- Um unico processo deter a chave e o controle de nonce.
- Revalidar cada candidato no executor, incluindo contrato, lucro e gas L1/L2.
- Reservar hash e pior custo num diario duravel antes do broadcast.
- Reconciliar recibos e transacoes de resultado desconhecido apos reinicio.
- Testar concorrencia entre Aave, Morpho V3/Aerodrome e arbitragem V2/multihop.
- Confirmar desligamento dos assinadores antigos antes de qualquer ativacao.

Os nomes das estrategias nao tornam comparaveis valores em tokens distintos.
Todo ranking compartilhado precisa de conversao atual e comprovada para WETH,
incluindo custos e margem. Nenhuma cotacao estimada pode autorizar envio.

As correcoes Morpho dos PRs #88 e #89 sao independentes e nao foram incorporadas
automaticamente nesta branch de integracao.
