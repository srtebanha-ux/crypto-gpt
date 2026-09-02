# crypto-gpt

Painel de gráfico ao vivo (`painel.html`) + motor de arbitragem triangular
HFT delta-neutral, com dois modos de execução: demo contra um feed mock
(`src/index.ts`) e conector real de mercado/execução contra a Binance
(`src/live.ts`).

## Arquitetura

- `src/types.ts` — tipos e contrato `IExchangeProvider` compartilhados.
- `src/riskManager.ts` — kill switch de lucro (`RiskManager`).
- `src/engine.ts` — `TriangularArbitrageEngine`: avalia o book a cada tick,
  aplica o kill switch de obsolescência de dado e executa o ciclo de 3
  pernas quando viável.
- `src/mockExchangeProvider.ts` — feed sintético para demo/dev, sem rede.
- `src/binanceExchangeProvider.ts` — conector real: book em tempo real via
  WebSocket (`bookTicker`, combined stream) e execução de ordens via REST
  assinada (HMAC-SHA256).
- `src/index.ts` — bootstrap da demo (mock).
- `src/live.ts` — bootstrap real (Binance), com gate de segurança.

Todo cálculo financeiro usa `decimal.js` (nunca `Number`) para evitar perda
de precisão de ponto flutuante.

## Arbitragem Triangular

Explora ineficiências de preço síncronas entre 3 pares na mesma corretora
(ex. `USDT → BTC → ETH → USDT`).

Condição de disparo (kill switch de lucro):

```
P3 / (P1 * P2) * (1 - f)^3 > 1 + slippage_tolerância
```

Kill switch adicional por obsolescência de dado: ordens são ignoradas se
qualquer ticker envolvido tiver mais de 100ms de idade (timestamp
invalidation). Um guard (`isExecutingCycle`) impede sobreposição de ciclos.

### Rodar a demo (mock, sem rede/credenciais)

```bash
npm install
npm run dev        # roda direto via ts-node contra o feed mock
npm run build       # compila para dist/
npm start           # roda o build
npm run typecheck   # apenas checagem de tipos
```

## Conector real da Binance (`src/binanceExchangeProvider.ts`)

- **Book em tempo real**: assina `btcusdt@bookTicker`, `ethbtc@bookTicker` e
  `ethusdt@bookTicker` no combined stream (`wss://stream.binance.com:9443/stream?streams=...`,
  ou `wss://testnet.binance.vision/...` no testnet), com reconexão
  automática e backoff exponencial (até 30s) em caso de queda.
- **Execução**: ordens `MARKET`/`LIMIT` via `POST /api/v3/order`, assinadas
  com HMAC-SHA256 (`apiSecret`) e enviadas com `X-MBX-APIKEY`. A quantidade
  é arredondada para baixo conforme o filtro `LOT_SIZE` (`stepSize`) do
  símbolo, buscado uma vez no início via `/api/v3/exchangeInfo`, e ordens
  abaixo do `minQty` são rejeitadas antes de sair para a rede.
- **Timestamp**: o offset de relógio contra o servidor da Binance é
  sincronizado via `/api/v3/time` na conexão, evitando erros
  `-1021 INVALID_TIMESTAMP`.
- **Taxa taker**: buscada via `/sapi/v1/asset/tradeFee` (com fallback para
  0.1% se o endpoint não estiver disponível, como no testnet).

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

### Configuração

Copie `.env.example` e preencha suas credenciais (gere chaves de teste em
https://testnet.binance.vision antes de testar):

```bash
cp .env.example .env.local
# edite .env.local com BINANCE_API_KEY / BINANCE_API_SECRET
export $(grep -v '^#' .env.local | xargs)
npm run live
```

Variáveis (ver `.env.example`): `BINANCE_API_KEY`, `BINANCE_API_SECRET`
(obrigatórias), `CAPITAL_USD` (padrão `50.00`), `MAX_SLIPPAGE` (padrão
`0.0005`), `BINANCE_LIVE`, `BINANCE_LIVE_CONFIRM`.

> Nota: em ambientes com egress de rede restrito (ex. sandboxes de CI sem
> acesso à internet), a conexão com `testnet.binance.vision` /
> `stream.binance.com` será bloqueada pela política de rede do ambiente —
> isso não é um erro do conector, é a rede do ambiente impedindo a saída.
