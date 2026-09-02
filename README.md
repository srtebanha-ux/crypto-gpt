# crypto-gpt

Painel de gráfico ao vivo (`painel.html`) + motor de arbitragem triangular
HFT delta-neutral, com dois modos de execução: demo contra um feed mock
(`src/index.ts`) e conector real de mercado/execução contra a Binance
(`src/live.ts`).

## Arquitetura

- `src/types.ts` — tipos e contrato `IExchangeProvider` compartilhados.
- `src/riskManager.ts` — kill switch de lucro (`RiskManager`).
- `src/engine.ts` — `TriangularArbitrageEngine`: avalia o book a cada tick,
  aplica o kill switch de obsolescência de dado, executa o ciclo de 3
  pernas quando viável e, se uma perna falhar no meio do caminho, dispara o
  unwind de emergência (ver abaixo).
- `src/mockExchangeProvider.ts` — feed sintético para demo/dev, sem rede.
- `src/binanceExchangeProvider.ts` — conector real: book em tempo real via
  WebSocket (`bookTicker`, combined stream) e execução de ordens via REST
  assinada (HMAC-SHA256).
- `src/logger.ts` — logger mínimo com timestamp ISO/nível, usado em toda a
  aplicação em vez de `console.log` solto.
- `src/index.ts` — bootstrap da demo (mock).
- `src/live.ts` — bootstrap real (Binance), com gate de segurança.
- `src/*.test.ts` — testes de unidade (`node:test`, sem dependência extra).

Todo cálculo financeiro usa `decimal.js` (nunca `Number`) para evitar perda
de precisão de ponto flutuante.

## Arbitragem Triangular

Explora ineficiências de preço síncronas entre 3 pares na mesma corretora
(ex. `USDT → BTC → ETH → USDT`).

Condição de disparo (kill switch de lucro):

```
P3 / (P1 * P2) * (1 - f)^3 > 1 + slippage_tolerância
```

Kill switches adicionais:
- **Obsolescência de dado**: ordens são ignoradas se qualquer ticker
  envolvido tiver mais de 100ms de idade (timestamp invalidation).
- **Sanidade de preço**: qualquer preço não positivo (feed corrompido, book
  vazio) invalida o ciclo — sem isso, uma divisão por zero no `decimal.js`
  retornaria `Infinity` em vez de lançar, e o ciclo passaria como "viável"
  por um dado quebrado.
- Um guard (`isExecutingCycle`) impede sobreposição de ciclos.

### Contabilidade de taxa (`netProceeds`)

Cada leg de execução (`IExchangeProvider.executeOrder`) devolve
`netProceeds`: a quantidade **já líquida de taxa** do ativo que fica
disponível para a próxima perna (base asset para BUY, quote asset para
SELL) — é isso, e só isso, que o engine usa para dimensionar a ordem
seguinte. Isso importa porque a Binance cobra a comissão do ativo que você
*recebe*, não do que você pede: se o engine aplicasse um desconto de taxa
por fora (como uma versão anterior deste código fazia) só para *dimensionar*
o pedido, o resultado seria "poeira" de capital não utilizado a cada ciclo —
uma fração de BTC/ETH que nunca é convertida adiante, drenando capital
silenciosamente do book de forma não contabilizada.

### Unwind de emergência

Se a perna 2 ou 3 falhar depois que uma perna anterior já preencheu, o
engine não apenas loga o erro: ele envia uma ordem a mercado para vender de
volta o ativo residual (ETH ou BTC) por USDT, neutralizando a exposição
direcional aberta. Se esse próprio unwind falhar, o engine emite
`'critical-exposure'` — em `src/live.ts` isso interrompe o processo
imediatamente (fechando a conexão), porque com posição direcional aberta e
não neutralizada, continuar operando às cegas é o pior curso de ação.

### Rodar a demo (mock, sem rede/credenciais)

```bash
npm install
npm run dev        # roda direto via ts-node contra o feed mock
npm run build       # compila para dist/
npm start           # roda o build
npm run typecheck   # apenas checagem de tipos
npm test            # suíte de testes (node:test)
```

## Conector real da Binance (`src/binanceExchangeProvider.ts`)

- **Book em tempo real**: assina `btcusdt@bookTicker`, `ethbtc@bookTicker` e
  `ethusdt@bookTicker` no combined stream (`wss://stream.binance.com:9443/stream?streams=...`,
  ou `wss://testnet.binance.vision/...` no testnet), com reconexão
  automática e backoff exponencial (até 30s) em caso de queda.
- **Execução**: ordens `MARKET`/`LIMIT` via `POST /api/v3/order`, assinadas
  com HMAC-SHA256 (`apiSecret`) e enviadas com `X-MBX-APIKEY`. A quantidade
  é arredondada para baixo conforme o filtro `LOT_SIZE` (`stepSize`) do
  símbolo, e ordens abaixo do `minQty` ou do `MIN_NOTIONAL` estimado são
  rejeitadas **antes** de sair para a rede (economiza um round-trip que a
  Binance rejeitaria de qualquer forma).
- **Timestamp**: o offset de relógio contra o servidor da Binance é
  sincronizado via `/api/v3/time` na conexão, evitando erros
  `-1021 INVALID_TIMESTAMP`. As chamadas de setup (`/api/v3/time`,
  `/api/v3/exchangeInfo`) usam retry com backoff — mas **nunca**
  `executeOrder`, que não pode ser reenviada às cegas (uma ordem MARKET pode
  já ter preenchido do lado da corretora mesmo com a resposta HTTP falhando).
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

> **Nota sobre testes em ambientes de rede restrita** (ex. sandboxes de CI
> ou desenvolvimento sem egress liberado): a conexão com
> `testnet.binance.vision` / `stream.binance.com` será bloqueada pela
> política de rede do ambiente — isso não é um erro do conector, é a rede do
> ambiente impedindo a saída. A lógica do conector (assinatura HMAC,
> arredondamento por `LOT_SIZE`, contabilidade de `netProceeds`, parsing de
> resposta) é coberta por testes de unidade que não dependem de rede — ver
> `src/binanceExchangeProvider.test.ts` — mas a conectividade fim-a-fim só
> pode ser validada rodando `npm run live` a partir de um ambiente com
> acesso de rede à Binance.
