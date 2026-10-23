# Megazord: integracao dos motores

Reune liquidacoes Aave/Morpho e arbitragem V2/multihop no mesmo processo.
O modo de execucao encaminha os cinco caminhos de envio a um coordenador com
uma carteira, fila, controle de nonce e orcamento compartilhados. As correcoes da descoberta Morpho foram publicadas no Railway em observacao.
Isto nao prova envio financeiro: a entrada unificada em modo execucao ainda
requer configuracao operacional, verificacao on-chain e provas de lucro.

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
- `MEGAZORD_CHAVE_PRIVADA`: chave da carteira EXISTENTE, apenas no gerenciador
  de segredos. Nunca inserir em GitHub, issue, console compartilhado ou logs.
  Tambem aceita a credencial ja cadastrada em `CACA_CHAVE_PRIVADA` ou
  `TITAN_CHAVE_PRIVADA`. Todas as credenciais fornecidas devem corresponder
  a mesma carteira. O formato hexadecimal com ou sem `0x` e normalizado
  internamente; entradas invalidas geram erro generico sem repetir o valor.
- `MEGAZORD_ENDERECO_PUBLICO` (ou `CACA_ENDERECO_PUBLICO`): endereço já
  autorizado; o executor deriva o endereço da chave e rejeita divergência.
- `MEGAZORD_RPC_URL` e `MEGAZORD_RPC_SECUNDARIO`: endpoints distintos da Base.
- `MEGAZORD_DIARIO`: caminho `/app/data/*.json` no volume Railway
  persistente do ÚNICO executor. Qualquer arquivo fora deste volume bloqueia
  inicialização; nunca zerar o diário para reabrir envio.
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
automatico. Um recibo de sucesso libera a pendencia na proxima reconciliacao.
Se o recibo for **revertido**, o diario registra a perda de gas e bloqueia novas
operacoes, inclusive apos reinicio, ate revisao operacional do motivo.
Status de recibo (mesmo status=1) nao comprova lucro liquido.

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

Antes de iniciar a entrada `APP_ENTRY=megazord` com
`MEGAZORD_MODO=execucao`, o processo exige automaticamente o mesmo preflight
read-only (`npm run megazord:preflight` pode ser executado separadamente).
Ele consulta os dois RPCs configurados, sem assinatura ou envio. Exige `MEGAZORD_ENDERECO_PUBLICO` (ou
`CACA_ENDERECO_PUBLICO`) e `MEGAZORD_CONTRATOS`. Confere Base, blocos recentes,
nonce livre e concordante, saldo positivo de gas e bytecode nos destinos.
Saldo positivo nao comprova suficiência para uma operacao; bytecode presente
nao autentica contrato. Os gates das estrategias continuam indispensaveis.

Em 2026-10-22, as tentativas deste ambiente para mainnet.base.org e
base-rpc.publicnode.com retornaram HTTP 403. A validacao contra a Base
permanece pendente; os testes EVM locais nao substituem essa verificacao.

## Lista operacional para transacao real

1. No Railway, confirmar o serviço com commit esperado e o volume em
   `/app/data`; a existência de um deploy Active nao comprova modo execução.
2. Conferir o endereço público da carteira EXISTENTE e substituir qualquer
   credencial anteriormente exposta. Nunca imprimir ou copiar a chave.
3. Desligar os outros processos capazes de assinar com a MESMA carteira;
   `MEGAZORD_EXCLUSIVO=1` é declaração do operador, não detector automático.
4. Confirmar bytecode e identidade do contrato Morpho V3 e Aero implantado,
   incluindo `versaoRotas()==2` quando uma rota multihop exigir esta versão.
   Código novo no Railway não implanta contrato novo na Base.
5. Executar `npm run megazord:preflight` no ambiente autorizado: rede Base
   8453, blocos atuais, nonce livre, saldo e destino com bytecode.
6. Fazer prova econômica em fork do estado mais recente, incluindo líquido após
   gás L1/L2, slippage, callback, repayment, limites por transação e carteira.
7. Só então habilitar o executor único e os gates específicos da rota.
   Nenhum sinal estimado autoriza envio sozinho; registrar hash, recibo,
   custo total e diferença de saldo de tokens para comprovar lucro realizado.

Sem acesso às variáveis ou console autorizados do Railway não se deve afirmar
que estas etapas foram executadas. Este documento não contém segredos.

## Preparacao antes de custos de implantacao

A entrada de execucao valida identidade, aliases e limites de gas antes de
preparar contratos. Em seguida confere rede/nonce/saldo em dois RPCs e o TWAP
publico, usando o contrato canonico Morpho apenas como testemunha de bytecode.
Esse endereco nao e adicionado a lista de destinos financeiros. Depois da
preparacao dos executores, repete o preflight sobre os destinos reais e
atualiza novamente o preco antes de habilitar qualquer estrategia.

O planejamento Morpho resolve ambos os marcadores/caches e valida todos os
executores existentes e tetos necessarios antes do primeiro deploy. Um teto
Aero invalido ou um executor existente incompativel nao deve consumir gas
implantando V3 primeiro. Falhas posteriores de rede ou mercado ainda podem
ocorrer; esta ordem nao garante sucesso nem lucro.

As consultas HTTP do preflight sao serializadas por endpoint, com espacamento
minimo e ate tres tentativas apenas para HTTP 429. O transporte respeita
`Retry-After` em segundos ou data; se o prazo excede cinco segundos, falha e
permite ao seletor tentar outro provedor, sem encurtar o prazo. A restricao
tambem vale para consultas ja enfileiradas. Nao ha repeticao automatica de
assinaturas ou broadcasts neste transporte, que aceita somente cinco metodos
de leitura usados pelo preflight. Blocos antigos e nonce pendente continuam
impedindo a aprovacao.
