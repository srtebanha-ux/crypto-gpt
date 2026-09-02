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
- `src/engine.ts` — `TriangularArbitrageEngine`: avalia o book a cada tick,
  aplica as três camadas de kill switch, executa o ciclo de 3 pernas quando
  todas concordam e, se uma perna falhar no meio do caminho, dispara o
  unwind de emergência (ver abaixo).
- `src/mockExchangeProvider.ts` — feed sintético para demo/dev, sem rede.
- `src/binanceExchangeProvider.ts` — conector real: book em tempo real via
  WebSocket (`bookTicker` + `depth5`, combined stream) e execução de ordens
  via REST assinada (HMAC-SHA256).
- `src/logger.ts` — logger mínimo com timestamp ISO/nível, usado em toda a
  aplicação em vez de `console.log` solto.
- `src/index.ts` — bootstrap da demo (mock).
- `src/live.ts` — bootstrap real (Binance), com gate de segurança e
  heartbeat para operação 24/7.
- `src/*.test.ts` — testes de unidade (`node:test`, sem dependência extra;
  `npm test` — 38 testes, todos sem acesso a rede).
- `Dockerfile`, `railway.json` — deploy como worker de longa duração.

Todo cálculo financeiro usa `decimal.js` (nunca `Number`) para evitar perda
de precisão de ponto flutuante.

## Arbitragem Triangular

Explora ineficiências de preço síncronas entre 3 pares na mesma corretora
(ex. `USDT → BTC → ETH → USDT`).

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
   base recente do próprio par sintético, não um tick isolado ruidoso ou
   artefato de latência. Usa variância exponencial em uma passada (fórmula
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
   disponível em cada perna.

Kill switches adicionais:
- **Obsolescência de dado**: ordens são ignoradas se qualquer ticker
  envolvido tiver mais de 100ms de idade (timestamp invalidation).
- **Sanidade de preço**: qualquer preço não positivo (feed corrompido, book
  vazio) invalida o ciclo — sem isso, uma divisão por zero no `decimal.js`
  retornaria `Infinity` em vez de lançar, e o ciclo passaria como "viável"
  por um dado quebrado.
- Um guard (`isExecutingCycle`) impede sobreposição de ciclos.

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

### Rodar a demo (mock, sem rede/credenciais)

```bash
npm install
npm run dev        # roda direto via ts-node contra o feed mock
npm run build       # compila para dist/
npm start           # roda o build
npm run typecheck   # apenas checagem de tipos
npm test            # suíte de testes (node:test) — 38 testes, sem rede
```

## Conector real da Binance (`src/binanceExchangeProvider.ts`)

- **Book em tempo real**: assina `<symbol>@bookTicker` (topo do book) e
  `<symbol>@depth5@100ms` (5 níveis de profundidade, alimenta o kill switch
  #3) para os 3 pares, no mesmo combined stream
  (`wss://stream.binance.com:9443/stream?streams=...`, ou
  `wss://testnet.binance.vision/...` no testnet), com reconexão automática
  e backoff exponencial (até 30s) em caso de queda.
- **Execução**: ordens `MARKET`/`LIMIT` via `POST /api/v3/order`, assinadas
  com HMAC-SHA256 (`apiSecret`) e enviadas com `X-MBX-APIKEY`. A quantidade
  é arredondada para baixo conforme o filtro `LOT_SIZE` (`stepSize`) do
  símbolo, e ordens abaixo do `minQty` ou do `MIN_NOTIONAL` estimado são
  rejeitadas **antes** de sair para a rede.
- **Timestamp**: o offset de relógio contra o servidor da Binance é
  sincronizado via `/api/v3/time` na conexão, evitando erros
  `-1021 INVALID_TIMESTAMP`. As chamadas de setup usam retry com backoff —
  mas **nunca** `executeOrder`, que não pode ser reenviada às cegas (uma
  ordem MARKET pode já ter preenchido do lado da corretora mesmo com a
  resposta HTTP falhando).
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
| `STAT_MIN_SAMPLES` | `20` | Amostras mínimas de linha de base antes do kill switch #2 liberar disparo. |
| `STAT_Z_THRESHOLD` | `3` | Desvios-padrão exigidos do kill switch #2. |
| `RATIO_EWMA_ALPHA` | `0.05` | Memória do EWMA (`2/(N+1)` ≈ janela de N amostras). |
| `HEARTBEAT_INTERVAL_MIN` | `5` | Intervalo do log de heartbeat; `0` desativa. |

> **Nota sobre testes em ambientes de rede restrita** (ex. sandboxes de CI
> ou desenvolvimento sem egress liberado): a conexão com
> `testnet.binance.vision` / `stream.binance.com` será bloqueada pela
> política de rede do ambiente — isso não é um erro do conector. A lógica
> do conector (assinatura HMAC, arredondamento por `LOT_SIZE`, contabilidade
> de `netProceeds`, parsing de profundidade/resposta) é coberta por testes
> de unidade que não dependem de rede — ver `src/binanceExchangeProvider.test.ts`
> — mas a conectividade fim-a-fim só pode ser validada rodando `npm run live`
> (ou o deploy no Railway) a partir de um ambiente com acesso de rede à Binance.
