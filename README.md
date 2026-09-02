# crypto-gpt

Painel de gráfico ao vivo (`painel.html`) + motor de arbitragem triangular
HFT delta-neutral (`src/index.ts`).

## Arbitragem Triangular (`src/index.ts`)

Núcleo de execução (`ExchangeProvider` mock + `RiskManager` +
`TriangularArbitrageEngine`) para explorar ineficiências de preço síncronas
entre 3 pares na mesma corretora (ex. `USDT → BTC → ETH → USDT`), usando
`decimal.js` para evitar perda de precisão de ponto flutuante em cálculos
financeiros.

Condição de disparo (kill switch de lucro):

```
P3 / (P1 * P2) * (1 - f)^3 > 1 + slippage_tolerância
```

Kill switch adicional por obsolescência de dado: ordens são ignoradas se
qualquer ticker envolvido tiver mais de 100ms de idade (timestamp
invalidation).

O `ExchangeProvider` incluso é um mock com feed simulado — antes de operar
com capital real é necessário substituí-lo por uma implementação conectada
via WebSocket a uma corretora real (ex. Binance), com autenticação e
tratamento de erros de rede.

### Rodar

```bash
npm install
npm run dev        # roda direto via ts-node
npm run build       # compila para dist/
npm start           # roda o build
npm run typecheck   # apenas checagem de tipos
```
