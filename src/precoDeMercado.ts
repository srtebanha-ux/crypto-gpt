// Arquivo: src/precoDeMercado.ts
//
// O preco real, em tempo real, de graca.
//
// O oraculo da Aave e uma copia atrasada disto. Ler aqui custa zero Unidades
// de Computacao, porque nao passa pela blockchain — e e por isso que da para
// olhar o tempo todo, enquanto olhar a blockchain o tempo todo estouraria o
// orcamento do mes em horas.
import { Decimal } from 'decimal.js';
import { buscar } from './conexoes';

export const BINANCE = process.env.CACA_BINANCE_REST ?? 'https://api.binance.com';

/** `symbol()` — o simbolo do token, lido da propria blockchain. */
export const SELETOR_SYMBOL = '0x95d89b41';

/**
 * De que par da Binance este token segue o preco.
 *
 * O mapa e por SIMBOLO, lido on-chain, e nao por endereco escrito aqui. Uma
 * lista de enderecos decorados envelhece em silencio e e exatamente o tipo de
 * coisa que este projeto ja errou; o simbolo vem do proprio contrato.
 *
 * `null` quer dizer "nao acompanho", e e uma resposta legitima: stablecoin nao
 * derruba ninguem por variacao de preco, e token sem par liquido na Binance
 * daria um preco pior que o do oraculo.
 */
export function simboloDaBinance(simboloDoToken: string): string | null {
    const s = simboloDoToken.trim().toUpperCase();
    // So os que valem o MESMO que a moeda do par. wstETH, cbETH e weETH
    // rendem juros e valem MAIS que um ETH — comparar o preco deles com
    // ETHUSDT daria uma "queda" permanente de uns 17%, e o bot ficaria preso
    // em 'dedo no gatilho' para sempre, lendo a blockchain a 200ms sem motivo.
    // Seguir o preco deles exige a taxa de conversao, que a gente nao le.
    if (s === 'WETH' || s === 'ETH') return 'ETHUSDT';
    if (s === 'CBBTC' || s === 'WBTC' || s === 'BTC') return 'BTCUSDT';
    return null;
}

/** Le a resposta de `symbol()`, que vem como string ABI. */
export function lerSymbol(hex: string): string | null {
    const sem = hex.replace(/^0x/, '');
    if (sem.length < 128) return null;
    try {
        const tamanho = Number.parseInt(sem.slice(64, 128), 16);
        if (!Number.isFinite(tamanho) || tamanho <= 0 || tamanho > 64) return null;
        const bytes = sem.slice(128, 128 + tamanho * 2);
        return Buffer.from(bytes, 'hex').toString('utf8');
    } catch {
        return null;
    }
}

/** O que a Binance devolve em /api/v3/ticker/price. */
export interface CotacaoCrua { symbol: string; price: string }

/**
 * Le as cotacoes, tolerando resposta estranha em vez de derrubar o cacador.
 *
 * Preco de mercado e acelerador, nao motor: se a Binance nao responder, o bot
 * volta ao ritmo normal e continua cacando pelo oraculo. Por isso aqui nada
 * lanca — devolve o que deu para ler.
 */
export function lerCotacoes(corpo: unknown): Map<string, Decimal> {
    const fora = new Map<string, Decimal>();
    if (!Array.isArray(corpo)) return fora;
    for (const item of corpo as CotacaoCrua[]) {
        if (typeof item?.symbol !== 'string' || typeof item?.price !== 'string') continue;
        try {
            const p = new Decimal(item.price);
            if (p.greaterThan(0)) fora.set(item.symbol, p);
        } catch { /* cotacao ilegivel nao vira zero, vira ausencia */ }
    }
    return fora;
}

/**
 * Quanto o MERCADO ja caiu em relacao ao que esta escrito na blockchain.
 *
 * Este e o numero que adianta o futuro. O feed Chainlink so escreve quando se
 * afasta de um limiar, entao enquanto ele nao escreve este valor cresce — e
 * quem esta a menos disso de ser liquidado ja caiu de fato, so que a Aave
 * ainda nao sabe.
 *
 * So queda conta: preco subindo nao derruba ninguem de pe.
 */
export function quedaDoMercado(
    doMercado: Map<string, Decimal>,
    doOraculo: Map<string, Decimal>,
): Decimal {
    let maior = new Decimal(0);
    for (const [par, mercado] of doMercado) {
        const oraculo = doOraculo.get(par);
        if (!oraculo || oraculo.lessThanOrEqualTo(0)) continue;
        const queda = oraculo.minus(mercado).dividedBy(oraculo).mul(100);
        if (queda.greaterThan(maior)) maior = queda;
    }
    return maior;
}

