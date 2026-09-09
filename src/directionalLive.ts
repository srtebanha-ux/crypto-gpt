// Arquivo: src/directionalLive.ts
//
// Motor DIRECIONAL rodando 24/7: compra na baixa (RSI sobrevendido que já
// virou) ou no rompimento, com stop e stop móvel, sobre vários ativos.
//
// Diferente do motor de arbitragem, aqui a posição fica exposta ao preço e
// pode dar prejuízo sem que nada tenha falhado tecnicamente. Por isso duas
// escolhas estruturais:
//
//   1. USA EXATAMENTE O MESMO CÓDIGO DE SINAL E DIMENSIONAMENTO DO BACKTEST
//      (`signals.ts`, `positionSizing.ts`). Se o motor ao vivo decidisse por
//      lógica própria, o backtest não estaria medindo o que vai operar — e
//      todo o trabalho de validação viraria decoração.
//   2. PADRÃO É PAPEL. Sem ordem real, sem chave, sem risco: acompanha o
//      mercado de verdade e registra o que teria feito. Ordens reais exigem
//      DIRECTIONAL_LIVE=true e DIRECTIONAL_LIVE_CONFIRM, mesmo padrão de gate
//      do motor de arbitragem.
//
// Decide no FECHAMENTO da vela e executa na abertura da seguinte — igual ao
// backtest. Reagir no meio da vela produziria comportamento que o backtest
// nunca mediu.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Decimal } from 'decimal.js';
import { createLogger } from './logger';
import { BinanceExchangeProvider } from './binanceExchangeProvider';
import {
    atr,
    detectBreakout,
    detectMomentumSurge,
    detectOversoldReversion,
    isAboveTrend,
    rsiSeries,
    type Candle,
} from './signals';
import { planPosition, tradeNetPnl, updateTrailingStopAtr } from './positionSizing';
import {
    alavancagemEfetiva,
    alavancagemSustentada,
    capitalDeTrabalho,
    custoDeIdaEVoltaSobreCapital,
    lucroCongelado,
    stopDisparaAntesDaLiquidacao,
} from './leverage';
import { barrasDesde, decidirSaidaPorTempo } from './timeStop';
import { operacaoValeATaxa } from './feeViability';
import { decidirEntradaPassiva, precoDaCompraPassiva } from './makerEntry';
import { resolverPreset, resolveStrategyParams, type ResolvedStrategyParams } from './strategyParams';
import type { EntryStrategy } from './backtest';


Decimal.set({ precision: 30, rounding: Decimal.ROUND_DOWN });

const log = createLogger('direcional');

const BINANCE_REST = 'https://api.binance.com';
/** Velas de histórico mantidas por ativo — suficiente para média de 50 + folga. */
const HISTORY_CANDLES = 300;

/**
 * "BTCUSDT" -> "BTC/USDT", o formato de par interno que o
 * BinanceExchangeProvider usa em `executeOrder`.
 *
 * Uma função só, usada TANTO para registrar os filtros no boot QUANTO para
 * enviar as ordens. Se o boot registrasse uma string e a ordem procurasse
 * outra, o símbolo voltaria a ser "desconhecido para a Binance" — e só na
 * hora da compra, com sinal válido na mão.
 *
 * A âncora `$` importa: `replace('USDT', '')` sem ela troca a PRIMEIRA
 * ocorrência, e um símbolo com "USDT" no meio viraria um par inexistente.
 */
export function paraPar(symbol: string): string {
    return `${symbol.replace(/USDT$/, '')}/USDT`;
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

/** Estado que precisa sobreviver a um reinício do processo. */
export interface BookState {
    capital: string;
    realizedPnl: string;
    wins: number;
    losses: number;
    somaGanhos?: string;
    somaPerdas?: string;
    /**
     * Quantas operações fechadas chegaram a 1R, 2R, 3R e 5R de lucro ANTES de
     * fechar — a excursão favorável máxima, em múltiplos do risco inicial.
     *
     * Existe para responder com DADO uma pergunta que só se responde com
     * chute: "e se o motor buscasse alvos grandes em vez de stop móvel?".
     * Um alvo de 5R só é lucrativo se for atingido em mais de 1 a cada 6
     * operações; sem esta contagem, adotar ou rejeitar o alvo é aposta.
     *
     * Ausente em estados gravados antes desta medição existir.
     */
    excursaoMaxima?: { medidas: number; r1: number; r2: number; r3: number; r5: number };
    committed: string;
    positions: Array<{
        symbol: string;
        entryPrice: string;
        quantity: string;
        notional: string;
        /** Ausente em estados gravados antes da margem existir: eram todos à vista. */
        margemUsada?: string;
        /**
         * Posição ADOTADA: o preço de entrada aqui é o do momento da adoção,
         * não o que foi pago de verdade. Todo número derivado dela — variação,
         * resultado, excursão em R — mede a partir da adoção.
         */
        adotada?: boolean;
        initialRisk: string;
        stopPrice: string;
        highestSinceEntry: string;
        openedAt: number;
    }>;
}

/**
 * Grava o estado de forma atômica: escreve num temporário e renomeia.
 *
 * Sem isso, um reinício no meio da escrita deixaria um JSON truncado — e o
 * motor subiria sem as posições que acabou de salvar, que é o cenário exato
 * que a persistência existe para evitar.
 */
export function saveState(path: string, books: Record<string, BookState>): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(books, null, 2));
    renameSync(tmp, path);
}

export function loadState(path: string): Record<string, BookState> {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, BookState>;
    } catch {
        return {};
    }
}

/**
 * O que fazer quando o livro e o saldo real da corretora divergem.
 *
 * Isolado como função pura porque é a decisão que importa e a que pode estar
 * errada — o resto é I/O. Os quatro casos têm ações opostas, e confundir dois
 * deles custa caro: tratar órfã como "nada a fazer" deixa dinheiro real sem
 * stop; tratar fantasma como posição bloqueia o caixa para sempre.
 */
export type ReconcileAction =
    | 'nada'
    | 'remover-fantasma'
    | 'adotar-orfa'
    | 'liquidar-orfa'
    | 'alertar-orfa';

export function decideReconcile(params: {
    temPosicaoNoLivro: boolean;
    valorDoSaldo: Decimal;
    minNotional: Decimal;
    podeAdotar: boolean;
    /**
     * Vender a órfã imediatamente, em vez de adotá-la.
     *
     * Tem precedência sobre adotar porque as duas resolvem problemas
     * diferentes: adotar mantém a exposição e coloca um stop; liquidar
     * DEVOLVE O COLATERAL. Numa conta pequena e alavancada, uma órfã segurando
     * o colateral inteiro impede qualquer operação nova — e aí o motor fica
     * vivo, gerando sinal, e levando recusa da corretora em todos eles.
     */
    podeLiquidar?: boolean;
}): ReconcileAction {
    // "Relevante" é o mesmo piso que impede abrir posição: abaixo do notional
    // mínimo a corretora nem aceitaria vender, então poeira de saldo não é
    // posição. Sem esse piso, restos de arredondamento virariam posições
    // fantasma a cada ciclo.
    const relevante = params.valorDoSaldo.greaterThanOrEqualTo(params.minNotional);
    if (params.temPosicaoNoLivro && !relevante) return 'remover-fantasma';
    if (!params.temPosicaoNoLivro && relevante) {
        if (params.podeLiquidar) return 'liquidar-orfa';
        return params.podeAdotar ? 'adotar-orfa' : 'alertar-orfa';
    }
    return 'nada';
}

interface OpenPosition {
    symbol: string;
    entryPrice: Decimal;
    quantity: Decimal;
    /** Tamanho da posição no mercado (quantidade × preço de entrada). */
    notional: Decimal;
    /**
     * Dinheiro PRÓPRIO imobilizado por ela: nocional dividido pela alavancagem
     * usada na entrada.
     *
     * Guardado em vez de recalculado porque a alavancagem efetiva muda ao
     * longo do tempo (a regra do alvo pode baixá-la para 1x entre a entrada e
     * a saída). Recalcular na saída devolveria ao caixa um valor diferente do
     * que foi reservado, e o erro se acumularia posição após posição sem nada
     * acusar.
     */
    margemUsada: Decimal;
    /** Adotada: preço de entrada é o da adoção, não o realmente pago. */
    adotada?: boolean;
    /** Distância entrada→stop inicial por unidade. É o "R" do alvo de lucro. */
    initialRisk: Decimal;
    stopPrice: Decimal;
    highestSinceEntry: Decimal;
    openedAt: number;
}

interface Config {
    symbols: string[];
    interval: string;
    capital: Decimal;
    pollSeconds: number;
    live: boolean;
    /** Onde o estado é gravado para sobreviver a reinício. */
    stateFile: string;
    /** Teto de uma posição como fração do livro. Permite ter mais de uma. */
    maxPositionFraction: Decimal;
    /** Opera na Margem Cruzada (empresta) em vez do Spot. */
    margem: boolean;
    /** Poder de compra por unidade de capital. 1 = à vista. */
    alavancagem: Decimal;
    /** Patrimônio em que a alavancagem volta para 1x. Zero desliga a regra. */
    alvoDeDesalavancagem: Decimal;
    /**
     * Teto de capital que o motor pode arriscar. O que passar disso congela.
     *
     * É o degrau da escada: alcançado o valor, o excedente para de trabalhar e
     * vira lucro guardado — mesmo antes de sair da corretora. Zero desliga.
     */
    tetoDeCapital: Decimal;
    /** Tenta entrar como MAKER (taxa de quem espera) antes de atravessar. */
    entradaPassiva: boolean;
    /** Quanto esperar a ordem passiva preencher, em ms. */
    esperaPassivaMs: number;
    /**
     * Parâmetros de sinal e risco, resolvidos pelo MESMO código que o backtest
     * usa. Operar com parâmetros diferentes dos medidos é operar às cegas — e
     * já aconteceu aqui, quando as duas leituras eram separadas e os padrões
     * divergiram sozinhos.
     */
    strategy: ResolvedStrategyParams;
    /** Uma por família em execução; cada uma com livro e capital próprios. */
    livros: ResolvedStrategyParams[];
}

