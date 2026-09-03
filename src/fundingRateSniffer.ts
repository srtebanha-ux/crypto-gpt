// Arquivo: src/fundingRateSniffer.ts
//
// Medição empírica do carry de funding rate — NÃO executa ordem nenhuma.
//
// Mesma filosofia do opportunitySniffer.ts, e pelo mesmo motivo: a pergunta
// "essa estratégia vale a pena?" só tem resposta com dado do mercado real.
// No caso da arbitragem triangular, um dia inteiro de argumento não resolveu
// o que dez minutos de medição resolveram — o mercado oferecia 0,124% contra
// um custo de 0,225%, e nenhum ajuste de parâmetro mudaria isso.
//
// Aqui a pergunta é outra e mais específica: o carry delta-neutro (comprado
// no spot, vendido no perpétuo) tem vantagem POSITIVA — funding é pago no
// relógio, a cada 8h, e não numa corrida de latência que perdemos. O que
// precisa ser medido é:
//
//   1. Quanto os perpétuos estão realmente pagando agora.
//   2. Com que frequência esse funding fica NEGATIVO (aí o vendido paga, e a
//      posição sangra) — isso importa mais que a taxa atual.
//   3. A partir de QUAL CAPITAL o retorno deixa de ser trocado por taxa.
//
// O item 3 é o que este relatório existe para responder: escalar capital não
// cria vantagem nenhuma, só torna a mesma vantagem grande o bastante para
// importar. A tabela no fim mostra exatamente onde fica esse limiar.
//
// Só endpoints públicos: não precisa de API key nem de conta de futuros.
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import {
    annualizeFundingRate,
    projectCarry,
    summarizeFundingHistory,
    type FeeModel,
    type FundingHistoryStats,
} from './fundingRate';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const log = createLogger('funding-sniffer');

const FUTURES_REST = 'https://fapi.binance.com';
/** Quantos símbolos (por funding atual) levar adiante para buscar histórico. */
const TOP_SYMBOLS_TO_ANALYZE = 15;
/** Amostras de histórico por símbolo — 100 pagamentos ≈ 33 dias. */
const HISTORY_LIMIT = 100;
/** Capitais da tabela final, em USDT. */
const CAPITAL_LADDER = ['20', '50', '100', '500', '1000', '5000', '10000'];

interface PremiumIndexEntry {
    symbol: string;
    lastFundingRate: string;
    markPrice: string;
}

