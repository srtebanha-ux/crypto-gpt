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
  `npm test` — 254 testes, todos sem acesso a rede).
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

1. `npm test` — 254 testes, todos sem rede, devem passar.
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
npm test            # suíte de testes (node:test) — 254 testes, sem rede
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
| `BNB_FEE_DISCOUNT` | `false` | `true` quando a conta tem "pagar taxas com BNB" ligado na Binance. Ver [Desconto de BNB](#desconto-de-bnb). |
| `MIN_BNB_BALANCE` | `0.001` | Saldo mínimo de BNB para considerar o desconto ativo; abaixo disso o motor usa a taxa cheia. |
| `MIN_VIABLE_CAPITAL_USD` | `10` | Piso de capital operável (MIN_NOTIONAL da Binance × 3 pernas). Abaixo disso o motor loga ERRO a cada heartbeat em vez de aparentar saúde. |
| `HEARTBEAT_INTERVAL_MIN` | `5` | Intervalo do log de heartbeat; `0` desativa. |

### Rodando as ferramentas dentro do container do Railway

O container é build de **produção**: `npm ci` roda sem as devDependencies, então
`ts-node` e `tsc` não existem lá. Um `npm run directional` no console do Railway
falha com `sh: 1: ts-node: not found` — e falharia igual para `sniff`,
`backtest` e `sniff-dex`.

Por isso cada ferramenta tem uma variante `:prod`, que roda o JavaScript já
compilado em `dist/`:

```bash
# No console do Railway (produção)
npm run directional:prod
npm run backtest:prod
npm run sniff-dex:prod

# Na sua máquina (com devDependencies instaladas)
npm run directional
```

As variantes sem sufixo continuam sendo as de desenvolvimento local. As
variáveis de ambiente são idênticas nos dois casos.

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

## Desconto de BNB

A barreira real da arbitragem triangular é a taxa: 0,1% por perna × 3 pernas =
**0,30%** de desalinhamento mínimo antes de qualquer lucro. Pagar as taxas em
BNB dá 25% de abatimento no Spot, derrubando a barreira para **0,225%** — a
única alavanca de custo que o operador controla sem mudar de estratégia.

Isso exige a flag `BNB_FEE_DISCOUNT=true` porque o endpoint
`/sapi/v1/asset/tradeFee` devolve a comissão **base** do símbolo e **não**
reflete o abatimento de BNB (a Binance o aplica só na execução). Sem a flag, o
motor calcularia com 0,1% enquanto a conta paga 0,075%, ficando 25% mais
conservador que a realidade e recusando ciclos que dariam lucro.

O desconto é condicionado ao saldo real de BNB, revalidado a cada heartbeat:

- Sem BNB (ou abaixo de `MIN_BNB_BALANCE`), a Binance cobra a taxa cheia no
  ativo negociado. Assumir o desconto nesse caso deixaria a matemática
  otimista e faria o motor aceitar ciclos marginais que perdem dinheiro.
- Se o BNB acabar no meio da operação, o heartbeat seguinte detecta e volta a
  taxa ao valor cheio.
- Se a consulta de saldo falhar, assume-se o pior caso (taxa cheia) — nunca o
  desconto.

Para ativar: compre BNB no Spot, ligue "pagar taxas com BNB" na Binance
(Configurações → Taxa de comissão) e defina `BNB_FEE_DISCOUNT=true`.

## Censo de oportunidades no heartbeat

"O robô não operou" é ambíguo, e a ambiguidade é cara: pode significar que o
mercado não ofereceu nada (estratégia sem espaço) ou que ofereceu e um gate
barrou (parâmetro mal calibrado). Sem medição, as duas situações produzem
exatamente o mesmo log — capital parado — e só dá para distinguir adivinhando.

Por isso cada heartbeat publica um censo da janela:

| Campo | Significado |
| --- | --- |
| `avaliacoesNaJanela` | Avaliações de triângulo feitas desde o heartbeat anterior. |
| `passaramNoGateEstatistico` | Quantas dessas passaram pelo kill switch #1. |
| `melhorMargemLiquida` | Melhor retorno líquido projetado da janela, já descontadas as três taxas, como % do capital. **Negativo é o normal** — significa que o desalinhamento não cobriu nem as taxas. |
| `melhorTriangulo` | Qual triângulo produziu esse melhor valor. |
| `margemNecessaria` | O que seria preciso para disparar (`MAX_SLIPPAGE`). |

Como ler:

- `melhorMargemLiquida` sempre bem negativa (ex. `-0.2500%`) → o mercado não
  chegou perto; afrouxar parâmetro não cria oportunidade, só faz operar no
  prejuízo.
- `melhorMargemLiquida` positiva mas abaixo de `margemNecessaria`, ou acima
  dela com `passaramNoGateEstatistico` em zero → havia oportunidade real e um
  gate barrou. **Aqui sim** faz sentido recalibrar.

O `expectedNetProfit` que alimenta essa métrica é calculado **antes** do gate
estatístico de propósito: medir só o que passou pelo gate daria uma amostra
enviesada, cega justamente para o segundo caso acima.

## Medindo o carry de funding rate (`fundingRateSniffer.ts`)

Ferramenta de **medição empírica** — não envia ordem nenhuma, e só usa
endpoints públicos (dispensa API key e conta de futuros).

O motivo de existir é o mesmo do `opportunitySniffer.ts`. Na arbitragem
triangular, um dia inteiro de argumento não resolveu o que dez minutos de
medição resolveram: o mercado oferecia ~0,124% de desalinhamento contra um
custo de execução de 0,225%, e nenhum ajuste de parâmetro mudaria essa
aritmética. Antes de construir um motor novo, mede-se.

A estratégia aqui é o **carry delta-neutro**: comprado no spot, vendido no
perpétuo, mesmo notional. O preço se move nos dois lados e se cancela; o que
sobra é o funding que os comprados pagam aos vendidos a cada 8 horas.

A diferença estrutural em relação à arbitragem triangular importa:

| | Triangular | Carry de funding |
| --- | --- | --- |
| Vantagem | Inexistente para nós — o desalinhamento não cobre a taxa | Real — funding é pago no relógio |
| Depende de vencer latência? | Sim, e perdemos por 50-100ms | Não |
| Escala com capital? | Irrelevante: o valor esperado é negativo | Sim, linearmente |

O relatório responde três perguntas, nesta ordem:

1. **Quanto os perpétuos pagam hoje** — funding atual e anualizado.
2. **Com que frequência o funding fica negativo** (`fracaoNegativa`) — quando
   fica, são os vendidos que pagam e a posição sangra. Esse número importa
   mais que a taxa atual: um funding alto que vira negativo 40% do tempo é
   pior que um modesto e estável.
3. **A partir de qual capital isso deixa de ser trocado por taxa** — a tabela
   final projeta lucro líquido anual e mensal para capitais de $20 a $10.000.

Duas escolhas deliberadas na matemática (`fundingRate.ts`):

- **Capital exigido é o dobro do notional de uma perna.** É preciso ter o
  ativo no spot *e* a margem no perpétuo simultaneamente. Ignorar isso é o
  erro clássico que faz uma projeção de carry parecer o dobro do que é.
- **A projeção usa a média histórica, não a taxa atual.** A taxa atual é um
  ponto isolado e costuma estar no pico justamente nos símbolos que lideram o
  ranking — projetar por ela seria sistematicamente otimista.

```bash
npm run sniff-funding
```

O retorno **percentual** é idêntico em todas as linhas da tabela: escalar
capital não cria vantagem, só torna a mesma vantagem grande o bastante para
importar. A linha onde o lucro mensal deixa de ser irrelevante é o capital
mínimo que justifica construir o motor de execução.

## Medindo arbitragem on-chain (`dexArbitrageSniffer.ts`)

Terceira ferramenta de **medição empírica** — não envia transação, não assina
nada, não precisa de chave privada. Só `eth_call`.

A pergunta que ela responde: vale escrever um contrato Solidity de flash loan?
Escrever o contrato é caro e arriscado (código financeiro que executa
atomicamente com valores emprestados); alguns `eth_call` custam nada.

### Por que flash loan muda a equação

Não é alavancagem no sentido de risco: o empréstimo nasce e morre na mesma
transação. Não há posição mantida, não há liquidação, e se o ciclo não fecha a
transação **reverte** — a perda máxima é o gas. Capital deixa de ser o gargalo
que travou as estratégias anteriores.

O que NÃO desaparece é a competição: on-chain a inclusão é **leiloada** (MEV).
Você não precisa ser mais rápido, precisa entregar mais lucro ao validador — e
no equilíbrio sobra pouco. Por isso o número que o sniffer mede é um **piso**:
se nem o lucro bruto aparece, não há o que disputar.

### A barreira é maior do que a intuição sugere

Pool Uniswap V2 cobra **0,3% por hop**. Um ciclo de 2 hops custa 0,6%; de 3
hops, 0,9% — contra os 0,225% da Binance com desconto de BNB. A taxa on-chain
é quase 3× maior, não menor.

O que compensa: faixas de taxa menores existem (0,05%/0,01%, pools de
stablecoin — ajuste `DEX_POOL_FEE`), o preço on-chain é genuinamente mais lento
que o de uma CEX, e o gas em L2 é barato.

### O tamanho do lote de RPC se adapta sozinho

Ler 200 pools são 600 chamadas `eth_call`. Fazer 600 requisições separadas
demoraria o suficiente para as primeiras leituras ficarem obsoletas antes das
últimas chegarem — e "arbitragem" entre dois instantes diferentes do mercado é
invenção, não medição. Por isso as chamadas vão em lote.

Cada provedor de RPC tem um limite próprio de chamadas por lote, e nenhum
anuncia esse limite: o RPC público da Base aceita 10, provedores pagos aceitam
centenas. Um número fixo no código quebrou na prática (`maximum 10 calls in 1
batch`, varredura abortada). O scanner agora começa em `DEX_RPC_BATCH_SIZE`
(padrão 10, seguro em endpoint público) e **reduz pela metade a cada recusa**,
mantendo o tamanho que funcionou para os lotes seguintes. Endpoint que recusa
até uma chamada única não faz lote nenhum, e aí o erro diz isso e manda trocar
de `DEX_RPC_URL`.

### Limite de taxa é ritmo, não tamanho — e pausa não é ritmo

Encolher o lote resolve "lote grande demais" e não resolve "chamadas demais por
segundo": são problemas diferentes com o mesmo sintoma de varredura abortada.

A primeira tentativa de resolver o segundo foi uma **pausa entre lotes**, com
padrão zero. Não funcionou, e o motivo é instrutivo: pausa entre lotes não é
taxa. Com lote de 100 e pausa de 200 ms, o pico continua sendo 100 chamadas de
uma vez. Na prática as 200 chamadas partiam na velocidade da rede e estouravam
o limite antes de qualquer espera entrar em ação — a Alchemy respondendo *"Your
app has exceeded its compute units per second capacity"* na primeira leva.

O scanner agora limita **chamadas por segundo** (`DEX_RPC_CALLS_PER_SEC`,
padrão 10) e paga o custo de cada lote em tempo **antes** de enviá-lo. O padrão
vem de uma restrição real: o tier gratuito da Alchemy dá ~330 unidades de
computação por segundo e um `eth_call` custa 26, ou seja ~12 chamadas por
segundo.

Ao ser recusado mesmo assim, o scanner corta a taxa pela metade, encolhe o lote
e espera (500 ms dobrando). Cortar a taxa é o que ataca a causa; aumentar a
pausa só adiaria o mesmo pico. Depois de 6 recusas ele para e nomeia as saídas.

Erro comum de contrato **não** é retentado: `eth_call` que reverte reverte
sempre, e retentar cada pool morto numa varredura de 200 multiplicaria o tempo
sem mudar nenhum resultado. A distinção é feita pelo texto do erro — heurística
assumida, com risco pequeno nos dois sentidos.

### A medição que fechou a cauda longa

Duas varreduras reais na Uniswap V2 da Base, factory com **3.050.359 pools**:

| Modo | Pools lidos | Válidos | Tokens distintos | Tokens em 2+ pools | Ciclos |
| --- | --- | --- | --- | --- | --- |
| `newest` | 200 | 100 | — | — | **0** |
| `random` | 400 | 387 | **389** | **0** | **0** |

387 pools e 389 tokens distintos, nenhum token repetido: é um **grafo estrela**
perfeito, cada token pareado só com WETH. Não existe triângulo porque não existe
grafo, e aumentar `DEX_SCAN_LIMIT` não ajuda — mais pools trazem mais tokens
únicos, não mais conexões.

Isso encerra a hipótese da cauda longa com número. "Ir onde ninguém está
olhando" era a premissa do modo `newest`; ninguém está olhando porque não há o
que olhar. De quebra, `newest` descartou 50% dos pools por reserva zerada contra
3,3% da amostra aleatória: os mais recentes são lançamentos ainda sem liquidez.

Sobra uma estrutura possível: **o mesmo par em duas DEXs**. E ela não é
encontrável por amostragem — sortear o mesmo par dos dois lados entre milhões
tem probabilidade praticamente zero. Por isso existe a busca dirigida:

```bash
DEX_TOKENS=0xTokenA,0xTokenB DEX_FACTORY=0xUmaDEX,0xOutraDEX npm run sniff-dex:prod
```

Uma chamada `getPair(token, WETH)` por (token, factory) encontra em segundos o
que a varredura nunca encontraria. O seletor de `getPair` é conferido em
execução — o endereço devolvido tem que se declarar criado por uma das
factories informadas, senão a medição para. Seletor errado não estoura sozinho:
devolveria lixo que decodifica como endereço, e o relatório mediria um contrato
que ninguém escolheu.

### Uma factory só quase nunca fecha ciclo

Não foi defeito — é topologia, e vale entender porque decide como usar a
ferramenta.

Dentro de uma única factory V2, cada par existe **uma vez**. Se todos os pools
carregados são `TOKEN/WETH`, não há segundo caminho de volta: o ciclo precisa de
um `TOKEN_A/TOKEN_B` para fechar o triângulo, ou do **mesmo par em outra DEX**
para fechar em dois pools. Os pools mais recentes de uma factory grande são
quase todos lançamentos pareados contra WETH, então `DEX_SCAN_MODE=newest` numa
factory só é justamente o pior caso.

Por isso `DEX_FACTORY` aceita **lista**: pools de duas DEXs no mesmo grafo é o
que produz arbitragem entre elas, que é a forma mais comum de arbitragem
on-chain.

```bash
DEX_FACTORY=0xFactoryDeUmaDEX,0xFactoryDeOutra npm run sniff-dex:prod
```

Quando não há ciclo, o relatório traz o censo da topologia — quantos tokens
distintos, quantos pools tocam o token base, quantos tokens aparecem em mais de
um pool — e diz qual dos três casos ocorreu. "Zero ciclos" sozinho não distingue
token base errado, escolha ruim de pools e topologia impossível, e a ação certa
é diferente em cada um.

### Nenhum endereço vem embutido no código

`DEX_POOLS` é obrigatório. Endereço errado **não estoura** — lê outro contrato
ou devolve vazio, e vira número plausível e errado no relatório. Cada pool é
verificado na leitura (`token0`/`token1`/`getReserves`, reservas dentro de
uint112, `decimals()` em faixa de ERC-20); o que não passar é reportado com o
motivo e descartado, nunca tratado em silêncio como pool vazio.

A factory informada em `DEX_FACTORY` também é verificada antes de ser usada:
`allPairsLength()` devolvendo 0 estoura, porque uma factory em uso nunca tem
zero pools — um endereço que não é factory devolveria `0x`, que decodifica
como zero, e o relatório diria "0 pools encontrados" mandando o operador
procurar o problema no mercado em vez de no endereço.

Pelo mesmo motivo, os seletores de função em `evmAbi.ts` são constantes
documentadas e toda leitura tem verificação de sanidade: o keccak-256 do
Ethereum difere do SHA3-256 do Node, então os seletores não podem ser
calculados em tempo de execução.

### Dois modos: lista explícita e varredura da cauda longa

```bash
# Modo contínuo — 24/7, acumulando observação. É este que responde a pergunta.
DEX_SEED_POOL=0x... DEX_WATCH_INTERVAL_SEC=60 npm run sniff-dex

# Leitura única
DEX_SEED_POOL=0x... npm run sniff-dex

# Varredura ampla com a factory já conhecida
DEX_FACTORY=0x... npm run sniff-dex

# Pools específicos que voce ja escolheu
DEX_POOLS=0xabc...,0xdef... npm run sniff-dex
```

O modo `DEX_FACTORY` existe por uma razão econômica: searchers profissionais
têm custo fixo alto de infraestrutura, então concentram atenção em
oportunidades grandes. Uma arbitragem de poucos dólares não paga a atenção
deles. A cauda longa — pools pequenos, tokens de baixa capitalização, pools
recém-criados — fica desguarnecida.

E com flash loan essa cauda é acessível de um jeito que capital próprio não
permitiria: o risco clássico ali é comprar um token ilíquido e ficar preso.
Com atomicidade isso não existe — se a venda não sai pelo preço necessário, a
transação inteira reverte e o custo é o gas.

Os **dois sentidos** de cada ciclo são avaliados. Não é redundância: vender no
pool caro e recomprar no barato dá lucro, e a operação inversa dá prejuízo —
são ciclos diferentes. Deduplicar por conjunto de pools (ignorando a ordem)
descartaria metade das oportunidades, e nada denunciaria a perda: o relatório
sairia "nenhum ciclo lucrativo" com a mesma cara de um mercado sem
oportunidade. Esse bug existiu e foi pego pelo teste de fiação em
`dexArbitrageSniffer.test.ts`, não pelos testes de unidade — que conferiam a
contagem de ciclos, não a lucratividade em cada sentido.

Ressalva honesta: boa parte da cauda longa é lixo, incluindo *honeypots*
(tokens que deixam comprar e não deixam vender). Com flash loan um honeypot
apenas reverte a transação, mas significa que parte das "oportunidades"
encontradas será falsa.

O padrão de varredura é `newest`: pools recém-criados, cujo preço ainda não
foi alinhado e que os indexadores podem não ter pego. `oldest` varre os
primeiros índices, majoritariamente pools mortos. `random` cobre o espaço de
forma não enviesada, com semente fixa — sem reprodutibilidade não daria para
saber se um resultado diferente entre duas rodadas veio do mercado ou do
sorteio.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `DEX_WATCH_INTERVAL_SEC` | `0` | Segundos entre varreduras. `0` = leitura única. Com valor > 0 roda indefinidamente, acumulando censo. |
| `DEX_SEED_POOL` | — | Um pool V2 qualquer; a factory é descoberta dele via `factory()`. É o caminho mais simples: endereço de pool aparece na interface de swap, endereço de factory se garimpa em documentação. |
| `DEX_FACTORY` | — | Factory V2 a enumerar, quando já se sabe. Verificada antes de ser usada (ver abaixo). |
| `DEX_POOLS` | — | Endereços de pools V2, separados por vírgula. Um dos dois é obrigatório. |
| `DEX_SCAN_LIMIT` | `200` | Quantos pools varrer da factory. |
| `DEX_SCAN_MODE` | `newest` | `newest`, `oldest` ou `random`. |
| `DEX_SCAN_SEED` | `1` | Semente do modo `random`, para varredura reprodutível. |
| `DEX_RPC_URL` | `https://mainnet.base.org` | RPC da rede. |
| `DEX_BASE_TOKEN` | WETH da Base | Token de partida e chegada do ciclo. |
| `DEX_POOL_FEE` | `0.003` | Taxa por hop. Baixe para medir faixas menores. |
| `FLASH_LOAN_FEE` | `0.0005` | Aave V3. Balancer é `0`. |
| `DEX_GAS_UNITS` | `450000` | Gas estimado da transação de arbitragem. |
| `DEX_MAX_RESERVE_FRACTION` | `0.1` | Teto de entrada como fração da menor reserva do ciclo. |

### Por que o modo contínuo importa mais que a leitura única

Uma varredura isolada com zero ciclos lucrativos **não distingue** "não há
oportunidade nesta DEX" de "não havia naquele instante". Só a série ao longo do
tempo separa as duas, e é ela que decide se vale escrever o contrato Solidity —
que é código financeiro executando atomicamente com valores emprestados, caro e
arriscado de errar.

Por isso o relatório de cada varredura carrega o **acumulado**:
`varredurasComOportunidade` (ex.: `3/847`), melhor líquido desde o início, e
horas observando. Um `0/500` depois de algumas horas é resposta; um `0/1` não é.

O laço é sequencial e não `setInterval`: com varredura mais lenta que o
intervalo, execuções concorrentes disputariam o mesmo RPC e as reservas de uma
se misturariam com as de outra — produzindo "arbitragem" entre dois instantes
distintos do mercado. Falha de RPC não derruba o monitor; ele existe para
acumular observação ao longo de horas.

Escopo: pools de **produto constante** (V2 e forks). Liquidez concentrada (V3)
exige percorrer ticks e é uma ordem de grandeza mais complexa — como isto é
medição, um piso conservador sobre V2 responde a pergunta, e se não houver
oportunidade nem aqui, V3 não salvaria.

## Estratégia direcional e backtest

Coisa diferente do resto do projeto. A arbitragem é delta-neutra: não ganha se
o ativo sobe nem perde se cai. Uma estratégia **direcional** compra esperando
alta — fica exposta ao preço, e pode dar prejuízo sem que nada tenha falhado
tecnicamente.

### "Correr mais risco" e "errar menos" são pedidos opostos

Mais risco é literalmente mais variância: mais operações que dão errado. O que
existe é a separação entre dois tipos de erro, e só um é eliminável:

- **Erro de execução** — posição grande demais, entrar sem stop, dobrar aposta
  perdendo, arredondar quantidade para cima e estourar o saldo. São bugs, e vão
  a zero. É disso que trata `positionSizing.ts`.
- **Risco de mercado** — comprou e o preço caiu. Irredutível: é o risco que se
  escolheu correr.

Uma estratégia direcional saudável erra 40-60% das vezes e ainda assim ganha,
porque as perdas são pequenas e limitadas e os ganhos correm. Perseguir "taxa
de acerto alta" leva ao caso oposto: acertar 90% com perdas 10x maiores que os
ganhos quebra a conta, e `expectancyPerTrade` existe para tornar isso explícito.

### Dimensionamento pela perda máxima (`positionSizing.ts`)

```
quantidade = (capital × risco_por_operação) / (entrada − stop)
```

O tamanho vem da **distância até o stop**, não do capital disponível. Isso
mantém a perda por operação constante entre ativos de volatilidade diferente, e
é o que permite errar várias vezes seguidas continuando vivo —
`consecutiveLossesSurvivable` mostra quantas: a 2% por operação são dezenas, a
10% são menos de dez.

Recusar-se a operar é resposta legítima e frequente, não exceção: stop do lado
errado, notional abaixo do mínimo da corretora, quantidade truncada a zero.
Todas devolvem quantidade zero **com motivo**, e a recusa aparece no relatório
como `recusadasPeloRisco` em vez de virar "nenhum sinal".

### O backtest não pode mentir a favor (`backtest.ts`)

Três decisões que impedem resultado bonito e irreproduzível ao vivo:

1. **Taxa em toda entrada e toda saída.** Foi ignorar taxa que fez a arbitragem
   triangular parecer viável no papel.
2. **Decisão na vela N, execução na abertura da N+1.** Decidir e executar no
   mesmo fechamento é *look-ahead*: ao vivo, quando o fechamento é conhecido,
   aquele preço já passou.
3. **Stop checado pela mínima da vela, não pelo fechamento.** Se o preço furou
   o stop no meio da vela, a posição acabou ali — mesmo que tenha fechado
   acima. O contrário esconde justamente as perdas.

### Três famílias opostas, decididas por dado

"Comprar na baixa e vender na alta" e "comprar o que está subindo" não são a
mesma coisa — são estratégias **opostas**, e qual funciona é pergunta empírica:

- **`breakout`** — compra quando o preço rompe a máxima de N períodos,
  esperando que o movimento continue. Compra na alta.
- **`reversion`** — compra quando o RSI mostra sobrevenda **e já virou para
  cima**, esperando retorno à média. É a tradução mecânica de "comprar na
  baixa".
- **`momentum`** — compra rompimento **com confirmação de volume** e sai num
  alvo fixo. Feita para moeda pequena que sobe explosivo e devolve tudo.

Duas decisões no sinal de reversão que mudam o resultado:

- **Exige que o RSI tenha virado**, não apenas que esteja baixo. Comprar com o
  RSI ainda caindo é apostar num fundo não confirmado.
- **O filtro de tendência importa MAIS aqui do que no rompimento.** Comprar
  queda dentro de uma tendência de baixa é comprar algo que cai porque continua
  caindo — a forma mais comum de perder dinheiro achando que se compra barato.

### `momentum`: a família das moedas que sobem rápido e caem rápido

As outras duas erram o formato desse movimento. `reversion` compra a queda — e
numa moeda que desabou depois do pico, "a queda" é o começo do fim, não uma
correção. `breakout` compra a força mas sai pelo stop móvel, que só reage
**depois** que o preço já virou e caiu a distância do trailing; numa alta que
devolve tudo em duas velas, essa distância é o lucro inteiro.

`momentum` muda as duas pontas:

**Entrada exige volume.** Numa moeda pequena o preço rompe a máxima dezenas de
vezes por dia sem nada acontecer — book fino se mexendo. O volume é o que
separa o rompimento que tem comprador do que é só ruído; sem esse filtro a
estratégia vira uma máquina de pagar taxa. O padrão exige **3× a média** de
volume das 20 velas anteriores, e a média **exclui a vela atual** — incluí-la
faria o próprio pico puxar a média e mascarar o que se quer detectar.

**Saída tem alvo.** `BT_TAKE_PROFIT_R=2` vende quando o ganho é o dobro do risco
aceito, sem esperar o stop móvel. Quando a mesma vela toca stop **e** alvo, vale
o **stop**: o OHLC não diz qual veio primeiro, e supor que foi o alvo é escolher
a versão que favorece o resultado — é assim que backtest vira ficção.

```bash
BT_SYMBOLS=SUAS,MOEDAS,AQUI BT_TAKE_PROFIT_R=2 BT_MIN_VOLUME_RATIO=3 npm run backtest:prod
```

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `BT_VOLUME_PERIOD` | `20` | Velas na média de volume. |
| `BT_MIN_VOLUME_RATIO` | `3` | Múltiplo da média exigido no rompimento. |
| `BT_TAKE_PROFIT_R` | `0` | Alvo em múltiplos do risco. `0` desliga. |

**A armadilha desta família, dita antes de você medir:** a lista de moedas que
você vai testar é feita de moedas que **sobreviveram**. As que foram a zero não
aparecem em lista nenhuma hoje, e é justamente nelas que essa estratégia perde.
Qualquer resultado bonito aqui carrega esse viés, e nenhum backtest o corrige —
só operar em papel para frente, onde a lista não pode ser escolhida depois.

O runner roda **as três famílias em vários ativos** sobre os mesmos dados e
compara. Nenhuma foi escolhida por argumento.

```bash
BT_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,ZECUSDT BT_INTERVAL=1h BT_CANDLES=2000 npm run backtest
```

O relatório traz, por ativo e por família: expectativa por operação,
consistência **entre as duas metades** do período, e comparação com **comprar e
segurar**. Depois agrega: em quantos ativos cada família teve expectativa
positiva. Uma família só merece produção se vencer na maioria, não num sortudo.

As três defesas contra autoengano: metades que discordam denunciam parâmetros
moldados ao passado; perder para comprar-e-segurar significa pagar taxa para
chegar a um lugar pior; e um único ativo lucrativo entre cinco é sorte, não
estratégia.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `BT_SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ZECUSDT` | Ativos a testar, separados por vírgula. |
| `BT_RSI_PERIOD` | `14` | Período do RSI (família `reversion`). |
| `BT_RSI_THRESHOLD` | `30` | Abaixo disso é sobrevendido. |
| `BT_INTERVAL` | `1h` | Tamanho da vela. |
| `BT_CANDLES` | `2000` | Quantas velas de histórico. |
| `BT_CAPITAL` | `20` | Capital inicial simulado. |
| `BT_RISK_FRACTION` | `0.02` | Fração do capital arriscada por operação. |
| `BT_BREAKOUT_LOOKBACK` | `20` | Velas olhadas para trás no rompimento. |
| `BT_ATR_STOP_MULT` | `2` | Stop = entrada − (mult × ATR). |
| `BT_TREND_PERIOD` | `50` | Média de tendência; `0` desliga o filtro. |
| `BT_TRAIL_ATR_MULT` | `3` | Stop móvel em ATR (Chandelier). Tem precedência sobre o percentual. |
| `BT_TRAIL_FRACTION` | `0` | Trailing por percentual fixo; alternativa ao ATR. |
| `BT_FEE_RATE` | `0.00075` | Taker com desconto de BNB. |

### Cada operação carrega o regime de mercado da entrada

O relatório separa as operações por **regime na entrada**: preço acima da média
de 200 é mercado de alta, abaixo é de baixa. Por ativo e no agregado.

Existe para responder "isso sobrevive a um bear market?" sem escolher uma janela
de baixa à mão — escolha que sempre carrega a suspeita de ter sido feita depois
de ver o resultado. Numa corrida longa os dois regimes aparecem e as operações
se separam sozinhas:

```bash
BT_CANDLES=40000 BT_INTERVAL=1h npm run backtest:prod
```

O que a separação revela: uma família **positiva só em alta** capturou o
mercado, não uma vantagem própria, e devolve tudo na primeira queda longa. Foi
exatamente esse o padrão do `breakout` numa janela de 52 dias de rally —
expectativa positiva em 5 de 5 ativos e derrota para comprar-e-segurar em 5 de
5. A linha de regime torna esse diagnóstico visível sem precisar de uma segunda
corrida.

Duas decisões que impedem o número de mentir a favor:

- **O regime é o da ENTRADA, não o da saída.** Marcar pela saída faria uma
  compra feita em plena queda contar como operação de alta só porque o mercado
  virou enquanto a posição estava aberta.
- **Antes de a média longa estar completa, o regime é "baixa".** Chamar o começo
  da série de alta colocaria as primeiras operações na coluna que se quer provar
  boa, sem base nenhuma.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `BT_REGIME_PERIOD` | `200` | Média que separa alta de baixa na classificação. |

### Ver a estratégia operar, não só o placar

O agregado responde "vale a pena?" e não responde "o que ele faz?". Quem ainda
não viu a estratégia operar não tem como confiar num número resumido — nem como
perceber que ela está comprando algo absurdo.

Por isso o relatório lista as últimas operações de cada ativo e família, com
data, preço de entrada e saída, variação, motivo da saída e resultado líquido.
Cada linha é conferível contra o gráfico à mão:

```
2026-08-14 09:00 → 2026-08-14 19:00 | 2.451000 → 2.702000 (10.24%) | alvo | $0.3812 | regime alta
```

`BT_SHOW_TRADES=0` desliga; o padrão são as 10 últimas.

### O funil: por que ZERO operações?

"Zero operações" tem três causas com ações **opostas**, e todas produzem o mesmo
relatório vazio:

```
funil: "4980 velas → 12 sinais → 9 barrados por tendência, 1 recusado por risco → 2 operações"
```

- **Zero sinais** → o parâmetro está restritivo demais para o mercado da janela.
  Mexer no limiar, não no filtro.
- **Sinais barrados por tendência** → a estratégia quer comprar queda dentro de
  tendência de baixa. O filtro barrando é o filtro funcionando.
- **Recusados por risco** → o capital é pequeno demais para o preço do ativo, e
  a posição não atinge o notional mínimo da corretora.

Sem o funil, os três casos levariam a mexer no parâmetro errado.

E quando o filtro barra **quase todos** os sinais, o relatório grita:

```
ALERTA: "CONFIGURAÇÃO SE AUTO-CANCELA: 6 de 6 sinais barrados pelo filtro de tendência."
```

Isso foi um defeito real, invisível por dias. Para o RSI cair abaixo de 30 é
preciso uma queda forte; uma queda forte joga o preço abaixo da própria média de
50; o filtro então rejeitava exatamente o que o sinal acabara de encontrar. As
duas condições eram quase mutuamente exclusivas, e o relatório mostrava "zero
operações" como se o mercado não tivesse oferecido nada — quando na verdade
tinha oferecido seis vezes.

Um filtro barrando **alguns** sinais é o filtro trabalhando. Barrando **quase
todos**, é conflito de configuração, e a diferença precisa aparecer sozinha.

A saída coerente é uma média de tendência **mais longa** que a correção que se
quer comprar: `BT_TREND_PERIOD=200` não se rompe numa queda de doze velas, e
preserva a intenção original do filtro — não comprar dentro de tendência de
baixa de verdade.

Backtest mede o passado. É o piso da decisão, não promessa de futuro.

## Motor direcional 24/7 (`directionalLive.ts`)

O backtest mede; este motor **opera**. Ele roda ininterruptamente sobre vários
ativos, comprando na baixa (`reversion`) ou no rompimento (`breakout`), com
stop e stop móvel em ATR.

```bash
# Papel — nenhuma ordem, nenhuma chave, nenhum risco. É o padrão.
DIRECTIONAL_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT npm run directional

# No console do Railway, use a variante compilada (lá não há ts-node):
DIRECTIONAL_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT npm run directional:prod
```

### Ele usa exatamente o mesmo código do backtest

`signals.ts` e `positionSizing.ts` são importados sem cópia nem variação. Isso
é deliberado: se o motor ao vivo decidisse por lógica própria — ainda que
"equivalente" —, o backtest não estaria medindo o que vai operar, e todo o
trabalho de validação viraria decoração. Qualquer melhoria de sinal entra num
lugar só e aparece nos dois.

Três equivalências que preservam essa propriedade ao vivo:

1. **A última vela da Binance é descartada.** Ela ainda está em formação: o
   "fechamento" vai mudar, e um sinal disparado sobre ele some no minuto
   seguinte. É o *look-ahead* na sua forma ao vivo.
2. **Stop checado pela mínima da vela**, como no backtest.
3. **Taxa cobrada nas duas pontas, inclusive no modo papel** (`tradeNetPnl`, a
   mesma função que o backtest usa). Sem isso o papel mostraria lucro em alta
   de 0,1% que ao vivo custa dinheiro — e o mérito seria de uma taxa não
   cobrada, não da estratégia. Ao vivo, a taxa vem da conta real (com desconto
   de BNB, se ativo), não de um palpite.

### Rodar as duas famílias ao mesmo tempo, em livros separados

`DIRECTIONAL_STRATEGY=both` roda `reversion` e `breakout` simultaneamente, cada
uma com **capital, posições e placar próprios**, metade do capital para cada.

Separar é o ponto. Num livro só, o resultado de uma esconderia o da outra e a
comparação — que é o motivo de rodar as duas — desapareceria. As velas são
buscadas uma vez por ativo e servidas às duas: buscar duas vezes dobraria as
chamadas para obter a mesma resposta e, pior, deixaria as famílias decidindo
sobre instantes diferentes.

Existe porque a medição pediu. Em 52 dias de alta, `reversion` fez **zero**
operações (nenhuma queda para comprar) e `breakout` teve expectativa positiva
em **5 de 5** ativos — mas perdeu para comprar-e-segurar em **5 de 5**
também, o que é assinatura de beta, não de vantagem. Em 14 meses de regime
misto, a ordem se inverte: `reversion` rende \$588 contra \$72 de `breakout`.

Nenhuma das duas leituras basta para escolher, e escolher pela mais recente é
justamente moldar a estratégia ao passado próximo. Rodar as duas em papel custa
zero e responde em algumas semanas com dado de mercado ao vivo, que não dá para
sobreajustar.

### O heartbeat diz por que NÃO entrou

Um motor direcional passa a maior parte do tempo sem operar, e zeros no
heartbeat são ambíguos: "o mercado não ofereceu sinal" e "o motor está
recusando tudo" produzem exatamente o mesmo log. Foi essa cegueira que deixou o
motor de arbitragem rodar um dia inteiro com capital zero parecendo saudável.

Por isso cada heartbeat traz o censo do ciclo — quantos sinais dispararam,
quantos o filtro de tendência barrou, quantos o risco recusou — e uma linha por
ativo com o motivo concreto:

```
porAtivo: "BTCUSDT: sem sinal (RSI 52.4, precisa < 45 e já subindo) |
           ETHUSDT: SINAL barrado pelo filtro de tendência (abaixo da média de 50) |
           SOLUSDT: SINAL recusado pelo risco: Notional 3.20 abaixo do mínimo da corretora (5.00) |
           BNBUSDT: em posição (stop 612.40)"
```

Cada um desses quatro estados pede uma ação diferente, e sem o censo os quatro
são indistinguíveis. O diagnóstico é da **última vela fechada**, não do
instante: com vela de 1h há uma avaliação por hora, e o heartbeat diz isso em
vez de deixar a leitura parecer mais fresca do que é.

### Teto por posição: o que faz o multi-ativo ser multi-ativo

Caixa livre impede alavancagem acidental, e não impede o oposto: a **primeira**
posição consumir o livro inteiro. Foi o que aconteceu na primeira operação real
do motor — XRP levou os $10 do livro e seis ativos com sinal válido foram
recusados por falta de caixa. Vinte ativos viraram uma carteira de um, escolhido
pela ordem da lista e não pela qualidade do sinal.

`DIRECTIONAL_MAX_POSITION_FRACTION` (padrão `0.34`) limita o notional de uma
posição a uma fração do **patrimônio** — não do caixa livre. Se fosse do caixa,
cada nova posição seria menor que a anterior e a última viraria poeira: a
carteira ficaria desbalanceada por construção.

Os dois tetos valem ao mesmo tempo e o menor manda: o orçamento de risco
continua decidindo quando o stop é largo, e o teto por posição decide quando o
stop é apertado.

O log de boot passa a dizer quantas posições simultâneas o capital comporta:

```
tetoPorPosicao: "34% do livro"   posicoesSimultaneasPossiveis: "0"
```

Se vier `0` ou `1`, a lista de ativos é grande demais para o capital — e a
diversificação é aparência. Com mínimo de $5 na corretora, cada posição
simultânea exige ~$15 de livro.

### Caixa livre: o motor multi-ativo não se alavanca sozinho

Cada posição é dimensionada contra o **caixa ainda livre**, não contra o
patrimônio total. Sem isso, quatro ativos dimensionando cada um contra os mesmos
20 dólares comprometem 80 — alavancagem que ninguém pediu, que aparece como
ordem recusada por saldo no melhor caso. O orçamento de risco por operação
continua saindo do patrimônio total: é ele que precisa ser constante para a
estratégia ser a mesma que o backtest mediu.

### Ordens reais exigem duas confirmações

```bash
DIRECTIONAL_LIVE=true DIRECTIONAL_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK npm run directional
```

Sem as duas, o motor roda em papel. Ao vivo ele registra o **preço realmente
executado**, não o pretendido: ordem a mercado escorrega, e mais nas saídas por
stop, que são as que mais importam.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `DIRECTIONAL_SYMBOLS` | `BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT` | Ativos acompanhados. |
| `DIRECTIONAL_STRATEGY` | `reversion` | `reversion` (comprar na baixa) ou `breakout`. |
| `DIRECTIONAL_INTERVAL` | `1h` | Tamanho da vela. |
| `DIRECTIONAL_CAPITAL` | `20` | Capital inicial. |
| `DIRECTIONAL_POLL_SEC` | `60` | Intervalo entre varreduras. |
| `DIRECTIONAL_LIVE` | `false` | `true` + confirmação para ordens reais. |

Os parâmetros de sinal e risco são os mesmos `BT_*` do backtest — e isso é
garantido por construção, não por disciplina: um resolvedor único
(`strategyParams.ts`) é lido pelos dois. Antes eram duas leituras separadas das
mesmas variáveis, e os padrões divergiram sozinhos: o motor entrava com
RSI < 45 enquanto a medição usava RSI < 30, e cobrava 0,1% de taxa onde a
medição usava 0,075%. Nada quebra nesse caso — o motor roda, o log parece
saudável, e o que opera simplesmente não é o que foi validado.

### Estado sobrevive a reinício — pré-requisito para dinheiro real

O motor guarda posições, capital e placar em memória, e o Railway reinicia o
container a cada deploy. Em papel isso custa a soma corrida. **Com dinheiro
real custa a única proteção contra perda ilimitada**: uma posição aberta na
corretora que o motor esqueceu que existe é uma posição sem ninguém
acompanhando o stop, e nenhum erro aparece — o log segue saudável enquanto o
preço cai.

O estado é gravado a cada ciclo em `DIRECTIONAL_STATE_FILE` (padrão
`./data/directional-state.json`) e recuperado no boot. A cada ciclo, não só
quando abre ou fecha posição: o stop móvel sobe dentro do ciclo, e perder essa
atualização reabriria a posição com stop mais frouxo do que o que estava
valendo.

A gravação é atômica (temporário + rename). Escrever direto no destino deixaria
JSON truncado se o processo morresse no meio — e o motor subiria sem as posições
que acabara de salvar, que é exatamente o cenário que a persistência existe para
evitar. Arquivo ausente ou corrompido devolve estado vazio em vez de impedir o
boot: subir sem posições é recuperável, não subir não é.

**No Railway, anexe um Volume** montado no diretório do arquivo. Sem volume, o
disco é do container e um deploy o descarta — a persistência protege contra
restart do processo, não contra troca de container.

### A corretora é a fonte da verdade, não o arquivo

O arquivo de estado protege contra reinício do processo. Ele **não** protege
contra o arquivo se perder (container novo sem volume), contra alguém vender
pela interface da Binance, nem contra uma ordem executada enquanto o motor
estava fora do ar. Nesses casos livro e realidade divergem — e a divergência
não gera erro nenhum: o motor simplesmente deixa de vigiar uma posição que
existe, ou vigia uma que não existe mais.

Por isso, no primeiro ciclo de cada ativo em modo `live`, o motor confere o
livro contra o **saldo real da conta**. Quatro casos, com ações opostas:

| Livro | Saldo real | Ação |
| --- | --- | --- |
| tem posição | tem saldo | nada |
| tem posição | sem saldo | **remove o fantasma** — vigiar um stop que não protege nada só bloqueia o caixa |
| sem posição | tem saldo | **ÓRFÃ**: posição real sem stop, sem ninguém olhando |
| sem posição | sem saldo | nada |

Poeira de arredondamento não conta como posição: o piso é o mesmo notional
mínimo que impede abrir uma. Sem ele, restos de venda virariam posição fantasma
nova a cada ciclo.

Órfã é o caso perigoso, e o padrão é **gritar, não agir**: o log sai como ERRO
dizendo o quanto está exposto e sem stop. Com `DIRECTIONAL_ADOPT_ORPHANS=true`
o motor adota a posição com stop em ATR a partir do preço atual — melhor que
deixá-la desprotegida, mas distorce o placar, porque o preço realmente pago é
desconhecido e o resultado passa a ser medido do zero. Proteger e medir puxam
para lados opostos aqui, então quem escolhe é quem opera.

Consequência prática: **o Volume do Railway deixa de ser obrigatório**. Sem ele
o placar acumulado zera a cada deploy, mas nenhuma posição fica órfã — a
corretora conta o que existe.

### Os botões de risco, e o que cada um custa

`BT_RISK_FRACTION` é a fração do capital arriscada por operação, e determina
quantas perdas seguidas o capital aguenta antes de cair à metade:

| Risco por operação | Perdas seguidas até perder metade |
| --- | --- |
| 2% (padrão) | 34 |
| 5% | 13 |
| 10% | 6 |
| 20% | 3 |

Sequências de 8 a 10 perdas seguidas acontecem em qualquer estratégia
direcional. A 10% por operação, uma sequência dessas custa metade da conta; a
20%, três perdas fazem o mesmo.

`BT_RSI_THRESHOLD` decide o que conta como "baixa". Mais alto = compra quedas
mais rasas = opera mais. Não é um botão de risco no sentido de tamanho: é uma
mudança de estratégia, e afasta o motor do que o backtest mediu (30).

`BT_TREND_PERIOD=0` desliga o filtro de tendência. Passa a comprar queda dentro
de tendência de baixa, que é a forma mais comum de perder dinheiro achando que
se compra barato.

### Alavancagem: a resposta está na medição, e ela é não

Alavancar multiplica o retorno **e o drawdown**. Os drawdowns máximos medidos
no próprio backtest desta estratégia, excluindo ZEC (que subiu 2093% na janela
e sozinha carregava o resultado):

| Ativo / família | Drawdown máximo |
| --- | --- |
| BNB `breakout` | 24,21% |
| BNB `reversion` | 30,57% |
| ETH `breakout` | 56,12% |

A 3× de alavancagem, uma queda de **33%** no patrimônio zera a conta. Dois dos
três números acima já passam disso — não em cenário pessimista inventado, mas
no histórico que a estratégia realmente atravessou. Alavancar aqui não amplia
lucro: liquida.

Alavancagem passa a ser discussão legítima quando existirem, medidos e não
argumentados: expectativa positiva na maioria dos ativos, consistência entre as
metades do período, e drawdown máximo **bem abaixo** de 1/alavancagem. Hoje a
estratégia tem 2 de 4 ativos positivos e consistentes. Isso é promissor, não
validado.

Flash loan é outra coisa e continua de pé: não há posição mantida, não há
liquidação, e a falha reverte a transação — o custo máximo é o gás. O que não
funciona é alavancagem de margem sobre uma direção que ainda não provou ter
vantagem.