function parseKline(raw: RawKline): Candle {
    return {
        openTime: raw[0],
        open: new Decimal(raw[1]),
        high: new Decimal(raw[2]),
        low: new Decimal(raw[3]),
        close: new Decimal(raw[4]),
        volume: new Decimal(raw[5]),
    };
}

/**
 * Busca as velas FECHADAS de um símbolo.
 *
 * A última vela devolvida pela Binance é a que ainda está em formação. Usá-la
 * é o equivalente ao vivo do look-ahead do backtest: o "fechamento" ainda vai
 * mudar, e um sinal disparado sobre ele some no minuto seguinte. Por isso ela
 * é descartada.
 */
async function fetchClosedCandles(
    symbol: string,
    interval: string,
    limit: number,
): Promise<{ closed: Candle[]; precoAgora: Decimal }> {
    const res = await fetch(`${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit + 1}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar klines de ${symbol}`);
    const raw = (await res.json()) as RawKline[];
    const todas = raw.map(parseKline);
    // A vela em formação sai das DECISÕES e fica só para EXIBIÇÃO. Decidir
    // sobre ela é look-ahead ao vivo — o "fechamento" ainda vai mudar. Mas
    // acompanhar quanto a posição aberta está ganhando agora não é decisão, e
    // quem opera precisa desse número de minuto a minuto.
    return { closed: todas.slice(0, -1), precoAgora: todas[todas.length - 1].close };
}

