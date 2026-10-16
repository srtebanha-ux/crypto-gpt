// Arquivo: src/triangleTopology.ts
//
// Descoberta de topologia de triângulos USDT->base->alt->USDT que são
// REALMENTE negociáveis na Binance (os três lados existem como par listado),
// a partir da lista real de símbolos — em vez de assumir uma contagem
// combinatorialmente possível mas não necessariamente listada.
//
// Compartilhado entre dois consumidores que falam formatos diferentes:
//   - opportunitySniffer.ts precisa do formato de símbolo CRU da Binance
//     (ex.: "BTCUSDT") para assinar streams diretamente.
//   - engine.ts/BinanceExchangeProvider já falam o formato de PAR interno
//     (ex.: "BTC/USDT") em todo o resto do projeto (ver types.ts).
// `discoverTriangles` é o núcleo único de descoberta; as duas funções
// exportadas abaixo só formatam sua saída de forma diferente, evitando
// duplicar a lógica de varredura do grafo.
import { Triangle as EnginePairTriangle } from './types';

export interface SymbolInfo {
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
}

/** Triângulo em formato de símbolo cru da Binance (ex.: "BTCUSDT"). */
export interface RawTriangle {
    id: string;
    leg1: string; // USDT -> base (ex.: BTCUSDT), lado ASK
    leg2: string; // base -> alt (ex.: ETHBTC), lado ASK
    leg3: string; // alt -> USDT (ex.: ETHUSDT), lado BID
}

interface DiscoveredTriangle {
    id: string;
    leg1: SymbolInfo;
    leg2: SymbolInfo;
    leg3: SymbolInfo;
}

function discoverTriangles(symbols: SymbolInfo[], intermediateBases: string[]): DiscoveredTriangle[] {
    const bySymbol = new Map(symbols.map((s) => [s.symbol, s]));
    const triangles: DiscoveredTriangle[] = [];

    for (const base of intermediateBases) {
        const leg1 = bySymbol.get(`${base}USDT`);
        if (!leg1) continue;

        for (const leg2 of symbols) {
            if (leg2.quoteAsset !== base || leg2.baseAsset === 'USDT') continue;
            const altAsset = leg2.baseAsset;
            const leg3 = bySymbol.get(`${altAsset}USDT`);
            if (!leg3) continue;

            triangles.push({ id: `USDT-${base}-${altAsset}`, leg1, leg2, leg3 });
        }
    }
    return triangles;
}

/** Triângulos em formato de símbolo CRU da Binance — usado por opportunitySniffer.ts. */
export function buildTriangles(symbols: SymbolInfo[], intermediateBases: string[]): RawTriangle[] {
    return discoverTriangles(symbols, intermediateBases).map((t) => ({
        id: t.id,
        leg1: t.leg1.symbol,
        leg2: t.leg2.symbol,
        leg3: t.leg3.symbol,
    }));
}

/** Os mesmos triângulos, em formato de PAR interno — usado pelo engine/BinanceExchangeProvider. */
export function buildEnginePairTriangles(symbols: SymbolInfo[], intermediateBases: string[]): EnginePairTriangle[] {
    return discoverTriangles(symbols, intermediateBases).map((t) => ({
        id: t.id,
        leg1: `${t.leg1.baseAsset}/${t.leg1.quoteAsset}`,
        leg2: `${t.leg2.baseAsset}/${t.leg2.quoteAsset}`,
        leg3: `${t.leg3.baseAsset}/${t.leg3.quoteAsset}`,
    }));
}