interface FundingRateEntry {
    symbol: string;
    fundingRate: string;
}

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status} em ${url} — ${await res.text()}`);
    }
    return (await res.json()) as T;
}

/**
 * Só perpétuos USDⓈ-M liquidados em USDT: são os que têm par spot
 * correspondente para montar a perna comprada. Contratos com data de
 * vencimento (símbolos com "_") não servem para carry contínuo.
 */
function isUsdtPerpetual(symbol: string): boolean {
    return symbol.endsWith('USDT') && !symbol.includes('_');
}

function resolveFees(): FeeModel {
    return {
        spotTakerFee: new Decimal(process.env.SPOT_TAKER_FEE ?? '0.00075'),
        futuresTakerFee: new Decimal(process.env.FUTURES_TAKER_FEE ?? '0.0005'),
    };
}

function formatPct(fraction: Decimal): string {
    return `${fraction.mul(100).toFixed(4)}%`;
}

async function main() {
    const fees = resolveFees();
    log.info('Medindo funding rates reais na Binance Futures (nenhuma ordem será enviada).', {
        taxaSpot: fees.spotTakerFee.toString(),
        taxaFuturos: fees.futuresTakerFee.toString(),
    });

    const premium = await fetchJson<PremiumIndexEntry[]>(`${FUTURES_REST}/fapi/v1/premiumIndex`);
    const perpetuals = premium
        .filter((e) => isUsdtPerpetual(e.symbol))
        .map((e) => ({ symbol: e.symbol, rate: new Decimal(e.lastFundingRate) }))
        .sort((a, b) => b.rate.comparedTo(a.rate));

    log.info(`Perpétuos USDT encontrados: ${perpetuals.length}. Analisando os ${TOP_SYMBOLS_TO_ANALYZE} de maior funding atual.`);

    // A taxa ATUAL sozinha é uma péssima base de decisão — ela oscila e vira
    // negativa. Por isso cada candidato leva um resumo do histórico junto.
    const analyzed: Array<{ symbol: string; current: Decimal; history: FundingHistoryStats | null }> = [];
    for (const p of perpetuals.slice(0, TOP_SYMBOLS_TO_ANALYZE)) {
        try {
            const hist = await fetchJson<FundingRateEntry[]>(
                `${FUTURES_REST}/fapi/v1/fundingRate?symbol=${p.symbol}&limit=${HISTORY_LIMIT}`,
            );
            analyzed.push({
                symbol: p.symbol,
                current: p.rate,
                history: summarizeFundingHistory(hist.map((h) => new Decimal(h.fundingRate))),
            });
        } catch (err) {
            log.warn(`Falha ao buscar histórico de ${p.symbol}; seguindo sem ele.`, {
                error: err instanceof Error ? err.message : String(err),
            });
            analyzed.push({ symbol: p.symbol, current: p.rate, history: null });
        }
    }

    log.info('=== FUNDING ATUAL vs. HISTÓRICO (~33 dias) ===');
    for (const a of analyzed) {
        const h = a.history;
        log.info(a.symbol, {
            fundingAtual8h: formatPct(a.current),
            atualAnualizado: h ? formatPct(annualizeFundingRate(a.current)) : 'n/d',
            mediaHistorica8h: h ? formatPct(h.meanRate) : 'n/d',
            mediaAnualizada: h ? formatPct(annualizeFundingRate(h.meanRate)) : 'n/d',
            // O número que mais importa: com que frequência a posição PAGARIA
            // em vez de receber. Um funding alto que fica negativo 40% do
            // tempo é pior que um funding modesto e estável.
            fracaoNegativa: h ? formatPct(h.negativeFraction) : 'n/d',
            faixa8h: h ? `${formatPct(h.minRate)} .. ${formatPct(h.maxRate)}` : 'n/d',
        });
    }

    // Para a projeção, usar a MÉDIA HISTÓRICA e não a taxa atual: a atual é um
    // ponto único e costuma estar no pico justamente nos símbolos que lideram
    // o ranking, o que produziria uma projeção sistematicamente otimista.
    const best = analyzed.filter((a) => a.history !== null).sort((a, b) => b.history!.meanRate.comparedTo(a.history!.meanRate))[0];
    if (!best) {
        log.error('Nenhum símbolo com histórico disponível — não dá para projetar.');
        process.exit(1);
    }

    const meanAnnual = annualizeFundingRate(best.history!.meanRate);
    log.info('=== PROJEÇÃO POR CAPITAL ===', {
        simboloBase: best.symbol,
        criterio: 'maior MÉDIA histórica (não a taxa atual, que é um ponto isolado e costuma estar no pico)',
        mediaAnualizada: formatPct(meanAnnual),
        fracaoNegativa: formatPct(best.history!.negativeFraction),
    });

    for (const capital of CAPITAL_LADDER) {
        const p = projectCarry(new Decimal(capital), meanAnnual, fees);
        log.info(`capital $${capital}`, {
            notionalPorPerna: `$${p.notionalPerLeg.toFixed(2)}`,
            fundingBrutoAno: `$${p.grossAnnualFunding.toFixed(2)}`,
            custoIdaEVolta: `$${p.roundTripCost.toFixed(4)}`,
            lucroLiquidoAno: `$${p.netAnnualProfit.toFixed(2)}`,
            retornoAno: formatPct(p.netAnnualReturnFraction),
            lucroLiquidoMes: `$${p.netAnnualProfit.dividedBy(12).toFixed(2)}`,
            diasParaPagarMontagem: p.breakEvenDays ? p.breakEvenDays.toFixed(1) : 'nunca (funding negativo)',
        });
    }

    log.info('=== COMO LER ===', {
        ponto1: 'O retorno PERCENTUAL é o mesmo em qualquer linha — escalar capital não cria vantagem, só amplia a que já existe.',
        ponto2: 'Escolha a linha onde o lucro mensal em dólar deixa de ser irrelevante para você. Esse é o capital mínimo que justifica construir o motor.',
        ponto3: 'fracaoNegativa alta invalida a projeção: se o funding vira negativo com frequência, a média histórica esconde períodos em que a posição sangra.',
        ponto4: 'Isto é projeção sob a hipótese de o funding médio se repetir — NÃO é retorno garantido. Funding muda com o regime de mercado.',
    });

    process.exit(0);
}

main().catch((err) => {
    log.error('Falha ao medir funding rates.', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