function resolveConfig(): Config {
    const live = process.env.DIRECTIONAL_LIVE === 'true';
    if (live && process.env.DIRECTIONAL_LIVE_CONFIRM !== 'I_UNDERSTAND_THE_RISK') {
        throw new Error(
            'DIRECTIONAL_LIVE=true exige DIRECTIONAL_LIVE_CONFIRM=I_UNDERSTAND_THE_RISK. ' +
                'Ordens reais numa estratégia direcional podem perder dinheiro sem nenhuma falha técnica.',
        );
    }
    // Margem empresta dinheiro da corretora, e com isso vem a LIQUIDAÇÃO — a
    // posição pode ser fechada pela Binance sem o stop ter sido tocado. Exigir
    // as duas variáveis separadas impede que alguém ligue alavancagem achando
    // que só aumentou o tamanho da posição.
    const margem = process.env.DIRECTIONAL_MARGIN === 'true';
    const alavancagem = new Decimal(process.env.DIRECTIONAL_LEVERAGE ?? '1');
    if (alavancagem.lessThan(1)) {
        throw new Error(`DIRECTIONAL_LEVERAGE inválida: ${alavancagem.toString()}. Mínimo 1 (à vista).`);
    }
    if (alavancagem.greaterThan(1) && !margem) {
        throw new Error(
            'DIRECTIONAL_LEVERAGE > 1 exige DIRECTIONAL_MARGIN=true. À vista não existe alavancagem: ' +
                'sem a conta de margem a ordem usaria só o saldo próprio e o número configurado não faria nada.',
        );
    }
    if (margem && !live) {
        // Em papel a alavancagem é simulada e não há liquidação de verdade;
        // deixar passar sem dizer isso faria o placar de papel parecer mais
        // seguro do que a operação real seria.
        log.warn('DIRECTIONAL_MARGIN=true em modo PAPEL: o tamanho é simulado com alavancagem, mas NÃO existe liquidação simulada.');
    }
    // Trim e minúsculas: um espaço sobrando numa variável do painel do Railway
    // é invisível e derrubaria o motor no boot com "estratégia inválida" — falha
    // barulhenta por um erro de digitação que ninguém consegue ver.
    const escolha = (process.env.DIRECTIONAL_STRATEGY ?? 'reversion').trim().toLowerCase();
    const VALIDAS = ['breakout', 'reversion', 'momentum', 'both', 'all'];
    if (!VALIDAS.includes(escolha)) {
        throw new Error(`DIRECTIONAL_STRATEGY inválida: "${escolha}". Use ${VALIDAS.join(', ')}.`);
    }
    // 'both' e 'all' rodam as famílias em livros SEPARADOS, com o capital
    // dividido. Separar é o ponto: misturadas, um resultado bom de uma
    // esconderia um ruim da outra, e a comparação — que é o motivo de rodar
    // mais de uma — sumiria.
    const familias: EntryStrategy[] =
        escolha === 'all'
            ? ['reversion', 'breakout', 'momentum']
            : escolha === 'both'
            ? ['reversion', 'breakout']
            : [escolha as EntryStrategy];
    // Todo o motor assume cotação em USDT: o saldo é lido de
    // `symbol.replace(USDT)` e o par é montado como `X/USDT`. Um símbolo com
    // outra cotação passaria por aqui em silêncio e só falharia na ordem.
    const symbols = (process.env.DIRECTIONAL_SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    const semUsdt = symbols.filter((s) => !s.endsWith('USDT'));
    if (semUsdt.length > 0) {
        throw new Error(
            `DIRECTIONAL_SYMBOLS só aceita pares cotados em USDT. Fora do padrão: ${semUsdt.join(', ')}.`,
        );
    }
    return {
        symbols,
        interval: process.env.DIRECTIONAL_INTERVAL ?? '1h',
        capital: new Decimal(process.env.DIRECTIONAL_CAPITAL ?? '20'),
        pollSeconds: Number(process.env.DIRECTIONAL_POLL_SEC ?? '60'),
        live,
        stateFile: process.env.DIRECTIONAL_STATE_FILE ?? './data/directional-state.json',
        maxPositionFraction: new Decimal(process.env.DIRECTIONAL_MAX_POSITION_FRACTION ?? '0.34'),
        margem,
        alavancagem,
        alvoDeDesalavancagem: new Decimal(process.env.DIRECTIONAL_LEVERAGE_TARGET ?? '0'),
        tetoDeCapital: new Decimal(process.env.DIRECTIONAL_CAPITAL_CAP ?? '0'),
        entradaPassiva: process.env.DIRECTIONAL_MAKER_ENTRY === 'true',
        esperaPassivaMs: Number(process.env.DIRECTIONAL_MAKER_WAIT_MS ?? '8000'),
        strategy: resolveStrategyParams(familias[0]),
        livros: familias.map((f) => resolveStrategyParams(f)),
    };
}

async function main() {
    const cfg = resolveConfig();
    const exchange = cfg.live
        ? new BinanceExchangeProvider({
              apiKey: process.env.BINANCE_API_KEY!,
              apiSecret: process.env.BINANCE_API_SECRET!,
              live: true,
              mode: cfg.margem ? 'margin' : 'spot',
              // Sem isto o motor calcula com a taxa CHEIA mesmo numa conta que
              // paga com desconto: o endpoint de taxa da Binance devolve a
              // comissão base e não reflete o abatimento de BNB, que é aplicado
              // só na execução. O efeito é subestimar o lucro e recusar, pelo
              // filtro de custo, operações que de fato pagariam.
              bnbFeeDiscount: process.env.BNB_FEE_DISCOUNT === 'true',
              // Sem alavancagem não há o que emprestar. Pedir empréstimo de
              // qualquer forma faz a Binance recusar TODAS as ordens quando a
              // conta não tem limite de empréstimo — e aí o motor fica sem
              // operar por um motivo que nada tem a ver com a estratégia.
              marginAutoBorrow: cfg.alavancagem.greaterThan(1),
          })
        : null;
    if (exchange) {
        // `connect()` NÃO serve aqui: ele só registra símbolos que aparecem em
        // algum triângulo de arbitragem e abre um WebSocket de mais de mil
        // streams que este motor nunca lê. Ver connectForSymbols().
        // Tolerante de propósito: com dezenas de moedas pequenas, uma
        // deslistagem é questão de tempo, e derrubar o motor inteiro por causa
        // dela deixaria todas as outras paradas junto. O que sumiu aparece
        // como aviso no boot, nunca em silêncio.
        const usaveis = new Set(await exchange.connectForSymbols(cfg.symbols.map(paraPar), { ignorarDesconhecidos: true }));
        cfg.symbols = cfg.symbols.filter((s) => usaveis.has(paraPar(s)));
        // A taxa real da conta manda: cobrar 0,075% de papel numa conta SEM
        // desconto de BNB (0,1% de verdade) subestimaria o custo em um terço
        // em toda operação — e é o custo que decide se a estratégia vive.
        //
        // Precisa ir para CADA livro: `cfg.strategy` e `cfg.livros` são objetos
        // distintos (duas chamadas separadas a resolveStrategyParams), e são os
        // livros que calculam o resultado. Escrever só em `cfg.strategy`
        // acertaria o log de boot e deixaria a contabilidade errada.
        const taxaReal = exchange.getFeeRate();
        cfg.strategy.feeRate = taxaReal;
        for (const livro of cfg.livros) livro.feeRate = taxaReal;

        // O caixa CONFIGURADO contra o caixa que EXISTE.
        //
        // Sem isto o motor confia em DIRECTIONAL_CAPITAL e nunca confere se o
        // dinheiro está lá. Aconteceu de verdade: a conta tinha 20 USDT, mas
        // todos em Earn — a carteira Spot estava zerada. O motor subiu em modo
        // LIVE, anunciou capital de $20 e ficou horas "operando" contra nada.
        // Nenhuma ordem chegou a ser tentada, então nem o erro da corretora
        // apareceu: o log parecia perfeitamente saudável.
        //
        // Grita e segue, em vez de recusar subir: VENDER não precisa de USDT, e
        // um livro com posição aberta ainda precisa do motor para gerenciar o
        // stop. Derrubar aqui deixaria posição real sem vigilância.
        try {
            const caixaReal = await exchange.fetchAvailableBalance('USDT');
            if (caixaReal.lessThan(cfg.capital)) {
                log.error('CAIXA REAL MENOR QUE O CONFIGURADO — as compras vão ser recusadas pela Binance.', {
                    configurado: `$${cfg.capital.toFixed(2)} (DIRECTIONAL_CAPITAL)`,
                    realNoSpot: `$${caixaReal.toFixed(2)} de USDT`,
                    faltam: `$${cfg.capital.minus(caixaReal).toFixed(2)}`,
                    causaMaisComum:
                        'O dinheiro está em outra carteira. Earn, Fundos e Margem NÃO contam como saldo Spot — ' +
                        'resgate para o Spot antes de operar.',
                    oQueVaiAcontecer:
                        caixaReal.lessThan(cfg.strategy.minNotional)
                            ? 'Com esse saldo NENHUMA compra passa. Vender continua funcionando.'
                            : 'Compras acima do saldo real vão ser recusadas uma a uma.',
                });
            } else {
                log.info('Caixa real conferido contra o configurado.', {
                    configurado: `$${cfg.capital.toFixed(2)}`,
                    realNoSpot: `$${caixaReal.toFixed(2)}`,
                });
            }
        } catch (err) {
            // Não poder conferir não é o mesmo que estar tudo certo.
            log.warn('Não foi possível conferir o caixa real em USDT; seguindo com o valor configurado.', {
                configurado: cfg.capital.toFixed(2),
                erro: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * O mínimo por ordem que vale para CADA ativo: o maior entre o configurado
     * e o que a Binance realmente exige naquele símbolo.
     *
     * Sem isto o motor dimensiona pelo mínimo configurado (US$ 5 por padrão) e,
     * onde a corretora exige mais, a ordem é recusada no servidor — uma
     * rejeição por sinal, sem que nada no motor explique o motivo.
     */
    const minNotionalDe = (symbol: string): Decimal => {
        const daCorretora = exchange?.getSymbolMinNotional(paraPar(symbol));
        return daCorretora && daCorretora.greaterThan(cfg.strategy.minNotional)
            ? daCorretora
            : cfg.strategy.minNotional;
    };
    // O teto do boot usa o ativo mais exigente: se o livro não cobre esse, há
    // ativo na lista que nunca vai operar.
    const minNotionalMaisAlto = cfg.symbols.reduce(
        (acc, sym) => Decimal.max(acc, minNotionalDe(sym)),
        cfg.strategy.minNotional,
    );

    // Os valores EFETIVOS, não o nome do preset: é a diferença entre saber o
    // que o motor vai fazer e confiar que a variável certa foi digitada.
    const { nome: presetEmUso } = resolverPreset();
    log.info(`Configuração de entrada em uso (preset "${presetEmUso}", valores efetivos).`, {
        rsiAbaixoDe: cfg.strategy.rsiThreshold.toString(),
        filtroDeTendencia:
            cfg.strategy.trendPeriod > 0
                ? `média de ${cfg.strategy.trendPeriod} — só compra acima dela`
                : 'DESLIGADO — compra também em mercado de queda, onde as três famílias mediram prejuízo',
        rompimentoDeMaximaDe: `${cfg.strategy.breakoutLookback} velas`,
        volumeMinimo: `${cfg.strategy.minVolumeRatio}x a média`,
        riscoPorOperacao: `${cfg.strategy.riskFraction.mul(100).toFixed(2)}%`,
        stop: `${cfg.strategy.atrStopMultiplier}x ATR`,
    });

    if (cfg.alavancagem.greaterThan(1)) {
        // O custo por operação é sobre o CAPITAL, não sobre o nocional, e é
        // esse número que decide se alavancar ajuda. A 5x, 0,075% por perna
        // vira 0,75% do capital por operação completa: cerca de 130 operações
        // consomem a conta em pedágio, sem ter perdido nenhuma.
        const custo = custoDeIdaEVoltaSobreCapital(cfg.alavancagem, cfg.strategy.feeRate);
        log.warn(`*** ALAVANCAGEM ${cfg.alavancagem}x NA MARGEM CRUZADA — existe LIQUIDAÇÃO. ***`, {
            poderDeCompra: `$${cfg.capital.mul(cfg.alavancagem).toFixed(2)} sobre $${cfg.capital.toFixed(2)} de patrimônio`,
            custoPorOperacao: `${custo.mul(100).toFixed(3)}% do capital (ida e volta)`,
            operacoesAteZerarSoDeTaxa: custo.greaterThan(0) ? new Decimal(1).dividedBy(custo).floor().toString() : '—',
            voltaPara1xEm: cfg.alvoDeDesalavancagem.greaterThan(0)
                ? `$${cfg.alvoDeDesalavancagem.toFixed(2)} de patrimônio`
                : 'NUNCA (DIRECTIONAL_LEVERAGE_TARGET não definido)',
            guardaDeLiquidacao:
                'Entradas em que a liquidação chegaria antes do stop são recusadas — aparecem como ' +
                '"recusadosPorRisco" no heartbeat.',
        });
    }

    log.info(`Motor direcional iniciado em modo ${cfg.live ? 'LIVE — DINHEIRO REAL' : 'PAPEL (nenhuma ordem enviada)'}.`, {
        ativos: cfg.symbols.join(','),
        carteira: cfg.margem ? 'MARGEM CRUZADA (empresta)' : 'SPOT (dinheiro próprio)',
        alavancagem: `${cfg.alavancagem}x`,
        entrada: cfg.entradaPassiva
            ? `PASSIVA (taxa de maker), esperando até ${cfg.esperaPassivaMs}ms e atravessando se não pegar`
            : 'A MERCADO (taxa de agressor)',
        estrategias: cfg.livros.map((l) => l.entryStrategy).join(' + '),
        capitalPorEstrategia: cfg.capital.dividedBy(cfg.livros.length).toFixed(2),
        intervalo: cfg.interval,
        capital: cfg.capital.toString(),
        riscoPorOperacao: `${cfg.strategy.riskFraction.mul(100).toFixed(2)}%`,
        taxaPorPerna: `${cfg.strategy.feeRate.mul(100).toFixed(4)}%`,
        tetoPorPosicao:
            `${cfg.maxPositionFraction.mul(100).toFixed(0)}% do livro ` +
            `($${cfg.capital.dividedBy(cfg.livros.length).mul(cfg.maxPositionFraction).toFixed(2)} por posição)`,
        // Dois limites independentes, e vale o MENOR:
        //
        //   - quantas posições de tamanho mínimo cabem no livro;
        //   - quantas posições de tamanho CHEIO o teto permite (1/fração).
        //
        // Olhar só o primeiro dizia "4" com o teto em 100% — o modo de posição
        // única, onde cabe exatamente uma. Olhar só o segundo dizia "1" com
        // teto de 34% num livro que comporta duas.
        posicoesSimultaneasPossiveis: Decimal.min(
            cfg.capital.dividedBy(cfg.livros.length).dividedBy(minNotionalMaisAlto).floor(),
            cfg.maxPositionFraction.greaterThan(0) ? new Decimal(1).dividedBy(cfg.maxPositionFraction).floor() : new Decimal(1),
        ).toString(),
        saidaPorTempo:
            (cfg.strategy.maxBarrasNaOperacao ?? 0) > 0
                ? `${cfg.strategy.maxBarrasNaOperacao} barras de ${cfg.interval} sem cobrir a própria taxa`
                : 'desligada',
    });
    if (cfg.live) {
        log.warn('*** ORDENS REAIS SERÃO ENVIADAS. Perda é resultado possível sem nenhuma falha técnica. ***');
    }
    // Dividir capital entre famílias reduz o livro de cada uma, e um livro
    // abaixo do notional mínimo da corretora recusa TUDO em silêncio — o motor
    // pareceria vivo e nunca operaria. Melhor dizer isso no boot.
    const livroPorFamilia = cfg.capital.dividedBy(cfg.livros.length).mul(cfg.maxPositionFraction);
    // A comparação é contra o mínimo COM FOLGA, não contra o mínimo exato, e a
    // folga é a parte que importa: esta checagem roda sobre o capital
    // CONFIGURADO, enquanto o dimensionamento usa o patrimônio REAL, que cai a
    // cada operação perdida. Com teto em 25% e $20,00, o teto dá exatos $5,00 e
    // esta checagem passa — e uma única perda de um centavo derruba o teto para
    // $4,99, travando o motor para sempre sem que este aviso jamais dispare.
    const comFolga = minNotionalMaisAlto.mul('1.2');
    if (livroPorFamilia.lessThan(comFolga)) {
        const jaTravado = livroPorFamilia.lessThan(minNotionalMaisAlto);
        const dizer = jaTravado ? log.error : log.warn;
        dizer(
            jaTravado
                ? `Cada família fica com $${livroPorFamilia.toFixed(2)} por posição, abaixo do mínimo da ` +
                      `corretora ($${minNotionalMaisAlto.toFixed(2)}). NENHUMA ordem vai passar.`
                : `Cada família fica com $${livroPorFamilia.toFixed(2)} por posição, contra um mínimo de ` +
                      `$${minNotionalMaisAlto.toFixed(2)}. Passa por pouco: o teto é calculado sobre o ` +
                      `patrimônio, que CAI a cada operação perdida — e ao cruzar o mínimo o motor para de ` +
                      `abrir posição sem gerar erro nenhum.`,
            {
                oQueFazer:
                    `Rode menos famílias (DIRECTIONAL_STRATEGY), aumente DIRECTIONAL_CAPITAL para pelo menos ` +
                    `$${minNotionalMaisAlto.mul(cfg.livros.length).dividedBy(cfg.maxPositionFraction).toFixed(2)}, ` +
                    `ou suba DIRECTIONAL_MAX_POSITION_FRACTION.`,
            },
        );
    }

    /**
     * Entra como MAKER e, se não preencher a tempo, ATRAVESSA a mercado.
     *
     * A economia é real — taxa de quem espera em vez de taxa de quem atravessa
     * — mas o motivo de atravessar no vencimento é mais importante que ela:
     * ordem passiva preenche preferencialmente quando o mercado vem contra
     * (seleção adversa), e deixa de preencher justamente quando o preço
     * dispara, que é a operação que paga a estratégia. Esperar até preencher
     * economizaria taxa e perderia os melhores negócios.
     *
     * Devolve sempre a VERDADE sobre o que foi executado. Um erro aqui não
     * estoura: vira posição fantasma (o livro acha que comprou e não comprou)
     * ou órfã (comprou e o livro não sabe).
     */
    const entrarComoMaker = async (
        exchange: BinanceExchangeProvider,
        familia: string,
        symbol: string,
        quantidade: Decimal,
        comEmprestimo: boolean,
    ): Promise<{ executedPrice: Decimal; executedQty: Decimal }> => {
        const par = paraPar(symbol);
        const atravessar = async () => {
            const fill = await exchange.executeOrder(par, 'BUY', 'MARKET', quantidade, undefined, { comEmprestimo });
            return { executedPrice: fill.executedPrice, executedQty: fill.executedQty };
        };

        const tickSize = exchange.getSymbolTickSize(par);
        if (!tickSize) return atravessar();

        const { melhorCompra, melhorVenda } = await exchange.fetchBookTicker(par);
        const preco = precoDaCompraPassiva({ melhorCompra, melhorVenda, tickSize });
        if (!preco) {
            // Book cruzado ou vazio: não dá para ser passivo sem inventar preço.
            return atravessar();
        }

        const enviada = await exchange.placeMakerBuy(par, quantidade, preco, { comEmprestimo });
        const inicio = Date.now();
        let status = enviada.status;
        let preenchido = enviada.executedQty;
        let quoteGasto = new Decimal(0);

        for (;;) {
            const decisao = decidirEntradaPassiva({
                status,
                preenchido,
                msDecorridos: Date.now() - inicio,
                msDeEspera: cfg.esperaPassivaMs,
                atravessarNoVencimento: true,
            });

            if (decisao.acao === 'aguardar') {
                await new Promise((r) => setTimeout(r, 1000));
                const atual = await exchange.fetchOrder(par, enviada.orderId);
                status = atual.status;
                preenchido = atual.executedQty;
                quoteGasto = atual.cummulativeQuoteQty;
                continue;
            }

            if (decisao.acao === 'assumir-preenchida' || decisao.acao === 'assumir-parcial') {
                if (quoteGasto.lessThanOrEqualTo(0) || preenchido.lessThanOrEqualTo(0)) {
                    const atual = await exchange.fetchOrder(par, enviada.orderId);
                    preenchido = atual.executedQty;
                    quoteGasto = atual.cummulativeQuoteQty;
                }
                if (preenchido.lessThanOrEqualTo(0)) return atravessar();
                log.info(`[${familia}] ${symbol}: entrada PASSIVA preenchida (taxa de maker).`, {
                    preco: quoteGasto.dividedBy(preenchido).toFixed(8),
                    quantidade: preenchido.toString(),
                });
                return { executedPrice: quoteGasto.dividedBy(preenchido), executedQty: preenchido };
            }

            // Cancelar e atravessar. O cancelamento pode falhar porque a ordem
            // acabou de preencher — por isso o que vale é o que ele devolve, e
            // não se ele deu certo.
            if (enviada.orderId > 0) {
                const aposCancelar = await exchange.cancelOrder(par, enviada.orderId);
                if (aposCancelar.executedQty.greaterThan(0)) {
                    log.info(`[${familia}] ${symbol}: preencheu durante o cancelamento; ficando com a posição.`, {
                        quantidade: aposCancelar.executedQty.toString(),
                    });
                    return {
                        executedPrice: aposCancelar.cummulativeQuoteQty.dividedBy(aposCancelar.executedQty),
                        executedQty: aposCancelar.executedQty,
                    };
                }
            }
            log.info(`[${familia}] ${symbol}: entrada passiva não pegou — atravessando a mercado.`, {
                motivo: decisao.acao === 'cancelar-e-atravessar' ? decisao.motivo : 'prazo vencido',
            });
            return atravessar();
        }
    };

    /**
     * Um LIVRO por família de entrada: posições, capital e placar próprios.
     *
     * Separar é o ponto de rodar as duas ao mesmo tempo. Num livro só, o
     * resultado de uma esconderia o da outra e a comparação — que é o motivo de
     * rodar as duas — desapareceria. Cada uma recebe uma fatia igual do
     * capital, então elas competem em pé de igualdade.
     */
    const estadoSalvo = loadState(cfg.stateFile);
    // Adotar posição órfã é decisão de quem opera: o motor não sabe o preço
    // pago e vai medir o resultado a partir de agora, o que distorce o placar.
    // Ainda assim é melhor que deixá-la sem stop — mas quem escolhe é você.
    const adoptOrphans = process.env.DIRECTIONAL_ADOPT_ORPHANS === 'true';
    // Vender a órfã em vez de adotá-la. Existe porque o problema mais urgente
    // de uma órfã numa conta pequena não é ela estar sem stop — é ela estar
    // segurando o colateral inteiro, o que faz TODA ordem nova ser recusada
    // pela corretora. Adotar resolve o stop e mantém o bloqueio; liquidar
    // devolve a conta ao operador.
    const liquidarOrfas = process.env.DIRECTIONAL_CLOSE_ORPHANS === 'true';
    /**
     * O que a corretora disse que empresta, na última consulta do ciclo.
     *
     * Fica AQUI, fora dos livros, porque a capacidade é da CONTA e não de cada
     * família: dois livros pedindo empréstimo disputam o mesmo colateral. Uma
     * consulta por ciclo, servida a todos.
     *
     * Começa em zero de propósito. Zero significa "opera à vista", que é o
     * comportamento seguro enquanto a resposta não chegou — o contrário
     * (assumir a alavancagem cheia até ser desmentido) é justamente o que
     * produz uma rodada inteira de ordens recusadas.
     */
    let capacidadeDeEmprestimo = new Decimal(0);

    /**
     * O USDT que a CORRETORA diz estar livre, na última consulta do ciclo.
     *
     * O motor mantém o próprio caixa (patrimônio menos margem comprometida), e
     * esse número é uma MODELAGEM: ele assume que cada posição imobilizou
     * exatamente `nocional / alavancagem`. Quando a alavancagem efetiva de uma
     * entrada difere da que o modelo supõe — e ela difere, porque agora depende
     * da capacidade de empréstimo do momento —, os dois divergem em silêncio.
     *
     * A divergência não gera erro nenhum até a ordem sair: aí a Binance recusa
     * com `-2010 insufficient balance` enquanto o log anuncia caixa livre de
     * sobra. O princípio já escrito neste projeto vale aqui também — a
     * corretora é a fonte da verdade, não o arquivo de estado.
     *
     * `null` = ainda não consultado (ou consulta falhou): usa só o modelo.
     */
    let saldoRealLivre: Decimal | null = null;

    const criarLivro = (params: ResolvedStrategyParams, capitalInicial: Decimal) => {
    const salvo = estadoSalvo[params.entryStrategy];
    const positions = new Map<string, OpenPosition>();
    let capital = salvo ? new Decimal(salvo.capital) : capitalInicial;
    let realizedPnl = new Decimal(salvo?.realizedPnl ?? '0');
    let wins = salvo?.wins ?? 0;
    let losses = salvo?.losses ?? 0;
    // Somas separadas de ganho e perda. A taxa de acerto sozinha não decide
    // nada: 40% de acerto com ganho 3x é lucrativo, 90% com perda 10x quebra.
    // O que decide é ganho médio contra perda média, e sem estes dois números
    // o heartbeat não permite comparar o papel com o backtest.
    let somaGanhos = new Decimal(salvo?.somaGanhos ?? '0');
    let somaPerdas = new Decimal(salvo?.somaPerdas ?? '0');
    const excursao = { medidas: 0, ...(salvo?.excursaoMaxima ?? {}), r1: salvo?.excursaoMaxima?.r1 ?? 0, r2: salvo?.excursaoMaxima?.r2 ?? 0, r3: salvo?.excursaoMaxima?.r3 ?? 0, r5: salvo?.excursaoMaxima?.r5 ?? 0 };
    /**
     * Dinheiro preso nas posições abertas. Sem isto, cada ativo dimensionaria
     * contra o capital TOTAL e quatro posições simultâneas comprometeriam
     * quatro vezes o dinheiro que existe — alavancagem acidental.
     */
    let committed = new Decimal(salvo?.committed ?? '0');
    if (salvo) {
        for (const p of salvo.positions) {
            positions.set(p.symbol, {
                symbol: p.symbol,
                entryPrice: new Decimal(p.entryPrice),
                quantity: new Decimal(p.quantity),
                notional: new Decimal(p.notional),
                // Estado antigo não tem o campo, e não ter significa spot: lá
                // a margem É o nocional.
                margemUsada: new Decimal(p.margemUsada ?? p.notional),
                adotada: p.adotada,
                // Estado antigo não tem o campo: reconstrói a partir do stop
                // atual. Fica maior que o R original se o stop já subiu, e o
                // efeito é um alvo mais distante — conservador, que é o lado
                // certo de errar quando o dado se perdeu.
                initialRisk: new Decimal(p.initialRisk ?? new Decimal(p.entryPrice).minus(p.stopPrice).toString()),
                stopPrice: new Decimal(p.stopPrice),
                highestSinceEntry: new Decimal(p.highestSinceEntry),
                openedAt: p.openedAt,
            });
        }
        log.info(`[${params.entryStrategy}] Estado recuperado do disco.`, {
            capital: capital.toFixed(6),
            posicoesReabertas: positions.size,
            ativos: Array.from(positions.keys()).join(',') || 'nenhum',
        });
    }
    /**
     * Censo do ciclo: por que NÃO houve entrada.
     *
     * Sem isto o heartbeat mostra zeros para sempre e não dá para distinguir
     * "o mercado não ofereceu sinal" de "o motor está recusando tudo" — foi
     * exatamente essa cegueira que deixou o motor de arbitragem rodando um dia
     * inteiro com capital zero parecendo saudável. Zeros só são boa notícia
     * quando dá para ver o que os produziu.
     */
    const diagnostico = new Map<string, string>();
    let sinaisDisparados = 0;
    let bloqueadosPorTendencia = 0;
    let barradosPorTaxa = 0;
    let recusadosPorRisco = 0;
    /** Fecha a última vela já processada por símbolo — evita reavaliar a mesma. */
    const lastSeenCandle = new Map<string, number>();

    const closePosition = async (pos: OpenPosition, price: Decimal, reason: string) => {
        let exitPrice = price;
        if (exchange) {
            const fill = await exchange.executeOrder(paraPar(pos.symbol), 'SELL', 'MARKET', pos.quantity);
            // Ordem a mercado quase nunca sai no preço planejado. Registrar o
            // preço pretendido em vez do executado produziria um histórico
            // otimista justamente nas saídas por stop, que são as que
            // escorregam mais.
            if (fill.executedPrice.greaterThan(0)) exitPrice = fill.executedPrice;
        }
        const { netProfit, feesPaid } = tradeNetPnl(pos.entryPrice, exitPrice, pos.quantity, params.feeRate);
        // O dinheiro preso na posição volta ao caixa, junto com o resultado.
        committed = committed.minus(pos.margemUsada);
        if (committed.lessThan(0)) committed = new Decimal(0);
        capital = capital.plus(netProfit);
        realizedPnl = realizedPnl.plus(netProfit);
        if (netProfit.greaterThan(0)) {
            wins += 1;
            somaGanhos = somaGanhos.plus(netProfit);
        } else {
            losses += 1;
            somaPerdas = somaPerdas.plus(netProfit.abs());
        }
        positions.delete(pos.symbol);
        log.info(`[${params.entryStrategy}] SAÍDA ${pos.symbol} — ${reason}`, {
            entrada: pos.entryPrice.toFixed(6),
            saida: exitPrice.toFixed(6),
            quantidade: pos.quantity.toString(),
            resultadoLiquido: netProfit.toFixed(6),
            taxasPagas: feesPaid.toFixed(6),
            capital: capital.toFixed(6),
            ...(pos.adotada
                ? {
                      atencao:
                          'posição ADOTADA: o resultado acima é medido desde a adoção, não desde a compra real. ' +
                          'O lucro ou prejuízo verdadeiro na corretora é outro.',
                  }
                : {}),
        });
        // O diagnóstico do ativo tem que refletir a SAÍDA na hora. Sem isto ele
        // continua dizendo "em posição" até o próximo sinal daquele símbolo —
        // e o heartbeat mostra uma posição fechada como se estivesse aberta,
        // contradizendo a própria lista de posicoesAbertas na mesma linha.
        // Até onde ela CHEGOU antes de fechar, em múltiplos do risco inicial.
        // O preço máximo já é acompanhado para o stop móvel; aqui ele vira
        // medição. Com stop móvel a saída quase nunca acontece no topo, então
        // este número diz o que um ALVO teria capturado e a saída real não.
        // Posição ADOTADA fica FORA da medição. O preço de entrada dela é o do
        // momento da adoção, não o que foi pago: a excursão em R sairia medida
        // a partir do meio da operação, e o número que decide o preset seria
        // contaminado justamente pelos casos em que o motor menos sabe.
        if (pos.initialRisk.greaterThan(0) && !pos.adotada) {
            // Contado à parte do placar de ganhos e perdas de propósito. O
            // placar veio do disco e inclui operações fechadas ANTES desta
            // medição existir; usá-lo como denominador transformaria "ainda
            // não medi nada" em "nenhuma chegou a 1R", que é uma conclusão
            // sobre a estratégia tirada de código que nem estava rodando.
            excursao.medidas += 1;
            const emR = pos.highestSinceEntry.minus(pos.entryPrice).dividedBy(pos.initialRisk);
            if (emR.greaterThanOrEqualTo(1)) excursao.r1 += 1;
            if (emR.greaterThanOrEqualTo(2)) excursao.r2 += 1;
            if (emR.greaterThanOrEqualTo(3)) excursao.r3 += 1;
            if (emR.greaterThanOrEqualTo(5)) excursao.r5 += 1;
        }
        diagnostico.set(
            pos.symbol,
            `SAÍDA ${netProfit.greaterThanOrEqualTo(0) ? '+' : ''}$${netProfit.toFixed(4)} (${reason})`,
        );
    };

    /** Símbolos já reconciliados contra o saldo real da corretora. */
    const reconciliados = new Set<string>();

    /**
     * Confere o estado do livro contra o SALDO REAL da corretora.
     *
     * O arquivo de estado protege contra reinício do processo; não protege
     * contra o arquivo se perder (container novo sem volume), contra alguém
     * vender pela interface da Binance, nem contra uma ordem que foi executada
     * enquanto o motor estava fora do ar. Em todos esses casos o livro e a
     * realidade divergem — e a divergência não gera erro: o motor simplesmente
     * deixa de vigiar uma posição que existe, ou vigia uma que não existe mais.
     *
     * A corretora é a única fonte da verdade sobre o que se tem. Isto roda uma
     * vez por símbolo, no primeiro ciclo em que há preço disponível.
     */
    const reconcile = async (symbol: string, price: Decimal, atrValue: Decimal | null) => {
        if (!exchange || reconciliados.has(symbol)) return;
        reconciliados.add(symbol);

        const asset = symbol.replace(/USDT$/, '');
        const saldo = await exchange.fetchAvailableBalance(asset);
        const valor = saldo.mul(price);
        const pos = positions.get(symbol);
        const acao = decideReconcile({
            temPosicaoNoLivro: pos !== undefined,
            valorDoSaldo: valor,
            minNotional: minNotionalDe(symbol),
            podeAdotar: adoptOrphans && atrValue !== null,
            podeLiquidar: liquidarOrfas,
        });
        if (acao === 'nada') return;

        if (pos && acao === 'remover-fantasma') {
            // O livro acha que tem posição, a corretora diz que não. Manter
            // seria vigiar um fantasma e bloquear o caixa para sempre.
            log.warn(`[${params.entryStrategy}] ${symbol}: posição no estado não existe na corretora — removida.`, {
                quantidadeNoEstado: pos.quantity.toString(),
                saldoReal: saldo.toString(),
                causaProvavel: 'venda manual, ou ordem executada com o motor fora do ar',
            });
            committed = committed.minus(pos.margemUsada);
            if (committed.lessThan(0)) committed = new Decimal(0);
            positions.delete(symbol);
            return;
        }

        if (!pos && acao === 'liquidar-orfa') {
            // Vender a órfã. O que se resolve aqui não é a falta de stop — é o
            // COLATERAL preso: numa conta pequena e alavancada, uma posição
            // que o motor não conhece segura o dinheiro inteiro, e a corretora
            // passa a recusar toda ordem nova. O motor fica vivo, gerando
            // sinal, e levando não em todos eles.
            //
            // Em margem a venda sai com AUTO_REPAY, então a dívida é quitada
            // pela própria operação.
            //
            // O livro NÃO é creditado: esta posição nunca esteve nele, e somar
            // o resultado dela ao placar contaria um lucro que a estratégia não
            // produziu.
            log.warn(`[${params.entryStrategy}] ${symbol}: órfã encontrada — VENDENDO para liberar o colateral.`, {
                quantidade: saldo.toString(),
                valorAproximado: `$${valor.toFixed(2)}`,
                porque:
                    'DIRECTIONAL_CLOSE_ORPHANS=true. O resultado desta venda NÃO entra no placar do livro — ' +
                    'a posição nunca esteve nele.',
            });
            try {
                const venda = await exchange.executeOrder(paraPar(symbol), 'SELL', 'MARKET', saldo);
                log.info(`[${params.entryStrategy}] ${symbol}: órfã vendida. Colateral liberado.`, {
                    quantidadeVendida: venda.executedQty.toString(),
                    precoMedio: venda.executedPrice.toFixed(8),
                });
            } catch (err) {
                // Reconciliação roda uma vez por símbolo; se a venda falhar,
                // liberar a marca faz a próxima passada tentar de novo em vez
                // de deixar a órfã parada para sempre.
                reconciliados.delete(symbol);
                log.error(`[${params.entryStrategy}] ${symbol}: NÃO foi possível vender a órfã — ela continua lá.`, {
                    erro: err instanceof Error ? err.message : String(err),
                    oQueFazer: 'Venda manualmente na Binance, ou confira se a chave tem permissão de trading.',
                });
            }
            return;
        }

        if (!pos) {
            // Existe posição de verdade que o motor não conhece: sem stop, sem
            // ninguém olhando. É o cenário mais perigoso possível.
            if (acao === 'alertar-orfa' || !atrValue) {
                log.error(
                    `[${params.entryStrategy}] ${symbol}: SALDO SEM POSIÇÃO NO ESTADO — ` +
                        `${saldo.toString()} ${asset} (~${valor.toFixed(2)} USDT) sem stop nenhum.`,
                    {
                        oQueFazer:
                            'Venda manualmente na Binance, OU rode com DIRECTIONAL_ADOPT_ORPHANS=true ' +
                            'para o motor adotar a posição com stop em ATR a partir do preço atual.',
                        porque: 'Posição que o motor não conhece é posição sem stop. Ignorar em silêncio é o pior caminho.',
                    },
                );
                return;
            }
            const stop = price.minus(atrValue.mul(params.atrStopMultiplier));
            const notional = saldo.mul(price);
            // Posição órfã: o motor não sabe com que alavancagem ela foi
            // aberta. Assume o nocional inteiro como dinheiro próprio, que é o
            // lado conservador — reserva MAIS caixa do que talvez precise, em
            // vez de liberar caixa que não existe e permitir uma entrada a
            // mais do que a conta suporta.
            committed = committed.plus(notional);
            positions.set(symbol, {
                symbol,
                entryPrice: price,
                quantity: saldo,
                notional,
                margemUsada: notional,
                initialRisk: price.minus(stop),
                stopPrice: stop,
                highestSinceEntry: price,
                openedAt: Date.now(),
                adotada: true,
            });
            log.warn(`[${params.entryStrategy}] ${symbol}: posição órfã ADOTADA com stop novo.`, {
                quantidade: saldo.toString(),
                precoDeReferencia: price.toFixed(6),
                stop: stop.toFixed(6),
                aviso:
                    'O preço de entrada real é desconhecido: o resultado desta operação será medido a partir de agora, ' +
                    'não do que foi pago. O que importa é que ela passa a ter stop.',
            });
        }
    };

    const step = async (symbol: string, candles: Candle[]) => {
        if (candles.length < params.trendPeriod + params.atrPeriod + 5) return;
        const last = candles.length - 1;
        const candle = candles[last];
        // Uma avaliação por vela fechada. Nos ciclos entre um fechamento e o
        // seguinte não há decisão nova a tomar, e o diagnóstico exibido no
        // heartbeat continua sendo o da última vela — por isso o heartbeat diz
        // de quando ele é, em vez de deixar parecer leitura do instante.
        if (lastSeenCandle.get(symbol) === candle.openTime) return;
        lastSeenCandle.set(symbol, candle.openTime);

        // Antes de qualquer decisão: o livro bate com a corretora?
        await reconcile(symbol, candle.close, atr(candles, last, params.atrPeriod));

        const pos = positions.get(symbol);
        if (pos) {
            diagnostico.set(symbol, `em posição (stop ${pos.stopPrice.toFixed(2)})`);
            // Stop pela MÍNIMA da vela, igual ao backtest: se furou no meio do
            // caminho, a posição acabou ali.
            if (candle.low.lessThanOrEqualTo(pos.stopPrice)) {
                await closePosition(pos, pos.stopPrice, 'stop atingido');
                return;
            }
            const alvo =
                params.takeProfitR && params.takeProfitR.greaterThan(0) && pos.initialRisk.greaterThan(0)
                    ? pos.entryPrice.plus(pos.initialRisk.mul(params.takeProfitR))
                    : null;
            if (alvo && candle.high.greaterThanOrEqualTo(alvo)) {
                // Depois do stop, nunca antes: quando a vela toca os dois, o
                // OHLC não diz qual veio primeiro, e supor o alvo seria escolher
                // a versão que favorece o resultado.
                await closePosition(pos, alvo, `alvo de ${params.takeProfitR!.toString()}R atingido`);
                return;
            }
            // Saída por TEMPO, por ÚLTIMO entre as saídas: stop e alvo dizem o
            // que o preço fez; o relógio só decide onde nenhum dos dois
            // decidiu. Barras contadas pelo RELÓGIO, não por ciclo do motor —
            // com poll de 30s num gráfico de 15m, contar ciclos mediria
            // quantas vezes o motor olhou, não quanto tempo passou.
            const porTempo = decidirSaidaPorTempo({
                barrasSeguradas: barrasDesde(pos.openedAt, candle.openTime, cfg.interval),
                maxBarras: params.maxBarrasNaOperacao ?? 0,
                variacaoDesdeEntrada: candle.close.minus(pos.entryPrice).dividedBy(pos.entryPrice),
                taxaPorPerna: params.feeRate,
            });
            if (porTempo.sair) {
                await closePosition(pos, candle.close, `saída por tempo — ${porTempo.motivo}`);
                return;
            }
            if (candle.high.greaterThan(pos.highestSinceEntry)) pos.highestSinceEntry = candle.high;
            const currentAtr = atr(candles, last, params.atrPeriod);
            if (currentAtr) {
                pos.stopPrice = updateTrailingStopAtr(
                    pos.stopPrice,
                    pos.highestSinceEntry,
                    currentAtr,
                    params.trailAtrMultiplier,
                );
            }
            return;
        }

        const signal =
            params.entryStrategy === 'momentum'
                ? detectMomentumSurge(
                      candles,
                      last,
                      params.breakoutLookback,
                      params.atrPeriod,
                      params.volumePeriod ?? 20,
                      params.minVolumeRatio ?? new Decimal('3'),
                  )
                : params.entryStrategy === 'reversion'
                ? detectOversoldReversion(candles, last, rsiSeries(candles, params.rsiPeriod), params.rsiThreshold, params.atrPeriod)
                : detectBreakout(candles, last, params.breakoutLookback, params.atrPeriod);
        const rsiAtual =
            params.entryStrategy === 'reversion' && 'rsiValue' in signal && signal.rsiValue
                ? signal.rsiValue.toFixed(1)
                : null;

        if (!signal.triggered || signal.atrValue === null) {
            diagnostico.set(
                symbol,
                rsiAtual !== null
                    ? `sem sinal (RSI ${rsiAtual}, precisa < ${params.rsiThreshold} e já subindo)`
                    : 'reason' in signal && signal.reason
                    ? `sem sinal (${signal.reason})`
                    : 'sem sinal',
            );
            return;
        }
        sinaisDisparados += 1;

        // Antes dos outros filtros: esta mesa paga a taxa? Recusar aqui é
        // econômico, não tem a ver com o sinal estar certo. Um ativo cuja vela
        // típica anda menos que alguns múltiplos do pedágio é impossível de
        // ganhar no longo prazo, por melhor que seja a entrada.
        const taxaOk = operacaoValeATaxa({
            atr: signal.atrValue,
            preco: candle.close,
            taxaPorPerna: params.feeRate,
            minimoEmTaxas: params.minAtrEmTaxas ?? new Decimal(0),
        });
        if (!taxaOk.vale) {
            barradosPorTaxa += 1;
            diagnostico.set(symbol, `SINAL barrado por não pagar a taxa: ${taxaOk.motivo}`);
            return;
        }

        if (params.trendPeriod > 0) {
            const closes = candles.map((c) => c.close);
            if (isAboveTrend(closes, last, params.trendPeriod) !== true) {
                bloqueadosPorTendencia += 1;
                // Comprar queda dentro de tendência de baixa é comprar algo que
                // cai porque continua caindo. O filtro barrar é o filtro
                // funcionando, não um problema a ser afrouxado sem medir.
                diagnostico.set(symbol, `SINAL barrado pelo filtro de tendência (abaixo da média de ${params.trendPeriod})`);
                return;
            }
        }

        // Entrada ao preço corrente. No backtest é a abertura da vela seguinte;
        // ao vivo, a vela seguinte é AGORA, e seu preço corrente é o melhor
        // equivalente disponível.
        const entryPrice = candle.close;
        const stopPrice = entryPrice.minus(signal.atrValue.mul(params.atrStopMultiplier));

        // A alavancagem é reavaliada A CADA ENTRADA, pelo patrimônio corrente.
        // Decidir uma vez no boot deixaria a conta alavancada por horas depois
        // de já ter passado do alvo.
        const alavancagemPedida = alavancagemEfetiva({
            patrimonio: capital,
            alvo: cfg.alvoDeDesalavancagem,
            alavancagemMaxima: cfg.alavancagem,
        });
        // E a alavancagem que a corretora financia, que é outra coisa. Sem
        // este teto o motor dimensiona pelo pedido, a Binance recusa com
        // -3006, e o ciclo inteiro vira recusa: caixa livre no log, nenhuma
        // ordem aceita. Com ele, a posição só encolhe.
        const alavancagem = alavancagemSustentada({
            caixaProprio: capitalDeTrabalho({ patrimonio: capital, teto: cfg.tetoDeCapital }).minus(committed),
            maximoEmprestavel: capacidadeDeEmprestimo,
            alavancagemDesejada: alavancagemPedida,
        });

        // O guarda que só existe alavancado: se a liquidação chega antes do
        // stop, o risco calculado abaixo é ficção — a perda seria a margem
        // inteira. Recusar aqui é a diferença entre arriscar 2% e arriscar
        // tudo. À vista nunca recusa (não existe liquidação no spot).
        const veredicto = stopDisparaAntesDaLiquidacao({
            distanciaDoStop: entryPrice.minus(stopPrice).dividedBy(entryPrice),
            alavancagem,
        });
        if (!veredicto.seguro) {
            recusadosPorRisco += 1;
            diagnostico.set(symbol, `SINAL recusado: ${veredicto.motivo}`);
            log.warn(`[${params.entryStrategy}] ${symbol}: sinal válido recusado pelo guarda de liquidação.`, {
                motivo: veredicto.motivo,
            });
            return;
        }

        // O que pode ser arriscado, não o que existe: acima do teto o excedente
        // está congelado e não financia posição nova.
        const capitalOperacional = capitalDeTrabalho({ patrimonio: capital, teto: cfg.tetoDeCapital });
        // O caixa que o motor ACHA que tem, e o que a corretora diz existir. O
        // menor dos dois manda: dimensionar pelo modelo quando a carteira tem
        // menos produz ordem recusada por saldo (-2010) com o log anunciando
        // caixa de sobra — o motor pareceria vivo e não operaria.
        const caixaModelado = capitalOperacional.minus(committed);
        const caixaParaDimensionar =
            saldoRealLivre !== null ? Decimal.min(caixaModelado, saldoRealLivre) : caixaModelado;
        if (saldoRealLivre !== null && saldoRealLivre.lessThan(caixaModelado.minus('0.5'))) {
            log.warn(`[${params.entryStrategy}] O caixa modelado passou do saldo real; vale o saldo real.`, {
                caixaModelado: `$${caixaModelado.toFixed(2)}`,
                saldoNaCorretora: `$${saldoRealLivre.toFixed(2)}`,
                porque:
                    'a margem imobilizada por posição é estimada como nocional/alavancagem, e a alavancagem ' +
                    'efetiva de cada entrada depende da capacidade de empréstimo do momento.',
            });
        }
        const plan = planPosition({
            capital: capitalOperacional,
            availableCapital: caixaParaDimensionar,
            maxPositionFraction: cfg.maxPositionFraction,
            riskFraction: params.riskFraction,
            entryPrice,
            stopPrice,
            minNotional: minNotionalDe(symbol),
            leverage: alavancagem,
        });
        if (plan.quantity.lessThanOrEqualTo(0)) {
            recusadosPorRisco += 1;
            diagnostico.set(symbol, `SINAL recusado pelo risco: ${plan.reason}`);
            log.warn(`[${params.entryStrategy}] ${symbol}: sinal válido mas operação recusada pelo risco.`, { motivo: plan.reason });
            return;
        }

        let filledPrice = entryPrice;
        let filledQty = plan.quantity;
        if (exchange) {
            // O rótulo da ordem tem que concordar com o tamanho dela. Sem
            // alavancagem efetiva, mandar MARGIN_BUY faz a Binance recusar a
            // ordem inteira com -3006 quando a capacidade de empréstimo está
            // zerada — ainda que o saldo próprio bastasse para pagá-la.
            const comEmprestimo = alavancagem.greaterThan(1);
            const fill = cfg.entradaPassiva
                ? await entrarComoMaker(exchange, params.entryStrategy, symbol, plan.quantity, comEmprestimo)
                : await exchange.executeOrder(paraPar(symbol), 'BUY', 'MARKET', plan.quantity, undefined, { comEmprestimo });
            if (fill.executedQty.lessThanOrEqualTo(0)) {
                // Nada preencheu e nada foi atravessado: não há posição. Sair
                // aqui é obrigatório — seguir registraria uma posição fantasma,
                // que o motor vigiaria e tentaria vender sem ter o que vender.
                diagnostico.set(symbol, 'ENTRADA passiva não preencheu e não foi atravessada.');
                return;
            }
            if (fill.executedPrice.greaterThan(0)) filledPrice = fill.executedPrice;
            filledQty = fill.executedQty;
        }
        // O stop acompanha o preço REALMENTE pago: mantê-lo ancorado no preço
        // pretendido mudaria silenciosamente a distância até o stop, e com ela
        // o risco que se aceitou correr.
        const filledStop = filledPrice.minus(signal.atrValue.mul(params.atrStopMultiplier));
        const notional = filledQty.mul(filledPrice);
        // O que fica PRESO é a margem, não o nocional: alavancado, uma posição
        // de $40 imobiliza $8 do próprio dinheiro a 5x. Somar o nocional
        // inteiro faria o motor achar que o caixa acabou e recusar as próximas
        // entradas — a alavancagem existiria na ordem e sumiria no controle.
        // Quanto do DINHEIRO PRÓPRIO esta posição consumiu.
        //
        // Não é nocional/alavancagem. MARGIN_BUY não empresta para atingir uma
        // alavancagem alvo — ela empresta só o que FALTA para completar a
        // ordem. Com $20 livres e uma ordem de $25, a Binance empresta $5 e
        // consome $20 seus, não empresta $20 e consome $5. O motor não dita a
        // alavancagem; ele dita o TAMANHO, e a alavancagem é consequência.
        //
        // Supor nocional/alavancagem fazia o motor achar que sobrava caixa que
        // já tinha sido gasto — foi assim que ele anunciou $10,13 livres com
        // $0,06 na carteira, e mandou ordens que voltaram com -2010.
        const margemUsada = Decimal.min(notional, caixaParaDimensionar);
        committed = committed.plus(margemUsada);
        diagnostico.set(symbol, 'ENTRADA executada neste ciclo');
        positions.set(symbol, {
            symbol,
            entryPrice: filledPrice,
            quantity: filledQty,
            notional,
            margemUsada,
            initialRisk: filledPrice.minus(filledStop),
            stopPrice: filledStop,
            highestSinceEntry: filledPrice,
            openedAt: Date.now(),
        });
        log.info(`[${params.entryStrategy}] ENTRADA ${symbol}`, {
            preco: filledPrice.toFixed(6),
            quantidade: filledQty.toString(),
            stop: filledStop.toFixed(6),
            riscoSeStopar: plan.riskAmount.toFixed(6),
            notional: notional.toFixed(2),
            caixaLivreRestante: capital.minus(committed).toFixed(2),
        });
    };

    return {
        params,
        step,
        /**
         * Falha de rede num ativo precisa aparecer no censo do livro. Sem isto
         * o heartbeat mostraria "aguardando fechar a vela" para um ativo que na
         * verdade não está sendo lido — silêncio que parece paciência.
         */
        marcarFalha: (symbol: string, motivo: string) => diagnostico.set(symbol, `FALHA: ${motivo}`),
        /**
         * Posições abertas com o resultado NÃO REALIZADO ao preço de agora.
         *
         * Existe porque o placar do heartbeat só conta operação FECHADA, e uma
         * posição pode ficar aberta por dias. Sem isto o log mostra zero
         * enquanto há dinheiro se movendo — que é indistinguível de estar parado.
         */
        painel: (precos: Map<string, Decimal>): string[] =>
            Array.from(positions.values()).map((p) => {
                const agora = precos.get(p.symbol);
                if (!agora) return `${p.symbol}: aberta a ${p.entryPrice.toFixed(6)} (sem preço atual)`;
                const variacao = agora.minus(p.entryPrice).dividedBy(p.entryPrice).mul(100);
                const { netProfit } = tradeNetPnl(p.entryPrice, agora, p.quantity, params.feeRate);
                const ateOStop = agora.minus(p.stopPrice).dividedBy(agora).mul(100);
                // O relógio da saída por tempo, visível. Sem ele não dá para
                // saber se uma posição parada está prestes a liberar a vaga ou
                // se vai ficar ali o dia inteiro — e é a vaga, não o prejuízo,
                // que impede as outras entradas.
                const barras = barrasDesde(p.openedAt, Date.now(), cfg.interval);
                const maxBarras = params.maxBarrasNaOperacao ?? 0;
                const relogio =
                    maxBarras > 0
                        ? ` | ${barras}/${maxBarras} barras até a saída por tempo`
                        : ` | aberta há ${barras} barras`;
                const marca = p.adotada ? ' [ADOTADA: medida desde a adoção, não desde a compra]' : '';
                return (
                    `${p.symbol}${marca}: ${p.entryPrice.toFixed(6)} → ${agora.toFixed(6)} ` +
                    `(${variacao.toFixed(2)}%) | se fechasse agora: $${netProfit.toFixed(4)} | ` +
                    `stop ${p.stopPrice.toFixed(6)} (${ateOStop.toFixed(2)}% abaixo)${relogio}`
                );
            }),
        /** Snapshot serializável — o que precisa sobreviver a um reinício. */
        snapshot: (): BookState => ({
            capital: capital.toString(),
            realizedPnl: realizedPnl.toString(),
            wins,
            losses,
            somaGanhos: somaGanhos.toString(),
            somaPerdas: somaPerdas.toString(),
            excursaoMaxima: { ...excursao },
            committed: committed.toString(),
            positions: Array.from(positions.values()).map((p) => ({
                symbol: p.symbol,
                entryPrice: p.entryPrice.toString(),
                quantity: p.quantity.toString(),
                notional: p.notional.toString(),
                margemUsada: p.margemUsada.toString(),
                ...(p.adotada ? { adotada: true } : {}),
                initialRisk: p.initialRisk.toString(),
                stopPrice: p.stopPrice.toString(),
                highestSinceEntry: p.highestSinceEntry.toString(),
                openedAt: p.openedAt,
            })),
        }),
        /**
         * Uma linha que responde "ele está trabalhando?" sem ler o JSON.
         *
         * O heartbeat completo é diagnóstico; esta linha é sinal de vida. A
         * diferença importa porque os dois estados perigosos deste motor são
         * INVISÍVEIS num log que parece saudável: sem caixa nenhum ele fica
         * eternamente "ativo" recusando todo sinal, e com falhas repetidas da
         * corretora ele fica eternamente "ativo" tentando. Nos dois casos há
         * heartbeat, timestamp novo, tudo verde — e nenhuma ordem sai.
         *
         * Por isso TRAVADO tem estado próprio em vez de virar mais um campo.
         */
        status: (): string => {
            const fechadas = wins + losses;
            const placar = `${fechadas} fechada${fechadas === 1 ? '' : 's'} (${wins}G/${losses}P), ${realizedPnl.greaterThanOrEqualTo(0) ? '+' : ''}$${realizedPnl.toFixed(4)}`;
            const caixa =
                saldoRealLivre !== null
                    ? Decimal.min(capital.minus(committed), saldoRealLivre)
                    : capital.minus(committed);
            const falhas = Array.from(diagnostico.values()).filter((d) => d.startsWith('FALHA:')).length;

            if (positions.size > 0) {
                const nomes = Array.from(positions.keys()).join(', ');
                return `${params.entryStrategy}: EM POSIÇÃO — ${nomes} | ${placar}`;
            }
            // Sem posição E sem dinheiro para abrir uma: o estado que parece
            // saudável e não é. Nomeá-lo é a única forma de distinguir "está
            // esperando o sinal certo" de "não pode agir nem que queira".
            if (caixa.lessThan(minNotionalDe(cfg.symbols[0]))) {
                return `${params.entryStrategy}: TRAVADO — sem posição e sem caixa ($${caixa.toFixed(2)}). Nenhuma ordem pode sair. | ${placar}`;
            }
            if (falhas > 0) {
                return `${params.entryStrategy}: COM FALHAS — ${falhas} ativo(s) recusados pela corretora | ${placar}`;
            }
            return `${params.entryStrategy}: CAÇANDO — $${caixa.toFixed(2)} livres, ${cfg.symbols.length} ativos vigiados | ${placar}`;
        },
        resumo: () => ({
            estrategia: params.entryStrategy,
            capital: capital.toFixed(6),
            // O caixa que vale para decidir é o menor entre o modelo e a
            // carteira. Mostrar só o modelo já escondeu uma diferença de $10.
            caixaLivre: (saldoRealLivre !== null
                ? Decimal.min(capital.minus(committed), saldoRealLivre)
                : capital.minus(committed)
            ).toFixed(6),
            caixaModelado: capital.minus(committed).toFixed(6),
            resultadoAcumulado: realizedPnl.toFixed(6),
            posicoesAbertas: positions.size,
            ativosComPosicao: Array.from(positions.keys()).join(',') || 'nenhum',
            operacoesFechadas: wins + losses,
            acertos: wins,
            erros: losses,
            ...(wins + losses > 0
                ? {
                      taxaAcerto: `${((wins / (wins + losses)) * 100).toFixed(1)}%`,
                      ganhoMedio: wins > 0 ? `$${somaGanhos.dividedBy(wins).toFixed(4)}` : '—',
                      perdaMedia: losses > 0 ? `$${somaPerdas.dividedBy(losses).toFixed(4)}` : '—',
                      // O número que reprova ou aprova. Positivo = a estratégia
                      // ganha dinheiro por operação, independente da taxa de acerto.
                      expectativaPorOperacao: `$${realizedPnl.dividedBy(wins + losses).toFixed(4)}`,
                      compareComOBacktest: 'backtest 1h/reversion mediu 39,6% de acerto e $0,0245 por operação',
                  }
                : {}),
            // Quantas operações fechadas TOCARAM cada múltiplo do risco antes
            // de sair. É o que decide, com dado, se vale trocar o stop móvel
            // por um alvo grande: um alvo de 5R precisa ser tocado em mais de
            // 1 a cada 6 operações só para empatar.
            ...(excursao.medidas > 0
                ? {
                      chegouA:
                          `de ${excursao.medidas} medida(s) — 1R: ${excursao.r1} | 2R: ${excursao.r2} | ` +
                          `3R: ${excursao.r3} | 5R: ${excursao.r5}`,
                  }
                : { chegouA: 'ainda nenhuma operação fechada COM esta medição ligada' }),
            sinaisDisparados,
            bloqueadosPorTendencia,
            barradosPorTaxa,
            recusadosPorRisco,
            // O número que explica um -3006 sem precisar adivinhar: se está em
            // zero, o colateral está preso e o motor opera à vista.
            ...(cfg.margem && cfg.alavancagem.greaterThan(1)
                ? { emprestimoDisponivel: `$${capacidadeDeEmprestimo.toFixed(2)}` }
                : {}),
            // O caixa que a CORRETORA diz existir, ao lado do que o motor
            // modelou. Quando os dois divergem, é o modelo que está errado — e
            // a divergência é invisível até uma ordem ser recusada por saldo.
            ...(saldoRealLivre !== null ? { saldoNaCorretora: `$${saldoRealLivre.toFixed(2)}` } : {}),
            ...(cfg.tetoDeCapital.greaterThan(0)
                ? {
                      capitalQueTrabalha: capitalDeTrabalho({ patrimonio: capital, teto: cfg.tetoDeCapital }).toFixed(2),
                      lucroCONGELADO: lucroCongelado({ patrimonio: capital, teto: cfg.tetoDeCapital }).toFixed(2),
                  }
                : {}),
            porAtivo: cfg.symbols.map((sym) => `${sym}: ${diagnostico.get(sym) ?? 'aguardando fechar a vela'}`).join(' | '),
        }),
    };
    };

    // Capital dividido igualmente: comparação justa exige mesmo ponto de
    // partida. Com uma família só, ela fica com tudo.
    const fatia = cfg.capital.dividedBy(cfg.livros.length);
    const livros = cfg.livros.map((p) => criarLivro(p, fatia));

    // Capital recuperado do disco MANDA sobre a divisão nova: o capital de um
    // livro é o patrimônio dele, com lucro e prejuízo embutidos, e reescrevê-lo
    // apagaria o histórico. A consequência é que mudar DIRECTIONAL_CAPITAL ou o
    // número de famílias não redistribui o que já existe — e a soma pode passar
    // do capital configurado sem ninguém perceber. Em papel é contabilidade; com
    // dinheiro real seria alocar mais do que se tem.
    const somaDosLivros = livros.reduce((acc, l) => acc.plus(new Decimal(l.snapshot().capital)), new Decimal(0));
    if (!somaDosLivros.minus(cfg.capital).abs().lessThan('0.01')) {
        log.warn('A soma dos livros não bate com DIRECTIONAL_CAPITAL.', {
            somaDosLivros: somaDosLivros.toFixed(2),
            capitalConfigurado: cfg.capital.toFixed(2),
            porque:
                'Livros com estado salvo mantêm o capital que já tinham — é o patrimônio deles, com resultado ' +
                'embutido. A divisão nova só vale para livro novo.',
            paraRedistribuir: `Apague ${cfg.stateFile} para todos os livros recomeçarem da divisão atual.`,
        });
    }


    /** Último preço visto por ativo — só para exibição, nunca para decisão. */
    const precosAtuais = new Map<string, Decimal>();

    /**
     * Pergunta à corretora quanto ela empresta, uma vez por ciclo.
     *
     * Em PAPEL não há a quem perguntar, e a alavancagem é simulada: devolver
     * folga de sobra mantém o papel medindo o que foi configurado. Ao vivo, a
     * resposta é a real — e uma falha na consulta devolve ZERO, não a
     * alavancagem cheia. Errar aqui para o lado do empréstimo custa uma rodada
     * inteira de ordens recusadas; errar para o lado da operação à vista custa
     * uma posição menor.
     */
    const medirCapacidadeDeEmprestimo = async (): Promise<Decimal> => {
        if (!cfg.margem || cfg.alavancagem.lessThanOrEqualTo(1)) return new Decimal(0);
        if (!exchange) return cfg.capital.mul(cfg.alavancagem);
        try {
            return await exchange.fetchMaxBorrowable('USDT');
        } catch (err) {
            log.warn('Não foi possível consultar o máximo emprestável; o ciclo opera à vista.', {
                erro: err instanceof Error ? err.message : String(err),
                consequencia: 'as entradas deste ciclo usam só o caixa próprio, sem alavancagem.',
            });
            return new Decimal(0);
        }
    };

    /**
     * O saldo livre de verdade, uma vez por ciclo.
     *
     * Em papel não há carteira: devolver null mantém o modelo mandando, que é
     * o comportamento correto para uma simulação. Falha na consulta também
     * devolve null — degradar para o modelo é melhor que parar de operar, e a
     * pior consequência é a recusa que já acontecia.
     */
    const medirSaldoRealLivre = async (): Promise<Decimal | null> => {
        if (!exchange) return null;
        try {
            return await exchange.fetchAvailableBalance('USDT');
        } catch (err) {
            log.warn('Não foi possível ler o saldo livre; o ciclo usa o caixa modelado.', {
                erro: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    };

    for (;;) {
        // Antes de qualquer decisão de tamanho: quanto a corretora empresta
        // AGORA. Consultar uma vez por ciclo, e não por ativo, evita gastar
        // peso de API repetindo a mesma pergunta vinte vezes.
        capacidadeDeEmprestimo = await medirCapacidadeDeEmprestimo();
        saldoRealLivre = await medirSaldoRealLivre();

        for (const symbol of cfg.symbols) {
            try {
                // As velas são buscadas UMA vez por símbolo e servidas a todos
                // os livros. Cada livro buscando as suas dobraria as chamadas à
                // Binance para responder exatamente a mesma coisa — e, pior,
                // as duas famílias poderiam decidir sobre instantes diferentes.
                const { closed, precoAgora } = await fetchClosedCandles(symbol, cfg.interval, HISTORY_CANDLES);
                precosAtuais.set(symbol, precoAgora);
                for (const livro of livros) {
                    await livro.step(symbol, closed);
                }
            } catch (err) {
                // Falha em um ativo não pode parar os outros nem derrubar o
                // motor: ele existe para rodar ininterruptamente.
                const motivo = err instanceof Error ? err.message : String(err);
                for (const livro of livros) livro.marcarFalha(symbol, motivo);
                log.warn(`Falha ao avaliar ${symbol}; segue no próximo ciclo.`, { erro: motivo });
            }
        }

        // Gravado a cada ciclo, não só quando algo muda: o stop móvel sobe
        // dentro do ciclo sem abrir nem fechar posição, e perder essa
        // atualização num reinício reabriria a posição com stop mais frouxo do
        // que o que estava valendo.
        try {
            saveState(
                cfg.stateFile,
                Object.fromEntries(livros.map((l) => [l.params.entryStrategy, l.snapshot()])),
            );
        } catch (err) {
            log.warn('Não foi possível gravar o estado; um reinício perderia as posições abertas.', {
                arquivo: cfg.stateFile,
                erro: err instanceof Error ? err.message : String(err),
            });
        }

        for (const livro of livros) {
            log.info(`>>> ${livro.status()}`);
            log.info(`Heartbeat [${livro.params.entryStrategy}] — motor direcional ativo.`, {
                modo: cfg.live ? 'LIVE' : 'PAPEL',
                leituraDaVela: `uma avaliação por vela de ${cfg.interval} — o diagnóstico abaixo é da última fechada`,
                ...livro.resumo(),
            });
            // Painel ao vivo: atualiza a cada ciclo, com o preço de agora.
            for (const linha of livro.painel(precosAtuais)) {
                log.info(`  [${livro.params.entryStrategy}] EM POSIÇÃO — ${linha}`);
            }
        }

        await new Promise((resolve) => setTimeout(resolve, cfg.pollSeconds * 1000));
    }
}

if (require.main === module) {
    main().catch((err) => {
        log.error('Falha no motor direcional.', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
