# crypto-gpt

Painel de gráfico ao vivo (`painel.html`) + motor de arbitragem triangular
HFT delta-neutral, com dois modos de execução: demo contra um feed mock
(`src/index.ts`) e conector real de mercado/execução contra a Binance
(`src/live.ts`), pensado para rodar 24/7 (ver [Deploy 24/7 no Railway](#deploy-247-no-railway)).

## Arquitetura

- `src/types.ts` — tipos e contrato `IExchangeProvider` compartilhados.
- `src/riskManager.ts` — os kill switches de viabilidade (determinístico e
  por profundidade — ver abaixo).
- `src/statistics.ts` — `EwmaTracker`: média/variância móvel exponencial,
  base do kill switch estatístico.
- `src/marketMicrostructure.ts` — `estimateVwapFill`: caminha níveis reais
  do order book para estimar o preço médio de execução (VWAP), em vez de
  assumir preenchimento integral no topo do book.
- `src/triangleTopology.ts` — descoberta de topologia compartilhada: a
  partir da lista real de símbolos da Binance, constrói o grafo de
  triângulos `USDT → base → alt → USDT` cujos **três lados existem como par
  realmente listado** — em dois formatos (`buildTriangles`, símbolo cru, ex.
  `BTCUSDT`, usado por `opportunitySniffer.ts`; `buildEnginePairTriangles`,
  formato de par, ex. `BTC/USDT`, usado pelo engine/`BinanceExchangeProvider`),
  ambos sobre o mesmo núcleo de descoberta — nunca duas implementações
  divergentes do mesmo grafo.
- `src/engine.ts` — `TriangularArbitrageEngine`: recebe uma **lista** de
  triângulos (não um único par fixo) e, para cada tick, avalia só os
  triângulos afetados por aquele símbolo (índice `O(k)`), aplicando as três
  camadas de kill switch — cada triângulo com seu próprio `EwmaTracker`
  (linha de base nunca se mistura entre triângulos). Capital, circuit
  breaker e o mutex de execução são **globais**, compartilhados por todos os
  triângulos: nunca duas execuções em voo ao mesmo tempo, mesmo entre
  triângulos diferentes — é isso que preserva "zero alavancagem" ao
  monitorar vários ao mesmo tempo. Quando uma perna falha no meio do
  caminho, dispara o unwind de emergência (ver abaixo).
- `src/simulatedFill.ts` — `simulateNetFill`: contabilidade de taxa/netProceeds
  compartilhada pelos dois providers sintéticos (`MockExchangeProvider` e
  `SimulatedExchangeProvider`), pra não reimplementar a mesma fórmula duas
  vezes e arriscar divergirem numa mudança futura de modelo de taxa.
- `src/mockExchangeProvider.ts` — feed sintético para demo/dev, sem rede.
- `src/binanceExchangeProvider.ts` — conector real: descobre dinamicamente
  (via `triangleTopology.ts`) todos os triângulos operáveis, assina o book
  em tempo real via WebSocket (`bookTicker` + `depth5`, combined stream) de
  todos os símbolos envolvidos e executa ordens via REST assinada
  (HMAC-SHA256).
- `src/logger.ts` — logger mínimo com timestamp ISO/nível, usado em toda a
  aplicação em vez de `console.log` solto.
- `src/index.ts` — bootstrap da demo (mock).
- `src/live.ts` — bootstrap real (Binance), com gate de segurança e
  heartbeat para operação 24/7.
- `src/opportunitySniffer.ts` — ferramenta de **medição empírica** (não
  executa ordens): usa `triangleTopology.ts` para descobrir em tempo real
  todos os triângulos USDT→base→alt→USDT realmente listados na Binance e
  mede com que frequência e tamanho ineficiências líquidas de taxa aparecem
  de verdade — ver [Medindo a oportunidade real](#medindo-a-oportunidade-real-opportunitysnifferts).
- `src/prng.ts` — PRNG com seed (mulberry32) + amostrador gaussiano, usado
  pela simulação abaixo para ser reprodutível/testável.
- `src/monteCarloSimulation.ts` — **simulação de sensibilidade** (sem
  rede): reutiliza o `RiskManager` real contra preços sintéticos para
  explorar como a taxa de oportunidades varia com hipóteses de ruído de
  mercado — ver [Simulação de sensibilidade](#simulação-de-sensibilidade-montecarlosimulationts).
- `src/paperTradingSimulation.ts` — **paper trading** (sem rede): roda o
  `TriangularArbitrageEngine` real através de muitos ciclos em sequência
  contra um feed sintético — ver [Paper trading](#paper-trading-papertradingsimulationts).
- `src/*.test.ts` — testes de unidade (`node:test`, sem dependência extra;
  `npm test` — 89 testes, todos sem acesso a rede).
- `Dockerfile`, `railway.json` — deploy como worker de longa duração.

Todo cálculo financeiro usa `decimal.js` (nunca `Number`) para evitar perda
de precisão de ponto flutuante.

## Arbitragem Triangular

Explora ineficiências de preço síncronas entre 3 pares na mesma corretora
(ex. `USDT → BTC → ETH → USDT`). O engine roda uma **lista** de triângulos
assim ao mesmo tempo (não só um) — ver [Múltiplos triângulos](#múltiplos-triângulos-expansão-da-superfície-de-oportunidade)
abaixo.

### As três camadas de kill switch

Nenhum ciclo dispara sem que as três concordem — cada uma cobre um tipo de
erro diferente:

1. **Determinística** (`RiskManager.isTriangularArbitrageViable`) — o
   retorno líquido projetado no topo do book supera capital + slippage:
   ```
   P3 / (P1 · P2) · (1 - f)³ > 1 + slippage_tolerância
   ```
2. **Estatística** (`EwmaTracker` sobre R = P3/(P1·P2), em `engine.ts`) — a
   ineficiência observada precisa ser uma anomalia genuína frente à linha de
   base recente do **próprio triângulo** (cada triângulo tem seu próprio
   `EwmaTracker`, chaveado por `triangle.id` — a linha de base de um nunca
   se mistura com a de outro), não um tick isolado ruidoso ou artefato de
   latência. Usa variância exponencial em uma passada (fórmula
   numericamente estável, a mesma usada para volatilidade realizada de curto
   prazo):
   ```
   diff_t = x_t − mean_{t-1}          incr_t = α · diff_t
   mean_t = mean_{t-1} + incr_t       var_t  = (1 − α) · (var_{t-1} + diff_t · incr_t)
   z(x)   = (x − mean_t) / √var_t
   ```
   Só dispara quando `z(R) ≥ statZThreshold` **e** já houve `statMinSamples`
   amostras de linha de base (senão a variância ainda artificialmente baixa
   faria qualquer desvio parecer um outlier extremo). O z-score é sempre
   calculado **antes** de incorporar a amostra ao tracker — senão o próprio
   outlier diluiria seu significado.
3. **Profundidade** (`RiskManager.isTriangularArbitrageViableWithDepth`,
   opcional — só quando o provider expõe `getOrderBookSnapshot`, caso da
   Binance) — caminha os níveis reais de cada perna via `estimateVwapFill`
   (VWAP = Σ(price·qty)/Σ(qty) sobre os níveis consumidos) e recalcula o
   retorno sobre o preço médio de execução resultante, não o preço do topo
   do book. Bloqueia se a profundidade real não sustentar a quantidade-alvo
   **ou** se caminhar níveis piores custar mais do que o orçamento
   disponível em cada perna. O snapshot de profundidade tem seu próprio
   limite de idade (mesmo `maxTickAgeMs` do kill switch de obsolescência,
   aplicado ao stream `@depth5`, independente do `@bookTicker`) — pode
   desatualizar sozinho mesmo com o topo do book fresco. Quando esta camada
   participa da decisão, o engine usa `limitPriceLeg1/2/3` (o pior nível
   efetivamente caminhado, não o preço médio nem o topo do book) como preço
   da ordem `LIMIT`+FOK real — usar o preço médio ali preencheria menos
   profundidade do que a validada aqui, e usar o topo do book faria a FOK
   falhar exatamente quando esta camada mais importa (ver
   `marketMicrostructure.ts`/`riskManager.ts`).

Kill switches adicionais:
- **Obsolescência de dado**: ordens são ignoradas se qualquer ticker
  envolvido tiver mais de 100ms de idade (timestamp invalidation).
- **Sanidade de preço**: qualquer preço não positivo (feed corrompido, book
  vazio) invalida o ciclo — sem isso, uma divisão por zero no `decimal.js`
  retornaria `Infinity` em vez de lançar, e o ciclo passaria como "viável"
  por um dado quebrado.
- Um guard (`isExecutingCycle`) impede sobreposição de ciclos — **global**,
  compartilhado por todos os triângulos monitorados: nunca duas execuções em
  voo ao mesmo tempo, nem entre triângulos diferentes.

A demo/mock (`src/index.ts`) desativa a camada estatística
(`statMinSamples: 0`) de propósito: seu feed sintético repete sempre a
mesma distorção fixa, então nunca teria uma variância real para julgar algo
como anomalia — esse gate só faz sentido contra um feed de mercado genuíno.
A camada de profundidade já é pulada automaticamente na demo, porque o
`MockExchangeProvider` não implementa `getOrderBookSnapshot`.

### Contabilidade de taxa (`netProceeds`)

Cada leg de execução (`IExchangeProvider.executeOrder`) devolve
`netProceeds`: a quantidade **já líquida de taxa** do ativo que fica
disponível para a próxima perna (base asset para BUY, quote asset para
SELL) — é isso, e só isso, que o engine usa para dimensionar a ordem
seguinte. Isso importa porque a Binance cobra a comissão do ativo que você
*recebe*, não do que você pede: se o engine aplicasse um desconto de taxa
por fora só para *dimensionar* o pedido, o resultado seria "poeira" de
capital não utilizado a cada ciclo — uma fração de BTC/ETH que nunca é
convertida adiante.

### Unwind de emergência e parada permanente

Se a perna 2 ou 3 falhar depois que uma perna anterior já preencheu, o
engine não apenas loga o erro: ele envia uma ordem a mercado para vender de
volta o ativo residual (ETH ou BTC) por USDT, neutralizando a exposição
direcional aberta. Se esse próprio unwind falhar, o engine emite
`'critical-exposure'` e se **halta permanentemente** (`engine.isHalted()`
nunca mais volta a `false`): nenhum novo ciclo é iniciado, mas o processo
continua de pé.

Isso é proposital, e importa especialmente rodando 24/7 sob um
orquestrador com restart automático (Railway incluso): se `src/live.ts`
matasse o processo nesse ponto, a restart policy o relançaria e ele
voltaria a operar às cegas sobre uma posição que pode não ter sido
neutralizada. Em vez disso, o processo fica de pé (WS conectado, heartbeat
rodando) mas permanentemente parado de negociar, gritando no log até um
humano investigar a conta manualmente.

### Circuit breaker de perda máxima

Os três kill switches de disparo (determinístico, estatístico, profundidade)
só decidem **se um ciclo deve começar** — nenhum deles protege contra o
cenário onde a estratégia, na prática, perde dinheiro de forma sistemática
mesmo disparando só em ciclos que pareciam corretos no momento da decisão
(slippage real entre a decisão e a execução de 3 ordens sequenciais,
competição de bots mais rápidos e colocados, etc.). Depois de cada
atualização de capital (ciclo bem-sucedido ou unwind), o engine confere se
o capital caiu além de `maxDrawdownFraction` (padrão `0.10` = 10%) abaixo
do capital **inicial** — se caiu, halta permanentemente e emite
`'circuit-breaker-triggered'`, pelo mesmo motivo e do mesmo jeito que
`'critical-exposure'` (sem `process.exit()`, ver acima). Configurável via
`MAX_DRAWDOWN_FRACTION` em `src/live.ts`.

Isso limita o prejuízo máximo possível a um valor conhecido e configurado
de antemão — é a resposta direta para "não quero gastar dinheiro à toa sem
retorno": mesmo que a estratégia se revele ruim na prática, o dano para
antes de crescer.

### Checklist antes de operar com dinheiro real

1. `npm test` — 89 testes, todos sem rede, devem passar.
2. `npm run paper-trade` (ver [Paper trading](#paper-trading-papertradingsimulationts))
   por vários dias simulados — exercita o engine real através de MUITOS
   ciclos em sequência, não só um. Foi rodando essa simulação por vários
   dias simulados que se achou um bug real que nenhum teste de ciclo único
   pegava: o `RiskManager` fixava um teto de capital no valor inicial e
   travava silenciosamente para sempre depois do primeiro ciclo lucrativo
   (porque o capital do engine cresce, e o teto não). Já corrigido — mas é
   o tipo de bug que só aparece rodando de verdade, por tempo suficiente.
3. `npm run sniff` (ou `./scripts/extract-sniffer-metrics.sh`) por várias
   horas/dias contra a Binance real — sem isso, não há evidência de que
   existe alguma ineficiência líquida de taxa capturável nos pares
   escolhidos (ver [Medindo a oportunidade real](#medindo-a-oportunidade-real-opportunitysnifferts)).
4. `npm run live` (ou o deploy no Railway) contra o **Spot Testnet**
   (padrão — não precisa fazer nada extra) por um período — confirme nos
   logs que não há crash, `uncaughtException`/`unhandledRejection`, nem
   halts inesperados, e que `Conectado ao feed de book/profundidade da
   Binance.` aparece sem erros de reconexão constantes.
5. Só depois disso considere `BINANCE_LIVE=true` — comece com o menor
   `CAPITAL_USD` que fizer sentido, e configure `MAX_DRAWDOWN_FRACTION`
   deliberadamente (não confie só no padrão de 10% sem pensar se esse
   valor faz sentido para o seu capital).
6. Rodar 24/7 no Railway tem custo de infraestrutura independente do
   resultado do trading (o worker fica ligado o tempo todo) — confira o
   preço atual no próprio painel do Railway antes de fazer o deploy; este
   projeto não tem como consultar isso.

### Rodar a demo (mock, sem rede/credenciais)

```bash
npm install
npm run dev        # roda direto via ts-node contra o feed mock
npm run build       # compila para dist/
npm start           # roda o build
npm run typecheck   # apenas checagem de tipos
npm test            # suíte de testes (node:test) — 89 testes, sem rede
npm run simulate    # simulação de sensibilidade offline (ver seção própria)
```

## Múltiplos triângulos: expansão da superfície de oportunidade

O engine monitora e opera **vários triângulos reais ao mesmo tempo**, não
um único par fixo. Isso existe porque a alavanca legítima (sem alavancagem
financeira) para aumentar a taxa de ciclos capturáveis é ampliar quantas
ineficiências reais o robô consegue *ver*, não afrouxar nenhum kill switch.

Como funciona:
- `src/triangleTopology.ts` descobre, a partir do `exchangeInfo` real da
  Binance, todos os triângulos `USDT → base → alt → USDT` cujos três lados
  existem como par de fato listado — as bases intermediárias usadas são
  configuráveis (`TRIANGLE_BASES`, padrão `BTC,ETH,BNB,FDUSD`; mesmo padrão
  do `opportunitySniffer.ts`).
- `TriangularArbitrageEngine` recebe essa lista no construtor. A cada tick,
  só reavalia os triângulos realmente afetados pelo símbolo que chegou
  (índice `trianglesBySymbol`, `O(k)`) — nunca varre todos os triângulos a
  cada mensagem.
- Cada triângulo tem seu **próprio** `EwmaTracker` (chaveado por
  `triangle.id`): o warm-up estatístico de um nunca conta para o gate de
  outro (ver teste dedicado em `engine.test.ts`, que prova isso simulando o
  bug que aconteceria se os trackers fossem compartilhados).
- **Capital, circuit breaker e o mutex de execução (`isExecutingCycle`)
  continuam GLOBAIS** — compartilhados por todos os triângulos, nunca
  duplicados nem divididos entre eles. Na prática: mesmo monitorando dez
  triângulos, nunca há duas execuções em voo ao mesmo tempo, e o capital
  comprometido em qualquer instante é sempre o mesmo de um engine de
  triângulo único. É isso que preserva "zero alavancagem" ao ampliar a
  superfície de oportunidade — o ganho vem de *ver* mais chances reais, não
  de comprometer mais capital por vez.

Trade-off honesto: mais bases intermediárias = mais símbolos assinados via
WebSocket (uma única conexão combined-stream, limite documentado de 1024
streams — o padrão de 4 bases gera dezenas, não centenas) e mais chamadas
de avaliação por tick, mas o mutex global significa que a taxa de *ciclos
executados* não escala linearmente com o número de triângulos monitorados:
se dois dispararem "ao mesmo tempo", um sempre espera o outro terminar (ver
teste "mutex global impede execução simultânea" em `engine.test.ts`). O
ganho real é probabilístico — mais chances de pelo menos um triângulo estar
divergente a qualquer momento — não uma multiplicação direta da taxa de
oportunidades pelo número de triângulos.

## Conector real da Binance (`src/binanceExchangeProvider.ts`)

- **Descoberta dinâmica de triângulos**: na conexão, busca
  `/api/v3/exchangeInfo` completo e usa `buildEnginePairTriangles`
  (`triangleTopology.ts`) para descobrir todos os triângulos
  USDT→base→alt→USDT cujos três lados existem como par realmente listado e
  em `TRADING` — mesmo mecanismo do `opportunitySniffer.ts`, mas em formato
  de par (`BTC/USDT`) em vez de símbolo cru. As bases intermediárias usadas
  são configuráveis (`intermediateBases`/`TRIANGLE_BASES`, padrão
  `BTC,ETH,BNB,FDUSD`). Os triângulos descobertos ficam disponíveis via
  `getDiscoveredTriangles()`, usado por `src/live.ts` para construir o
  engine.
- **Book em tempo real**: assina `<symbol>@bookTicker` (topo do book) e
  `<symbol>@depth5@100ms` (5 níveis de profundidade, alimenta o kill switch
  #3) para **todos os símbolos únicos** envolvidos nos triângulos
  descobertos, no mesmo combined stream
  (`wss://stream.binance.com:9443/stream?streams=...`, ou
  `wss://stream.testnet.binance.vision/...` no testnet — a Binance separa
  REST e WebSocket em subdomínios diferentes tanto em produção quanto no
  testnet, nunca o mesmo host para os dois) — o wrapper `{stream,
  data}` do combined stream é necessário porque o payload cru de `@depth5`
  não inclui o símbolo, então é a única forma de saber a qual par cada
  mensagem pertence quando múltiplos símbolos são assinados na mesma
  conexão. Reconexão automática e backoff exponencial (até 30s) em caso de
  queda.
- **Execução**: as 3 pernas de ENTRADA do ciclo usam `LIMIT` com
  `timeInForce=FOK` (Fill-Or-Kill) no preço já confirmado pelas três camadas
  de kill switch — preenche a quantidade inteira nesse preço (ou melhor) ou
  cancela por completo, sem fill parcial. Isso protege contra o book ter se
  movido contra o esperado nos milissegundos entre a decisão e o envio: uma
  ordem `MARKET` aceitaria qualquer preço disponível naquele instante (sem
  nenhuma proteção), enquanto FOK simplesmente não preenche quando o preço
  piorou — falha limpa e sem exposição, tenta de novo no próximo tick. As
  pernas de UNWIND (ver abaixo) continuam deliberadamente `MARKET`: ali o
  objetivo é certeza de saída, não proteção de preço — um FOK que falha
  deixaria a exposição residual aberta por mais tempo, o oposto do que um
  unwind de emergência deve fazer. Ordens via `POST /api/v3/order`,
  assinadas com HMAC-SHA256 (`apiSecret`) e enviadas com `X-MBX-APIKEY`. A
  quantidade é arredondada para baixo conforme o filtro `LOT_SIZE`
  (`stepSize`) do símbolo, e ordens abaixo do `minQty` ou do `MIN_NOTIONAL`
  estimado são rejeitadas **antes** de sair para a rede.
- **Timestamp**: o offset de relógio contra o servidor da Binance é
  sincronizado via `/api/v3/time` na conexão, evitando erros
  `-1021 INVALID_TIMESTAMP`. As chamadas de setup usam retry com backoff —
  mas **nunca** `executeOrder`, que não pode ser reenviada às cegas (uma
  ordem pode já ter preenchido do lado da corretora mesmo com a resposta
  HTTP falhando).
- **Taxa taker**: buscada via `/sapi/v1/asset/tradeFee` (com fallback para
  0.1% se o endpoint não estiver disponível, como no testnet).
- **Saldo real**: `fetchAvailableBalance(asset)` consulta `/api/v3/account`;
  `src/live.ts` usa isso para nunca operar com mais do que o saldo livre
  real de USDT, mesmo que `CAPITAL_USD` esteja configurado mais alto.

### Segurança: testnet por padrão

O engine **nunca** envia ordens reais por acidente. Por padrão
(`BINANCE_LIVE` ausente ou diferente de `"true"`), tudo roda contra o
[Spot Testnet](https://testnet.binance.vision) da Binance — mesmo protocolo,
fills simulados, zero risco financeiro. Para operar com dinheiro real é
necessário setar **as duas** variáveis:

```bash
BINANCE_LIVE=true
BINANCE_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK
```

Faltando qualquer uma delas, `src/live.ts` recusa-se a iniciar.

Recomendações adicionais para a API key:
- Permissão apenas de **trade** — nunca habilite **withdrawal** (saque).
- Restrinja por **IP allowlist** no painel da Binance.
- Nunca commite `.env`/chaves no repositório (`.env` já está no `.gitignore`).

## Gerando uma chave de API no Spot Testnet

O testnet exige login pessoal (GitHub) — ninguém além de você consegue
gerar essa chave. Leva ~2 minutos:

1. Acesse **https://testnet.binance.vision** e clique em **Log In** (canto
   superior direito) — autentica via GitHub.
2. Depois de logado, clique em **Generate HMAC_SHA256 Key**.
3. Copie a **API Key** e a **Secret Key** exibidas na tela — a Secret só é
   mostrada uma vez.
4. (Opcional) Em **https://testnet.binance.vision/faucet** você pode pedir
   saldo fictício de USDT/BTC/ETH para a conta de teste, se o saldo inicial
   não for suficiente para os `$50` padrão do `CAPITAL_USD`.
5. Guarde as duas chaves para o passo de deploy abaixo (variáveis
   `BINANCE_API_KEY` / `BINANCE_API_SECRET`) — nunca as commite no repositório.

Rodando localmente em vez de no Railway:

```bash
cp .env.example .env.local
# edite .env.local com BINANCE_API_KEY / BINANCE_API_SECRET
export $(grep -v '^#' .env.local | xargs)
npm run live
```

## Deploy 24/7 no Railway

O repositório já inclui `Dockerfile` e `railway.json` configurados como um
**worker de longa duração** (sem porta HTTP, sem healthcheck — só um
processo Node persistente), com `restartPolicyType: ON_FAILURE` (reinicia
em caso de crash genuíno, até 5 tentativas; não reinicia sozinho após uma
parada de emergência intencional — ver acima).

Passo a passo (pelo dashboard, sem precisar instalar a CLI do Railway):

1. Acesse **https://railway.app**, faça login e clique em **New Project**.
2. Escolha **Deploy from GitHub repo** e selecione este repositório
   (`srtebanha-ux/crypto-gpt`) — autorize o acesso do Railway ao GitHub se
   for a primeira vez.
3. O Railway detecta o `Dockerfile` automaticamente e builda a imagem. Não
   é preciso configurar Build/Start Command — já vêm do `railway.json`.
4. Abra o serviço criado → aba **Variables** → adicione:
   - `BINANCE_API_KEY` — a API Key gerada no passo anterior.
   - `BINANCE_API_SECRET` — a Secret Key gerada no passo anterior.
   - `CAPITAL_USD` (opcional, padrão `50.00`).
   - `MAX_SLIPPAGE` (opcional, padrão `0.0005`).
   - **Não** defina `BINANCE_LIVE`/`BINANCE_LIVE_CONFIRM` ainda — assim o
     serviço sobe contra o Testnet primeiro. Só adicione as duas quando
     estiver pronto para operar com dinheiro real (ver seção de segurança
     acima) — `BINANCE_LIVE=true` e
     `BINANCE_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK`.
5. O Railway já reroda o deploy automaticamente ao salvar variáveis. Abra a
   aba **Deployments → View Logs** e confira o log de boot: deve aparecer
   `[SYS] APEX-ZERO ... booting em modo TESTNET` seguido de
   `Conectado ao feed de book/profundidade da Binance.`.
6. **Sem domínio público a configurar** — é um worker, não um serviço web;
   ignore a seção **Settings → Networking** do Railway.
7. Para acompanhar 24/7: os logs mostram um heartbeat a cada
   `HEARTBEAT_INTERVAL_MIN` minutos (padrão 5) com o capital atual e se o
   engine está `halted`. Se `halted: true` aparecer, é a parada de
   emergência — pare de reiniciar o deploy até investigar a conta na
   Binance manualmente (ver "Unwind de emergência e parada permanente" acima).

Variáveis de ambiente aceitas por `src/live.ts` (ver também `.env.example`):

| Variável | Padrão | Descrição |
|---|---|---|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | — (obrigatórias) | Credenciais da API. |
| `CAPITAL_USD` | `50.00` | Capital-alvo; sempre reduzido ao saldo livre real se este for menor. |
| `MAX_SLIPPAGE` | `0.0005` | Tolerância mínima de lucro líquido sobre o capital (kill switch #1). |
| `BINANCE_LIVE` | `false` | `true` = produção (dinheiro real); qualquer outro valor = testnet. |
| `BINANCE_LIVE_CONFIRM` | — | Deve ser exatamente `I_UNDERSTAND_THE_RISK` quando `BINANCE_LIVE=true`. |
| `TRIANGLE_BASES` | `BTC,ETH,BNB,FDUSD` | Bases intermediárias para a descoberta dinâmica de triângulos (ver [Múltiplos triângulos](#múltiplos-triângulos-expansão-da-superfície-de-oportunidade)). Mais bases = mais triângulos monitorados simultaneamente — capital/circuit breaker/mutex continuam globais. |
| `STAT_MIN_SAMPLES` | `20` | Amostras mínimas de linha de base antes do kill switch #2 liberar disparo. |
| `STAT_Z_THRESHOLD` | `3` | Desvios-padrão exigidos do kill switch #2. |
| `RATIO_EWMA_ALPHA` | `0.05` | Memória do EWMA (`2/(N+1)` ≈ janela de N amostras). |
| `MAX_DRAWDOWN_FRACTION` | `0.10` | Circuit breaker: para permanentemente se o capital cair essa fração abaixo do inicial. |
| `HEARTBEAT_INTERVAL_MIN` | `5` | Intervalo do log de heartbeat; `0` desativa. |

## Medindo a oportunidade real (`opportunitySniffer.ts`)

O motor de execução já descobre dinamicamente todos os triângulos operáveis
(ver [Múltiplos triângulos](#múltiplos-triângulos-expansão-da-superfície-de-oportunidade)
acima) — mas isso não torna esta ferramenta redundante, porque a pergunta
que ela responde é diferente e continua legítima e separada: **quantas
ineficiências líquidas de taxa realmente existem, com que frequência e de
que tamanho**, olhando para todos os triângulos de fato negociáveis na
Binance? `src/opportunitySniffer.ts` responde isso **medindo**, em vez de
assumir uma taxa e calcular quantos ciclos seriam necessários pra bater
uma meta — essa segunda abordagem é circular (assume a resposta que
deveria provar) e não diz nada sobre se as oportunidades existem de fato.
Por ser só leitura (nenhuma ordem, nenhum capital em risco), o sniffer pode
apontar para uma superfície de bases intermediárias bem mais ampla do que
você necessariamente habilitaria no engine real via `TRIANGLE_BASES` — é a
ferramenta certa para decidir *quais* bases valem a pena operar de verdade
antes de arriscar capital nelas.

O que ele faz:
1. Busca `/api/v3/exchangeInfo` (REST, público, sem credenciais) e
   constrói o grafo de triângulos `USDT → base → alt → USDT` cujos **três
   lados existem como par realmente listado** (`buildTriangles`, em
   `triangleTopology.ts` — o mesmo núcleo de descoberta usado pelo engine
   real via `buildEnginePairTriangles`; testado isoladamente em
   `triangleTopology.test.ts`, sem rede). Isso importa: `SOL → WIF → USDT`
   só é um triângulo arbitrável de verdade se
   `WIF/SOL` (ou `SOL/WIF`) existir como mercado — a maioria dos pares
   alt/alt não existe na Binance, só alt/USDT (e um subconjunto também
   contra BTC/ETH/BNB). Contar "combinações combinatorialmente possíveis"
   sem checar quais são realmente listadas superestima o número de
   triângulos operáveis.
2. Assina `@bookTicker` de cada símbolo envolvido via WebSocket (em lotes
   de 200 com espaçamento de 250ms entre lotes, para não estourar o
   rate limit de mensagens de controle da Binance) e mantém um índice
   símbolo → triângulos afetados, para reavaliar só os triângulos
   realmente impactados a cada tick (`O(k)`, não `O(N)` sobre todos os
   triângulos a cada mensagem).
3. A cada tick, recalcula `P3 / (P1·P2)` do(s) triângulo(s) afetado(s) e
   loga quando a ineficiência líquida de taxa (`(1-f)³`) supera o alvo
   configurado — descartando avaliações em que qualquer uma das 3 pernas
   está desatualizada há mais de `MAX_LEG_AGE_MS` (evita "oportunidades"
   fantasma formadas por comparar uma perna velha com pernas frescas).
4. A cada 10s, reporta ticks processados, oportunidades líquidas
   encontradas, o maior lucro líquido observado e uma extrapolação de
   oportunidades/hora.

**Não envia nenhuma ordem** — é só leitura de mercado e estatística, por
isso pode rodar com segurança mesmo sem `BINANCE_API_KEY`/`SECRET`.

### Rodar localmente

```bash
npm run sniff
# ou, pra já salvar o log com timestamp e um resumo ao final:
./scripts/extract-sniffer-metrics.sh
```

Variáveis opcionais: `SNIFFER_TAKER_FEE` (padrão `0.001`),
`SNIFFER_TARGET_NET_PROFIT` (padrão `0.0002` = 0,02% líquido — o mesmo
número usado na discussão sobre viabilidade da estratégia),
`SNIFFER_BASES` (padrão `BTC,ETH,BNB,FDUSD`).

### Rodar no Railway (coleta contínua, sem depender da sua máquina ligada)

Não é preciso um `Dockerfile`/`railway.json` separado — a imagem que já
builda `dist/live.js` (ver [Deploy 24/7 no Railway](#deploy-247-no-railway))
também builda `dist/opportunitySniffer.js`, porque ambos vêm do mesmo
`tsconfig.build.json`. Pra coletar dados sem mexer no serviço de trading:

1. No mesmo projeto Railway, **New → GitHub Repo** apontando pro mesmo
   repositório de novo (cria um segundo serviço, independente do serviço
   de trading).
2. Nesse novo serviço, aba **Settings → Deploy → Custom Start Command**,
   defina `node dist/opportunitySniffer.js` — isso sobrescreve o `CMD` do
   Dockerfile só para este serviço, sem tocar no `railway.json` nem no
   serviço de trading.
3. Não precisa de `BINANCE_API_KEY`/`SECRET` nesse serviço — o sniffer só
   lê mercado.
4. Acompanhe em **Deployments → View Logs**; o relatório periódico aparece
   a cada 10s.

### Como interpretar o resultado — e o que ele NÃO prova

O número de "oportunidades líquidas/hora" que essa ferramenta mede é um
**limite superior** do que é capturável, não uma promessa de lucro:
1. Ela não compete por latência com ninguém — só observa. Uma
   ineficiência real pode existir por poucos milissegundos e ser fechada
   por um bot colocado no mesmo datacenter da Binance antes que este
   sniffer (rodando num container comum, sem colocation) sequer receba o
   tick — e muito antes do motor de execução real conseguir montar e
   enviar 3 ordens sequenciais.
2. Pares de cauda longa (os que mais aumentam a contagem de triângulos)
   tendem a ser os mais ilíquidos — exatamente onde a suposição de
   "capital pequeno, zero impacto de mercado" é mais frágil, e onde o
   spread bid/ask sozinho já pode consumir a "ineficiência" observada.
3. Ele mede o **presente/futuro a partir de agora**, não um histórico —
   rode por horas/dias para ter uma amostra estatisticamente honesta
   antes de tirar qualquer conclusão sobre viabilidade.

## Simulação de sensibilidade (`monteCarloSimulation.ts`)

Roda sem rede — reutiliza o `RiskManager` real do projeto contra séries de
preço sintéticas (ruído de microestrutura + dislocamentos ocasionais) para
explorar **como a taxa de oportunidades varia conforme hipóteses de quão
"barulhento" é o mercado**. É um complemento ao `opportunitySniffer.ts`,
não um substituto: os parâmetros de ruído são suposições explícitas, não
dado real — só dizem "se o mercado se comportar assim, o resultado seria
assado", nunca "o mercado se comporta assim".

```bash
npm run simulate
```

Variáveis opcionais: `SIM_SEED` (padrão `42` — mesma seed sempre reproduz
os mesmos números), `SIM_TICKS` (padrão `500000`), `SIM_TICKS_PER_SECOND`
(padrão `5`), `SIM_START_CAPITAL` / `SIM_TARGET_MONTHLY` (padrão `5000` /
`20000` — para calcular a meta necessária de λ×lucro médio).

### A métrica que importa: λ × lucro médio, não só "oportunidades/hora"

Cada oportunidade tem seu próprio lucro líquido quando ocorre — duas
oportunidades por hora valendo 40 pontos-base cada valem tanto quanto oito
valendo 10 pontos-base. Por isso a comparação correta contra uma meta
mensal é:

```
λ (oportunidades/hora) × p̄ (lucro líquido médio, fração) ≥ meta/capital/720h
```

`requiredLambdaTimesP(capitalInicial, metaMensal)` calcula o lado direito.
Comparar só a contagem bruta de oportunidades contra uma taxa calibrada
para *outro* valor de lucro médio por oportunidade mistura unidades — foi
exatamente o erro que essa simulação já pegou uma vez nesta discussão (uma
comparação anterior, feita à mão, deu "8x abaixo da meta" quando a conta
correta dava "1,3x acima" — os testes em `monteCarloSimulation.test.ts`
existem para não deixar esse tipo de erro voltar).

## Paper trading (`paperTradingSimulation.ts`)

Diferente da simulação de sensibilidade acima (que só testa a matemática
do `RiskManager` isolada, tick a tick, sem estado entre eles), esta roda o
**engine real inteiro** — `TriangularArbitrageEngine` + `RiskManager`,
com os 3 kill switches de disparo, unwind de emergência e circuit breaker
de drawdown — através de **muitos ciclos em sequência**, contra um feed
sintético (mesmo modelo de ruído do `monteCarloSimulation.ts`). O
`SimulatedExchangeProvider` só modela os preços de **um** triângulo
sintético — o engine real suporta [múltiplos triângulos](#múltiplos-triângulos-expansão-da-superfície-de-oportunidade),
mas estender o feed sintético pra múltiplos ao mesmo tempo fica fora do
escopo desta ferramenta por ora.

Isso importa porque foi rodando essa simulação por 5 dias simulados que se
encontrou um bug real: o `RiskManager` fixava um teto de capital igual ao
capital inicial e, depois do primeiro ciclo lucrativo (que faz o capital
do engine crescer), passava a rejeitar **todo** ciclo seguinte
silenciosamente — para sempre. Rodando em produção, isso significava que
o robô faria exatamente UM trade lucrativo e nunca mais nenhum, sem
nenhum log de erro, halt ou aviso — pareceria só "sem oportunidades". Já
corrigido (ver `src/riskManager.ts`), com um teste de regressão dedicado
em `paperTradingSimulation.test.ts`. Nenhum teste de ciclo único
(inclusive todos os outros deste projeto até então) exercitava esse
caminho — só uma simulação de vários ciclos em sequência.

```bash
npm run paper-trade
```

Variáveis opcionais: `PAPER_CAPITAL_BRL` (padrão `300`), `PAPER_BRL_PER_USD`
(padrão `5.5` — **suposição de câmbio, não cotação ao vivo**; confira a
cotação real antes de tirar conclusões), `PAPER_DAYS` (padrão `1`),
`PAPER_SEED`, `PAPER_NOISE_BPS` / `PAPER_JUMP_PROBABILITY` /
`PAPER_JUMP_MEAN_BPS` (cenário de ruído — padrão é o "fronteira" do
`monteCarloSimulation.ts`).

Mesma ressalva de sempre: o cenário de ruído é uma suposição hipotética
("e se desse certo"), não uma medição real — o resultado mostra **como o
engine se comportaria** sob essa hipótese, não uma previsão de retorno.

> **Nota sobre testes em ambientes de rede restrita** (ex. sandboxes de CI
> ou desenvolvimento sem egress liberado): a conexão com
> `testnet.binance.vision` / `stream.binance.com` / `api.binance.com` será
> bloqueada pela política de rede do ambiente (confirmado neste repo: até
> a REST pública e não-autenticada `api.binance.com/api/v3/exchangeInfo`
> retorna `403 connect_rejected` do proxy) — isso não é um erro do
> conector nem do `opportunitySniffer`. A lógica de ambos (assinatura
> HMAC, arredondamento por `LOT_SIZE`, contabilidade de `netProceeds`,
> descoberta dinâmica de triângulos, avaliação de ineficiência) é coberta
> por testes de unidade que não dependem de rede — ver
> `src/binanceExchangeProvider.test.ts`, `src/triangleTopology.test.ts` e
> `src/opportunitySniffer.test.ts` — mas a conectividade fim-a-fim só
> pode ser validada rodando `npm run live` / `npm run sniff` (ou o deploy
> no Railway) a partir de um ambiente com acesso de rede à Binance.