/** Busca as cotacoes dos pares pedidos. Devolve mapa vazio se falhar. */
export async function cotacoesDaBinance(pares: string[], timeoutMs = 2000): Promise<Map<string, Decimal>> {
    if (pares.length === 0) return new Map();
    const lista = encodeURIComponent(JSON.stringify([...new Set(pares)]));
    try {
        const r = await buscar(`${BINANCE}/api/v3/ticker/price?symbols=${lista}`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        return lerCotacoes(await r.json());
    } catch {
        return new Map();
    }
}

// ---------------------------------------------------------------------------
// Quando a Binance nao responde.
// ---------------------------------------------------------------------------
//
// Ela bloqueia IP de nuvem, e o Railway e nuvem. O log denunciou isso no
// primeiro boot — "MERCADO MUDO" — e sem preco de mercado o bot perde a
// vantagem inteira de antecipar o oraculo e volta ao ritmo fixo.
//
// Uma fonte so era ponto unico de falha para a parte mais valiosa do desenho.
// Agora sao tres, e a primeira que responder ganha.

/** Le a cotacao unica da Coinbase: { price: "2646.93" }. */
export function lerCoinbase(corpo: unknown): Decimal | null {
    const p = (corpo as { price?: string })?.price;
    if (typeof p !== 'string') return null;
    try {
        const d = new Decimal(p);
        return d.greaterThan(0) ? d : null;
    } catch { return null; }
}

/** Le a cotacao da Kraken: { result: { XETHZUSD: { c: ["2646.93", ...] } } }. */
export function lerKraken(corpo: unknown): Decimal | null {
    const r = (corpo as { result?: Record<string, { c?: string[] }> })?.result;
    if (!r) return null;
    for (const par of Object.values(r)) {
        const v = par?.c?.[0];
        if (typeof v !== 'string') continue;
        try {
            const d = new Decimal(v);
            if (d.greaterThan(0)) return d;
        } catch { /* proxima */ }
    }
    return null;
}

/** De que produto de cada casa vem o preco de um par da Binance. */
export const EQUIVALENTES: Record<string, { coinbase: string; kraken: string }> = {
    ETHUSDT: { coinbase: 'ETH-USD', kraken: 'ETHUSD' },
    BTCUSDT: { coinbase: 'BTC-USD', kraken: 'XBTUSD' },
};

export const COINBASE = process.env.CACA_COINBASE_REST ?? 'https://api.exchange.coinbase.com';
export const KRAKEN = process.env.CACA_KRAKEN_REST ?? 'https://api.kraken.com';

/**
 * As cotacoes, de onde der.
 *
 * Tenta a Binance (uma chamada para todos os pares), e so cai para as outras
 * se ela nao responder. Coinbase e Kraken pedem uma chamada por par, entao sao
 * o plano B de proposito — e mesmo assim custam zero em Unidades de
 * Computacao, porque nada disso passa pela blockchain.
 *
 * Devolve tambem de ONDE veio, para o log poder dizer. Fonte silenciosa que
 * troca sozinha e a mesma armadilha de sempre: funciona e ninguem sabe como.
 */
export async function cotacoesDeQualquerFonte(
    pares: string[],
    timeoutMs = 2000,
): Promise<{ precos: Map<string, Decimal>; fonte: string }> {
    const daBinance = await cotacoesDaBinance(pares, timeoutMs);
    if (daBinance.size > 0) return { precos: daBinance, fonte: 'binance' };

    for (const [nome, buscarUm] of [
        ['coinbase', async (par: string) => {
            const eq = EQUIVALENTES[par]?.coinbase;
            if (!eq) return null;
            const r = await buscar(`${COINBASE}/products/${eq}/ticker`, { signal: AbortSignal.timeout(timeoutMs) });
            return lerCoinbase(await r.json());
        }],
        ['kraken', async (par: string) => {
            const eq = EQUIVALENTES[par]?.kraken;
            if (!eq) return null;
            const r = await buscar(`${KRAKEN}/0/public/Ticker?pair=${eq}`, { signal: AbortSignal.timeout(timeoutMs) });
            return lerKraken(await r.json());
        }],
    ] as const) {
        const fora = new Map<string, Decimal>();
        for (const par of pares) {
            try {
                const p = await buscarUm(par);
                if (p) fora.set(par, p);
            } catch { /* proxima casa */ }
        }
        if (fora.size > 0) return { precos: fora, fonte: nome };
    }
    return { precos: new Map(), fonte: 'nenhuma' };
}
