# Megazord: integracao dos motores

Reune liquidacoes Aave/Morpho e arbitragem V2/multihop no mesmo processo.
O modo de execucao encaminha os cinco caminhos de envio a um coordenador com
uma carteira, fila, controle de nonce e orcamento compartilhados. Esta branch
nao foi implantada nem validada com transacoes reais.

## Observacao

Instalar com `npm ci`, compilar com `npm run build` e executar
`MEGAZORD_MODO=observacao node dist/megazord.js` em ambiente isolado, sem
variaveis terminadas em `_ENVIAR=1`. Manter as configuracoes de RPC, mercados,
contratos e autenticacao exigidas pelos motores. Nao registrar segredos.

## Configuracao do executor

A entrada e `node dist/megazord.js`. Execucao exige todas estas variaveis:

- `MEGAZORD_MODO=execucao` e `MEGAZORD_CONFIRMAR=OPERAR_BASE_REAL`.
- `MEGAZORD_EXCLUSIVO=1`: declaracao operacional de que os outros assinadores
  da mesma carteira foram desligados; o programa nao verifica outros servicos.
- `MEGAZORD_CHAVE_PRIVADA`: unica chave, fornecida pelo gerenciador de segredos.
  Aliases CACA/TITAN existentes devem corresponder a mesma carteira.
- `MEGAZORD_RPC_URL` e `MEGAZORD_RPC_SECUNDARIO`: endpoints distintos da Base.
- `MEGAZORD_DIARIO`: caminho absoluto em volume persistente compartilhado pelo
  unico executor. Nao usar armazenamento efemero de deploy.
- `MEGAZORD_GAS_MAX_DIA_WEI`, `MEGAZORD_GAS_MAX_TX_WEI` e
  `MEGAZORD_MAX_TX_DIA`: limites positivos explicitos, sem valores padrao.
- `MEGAZORD_CONTRATOS`: enderecos de destino autorizados separados por virgula.

As flags e os controles economicos de cada estrategia continuam necessarios.
Habilitar este modo nao cria oportunidades nem garante lucro. O reinvestimento
Snowball deve permanecer desligado, pois seu envio ainda nao foi migrado.

## Garantias e recuperacao

A fila serializa as estrategias. Antes de transmitir, o coordenador confere
rede 8453, blocos recentes, concordancia de nonce em dois RPCs, destino,
transacao EIP-1559 sem valor nativo e simulacao final. Reserva o hash e o pior
custo estimado (gas L2 mais duas vezes a estimativa superior de L1) no diario
antes do broadcast. As reservas nunca sao devolvidas ao orcamento diario.

Timeout ou recibo desconhecido bloqueia novos envios; nao ocorre reenvio
automatico. Um recibo de sucesso ou revert libera a pendencia na proxima
reconciliacao. Status de recibo nao comprova lucro.

O arquivo `.lock` impede outro coordenador usando o mesmo caminho. Apos crash,
um operador precisa confirmar que o processo anterior terminou e remover
somente um lock comprovadamente obsoleto. Nunca apagar o diario para liberar
a fila: a pendencia persistida precisa ser reconciliada. Locks locais nao
impedem outro host usando outro volume, nem scripts externos com a mesma chave.

## Limites desta entrega

O painel ainda pertence a arbitragem; estados do liquidante nao foram
consolidados. Cotas RPC continuam independentes. Nao existe ranking financeiro
comum entre tokens. Os PRs Morpho #88 e #89 nao foram incorporados automaticamente.
Os testes do coordenador usam rede simulada e assinaturas reais de chave de
teste, sem fundos. Validacao em rede e implantacao permanecem pendentes.

## Teste EVM local reproduzivel

Executar `npm run megazord:test-local`. A configuracao isolada nao usa fork,
RPC publico ou carteira de producao. O teste transmite e minera tres
transacoes assinadas para um contrato minimo: duas estrategias concorrentes
e o adaptador de carteira usado pelo Aave. Confere nonces 0/1/2, estado do
contrato, recibos e diario. O custo L1 e simulado. Este teste valida o
transporte e a coordenacao, nao a economia nem os contratos dos protocolos.

## Preflight publico antes da implantacao

No Railway, `APP_ENTRY=megazord` seleciona a entrada combinada no Dockerfile
existente. O default `live` inicia outro motor; nao altera-lo globalmente.

Apos o build, `npm run megazord:preflight` consulta os dois RPCs configurados,
sem assinatura ou envio. Exige `MEGAZORD_ENDERECO_PUBLICO` (ou
`CACA_ENDERECO_PUBLICO`) e `MEGAZORD_CONTRATOS`. Confere Base, blocos recentes,
nonce livre e concordante, saldo positivo de gas e bytecode nos destinos.
Saldo positivo nao comprova suficiência para uma operacao; bytecode presente
nao autentica contrato. Os gates das estrategias continuam indispensaveis.

Em 2026-10-22, as tentativas deste ambiente para mainnet.base.org e
base-rpc.publicnode.com retornaram HTTP 403. A validacao contra a Base
permanece pendente; os testes EVM locais nao substituem essa verificacao.
