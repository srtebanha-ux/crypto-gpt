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
    if (s === 'WETH' || s === 'ETH' || s === 'CBETH' || s === 'WSTETH' || s === 'WEETH') return 'ETHUSDT';
    if (s === 'CBBTC' || s === 'WBTC' || s === 'BTC' || s === 'TBTC') return 'BTCUSDT';
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
