// Arquivo: src/strategyParams.ts
//
// Fonte ÚNICA dos parâmetros da estratégia direcional, lida por quem mede
// (`backtestRunner.ts`) e por quem opera (`directionalLive.ts`).
//
// Existe por causa de um defeito real: os dois resolviam as mesmas variáveis
// `BT_*` cada um por conta própria, e os padrões divergiram sem que nada
// quebrasse. O motor ao vivo entrava com RSI < 45 enquanto o backtest media
// RSI < 30 — regra de entrada mais frouxa que a medida, operando de verdade —
// e cobrava 0,1% de taxa onde a medição usava 0,075%. Nada falha nesse caso:
// o motor roda, o log parece saudável, e o resultado simplesmente não é o que
// foi validado.
//
// Duplicar a leitura de configuração é barato de escrever e caro de manter
// correto. Com um resolvedor só, a divergência deixa de ser possível.
import { Decimal } from 'decimal.js';
import type { EntryStrategy, StrategyParams } from './backtest';

/**
 * `StrategyParams` com os campos opcionais já preenchidos.
 *
 * O backtest tolera campos ausentes porque aplica um padrão local em cada uso;
 * o motor ao vivo não deveria repetir esses padrões — repeti-los é justamente
 * como as duas leituras divergiram da primeira vez. Este tipo torna a
 * resolução completa uma garantia do compilador.
 */
export type ResolvedStrategyParams = StrategyParams &
    Required<Pick<StrategyParams, 'entryStrategy' | 'rsiPeriod' | 'rsiThreshold' | 'trailAtrMultiplier' | 'minNotional'>>;

/**
 * Conjuntos de padrões prontos, escolhidos por `DIRECTIONAL_PRESET`.
 *
 * Existe porque estes cinco valores são os que decidem se o motor opera muito
 * ou quase nunca, e ajustá-los um a um num painel web é onde um erro de
 * digitação fica invisível. Uma variável só troca os cinco de uma vez — e o
 * motor imprime os valores efetivos no boot, porque preset que esconde o que
 * fez é pior do que não ter preset.
 *
 * Qualquer `BT_*` explícito continua ganhando do preset: o preset é o padrão,
 * não um teto.
 */
export const PRESETS = {
    /** O que foi MEDIDO. `reversion` a 1h passou o critério com estes valores. */
    padrao: {
        // 30 é o valor de manual para mercado lateral. Para comprar correção
        // DENTRO de uma tendência de alta ele quase nunca é atingido — as
        // quedas param em 40-45 —, e o resultado é a estratégia não disparar
        // nenhuma vez, que não é "perdeu": é "nunca foi testada".
        rsiThreshold: '30',
        breakoutLookback: '20',
        trendPeriod: '50',
        riskFraction: '0.02',
        // 3x a média é a fronteira entre "mexeu" e "alguém está comprando".
        minVolumeRatio: '3',
        atrStopMultiplier: '2',
    },
    /**
     * Opera MUITO mais. Também perde mais, e não por acaso — por construção.
     *
     * O que trava o motor não é o tamanho da posição, é a frequência do sinal:
     * com RSI < 30 e filtro de tendência ligado, as duas condições quase se
     * excluem (uma queda forte o bastante para o RSI cair abaixo de 30 joga o
     * preço abaixo da própria média, e o filtro barra exatamente o que o sinal
     * achou). Este preset ataca a frequência.
     *
     * O preço disso está medido e é real: `trendPeriod: 0` desliga o filtro
     * que mantinha o motor fora de mercado em queda, e as TRÊS famílias
     * mediram prejuízo em regime de baixa. Mais entradas em queda é
     * exatamente o que este preset compra.
     */
    agressivo: {
        // 45 pega correção comum em vez de pânico. É o valor que o próprio
        // comentário do padrão descreve como o que de fato acontece.
        rsiThreshold: '45',
        // Máxima de 10 velas é rompida com muito mais frequência que a de 20.
        breakoutLookback: '10',
        // DESLIGADO. O maior destravador de frequência — e o maior risco novo.
        trendPeriod: '0',
        // Só morde nos ativos voláteis: em ATR baixo o capital já era o teto.
        riskFraction: '0.08',
        // "Subiu com volume acima da média", não "alguém está comprando".
        minVolumeRatio: '1.8',
        // Deliberadamente IGUAL ao padrão: apertar o stop não é coragem, é
        // menos tolerância a ruído, e alargar tem custo simétrico. Só o preset
        // `maximo` mexe nisso, e mexe para o lado de dar espaço.
        atrStopMultiplier: '2',
    },
    /**
     * O limite do que dá para pedir a esta estratégia. Opera quase tudo.
     *
     * Diferente do `agressivo`, que ainda mantinha alguma seletividade, aqui a
     * ideia é não deixar passar oportunidade — e o preço disso é entrar em
     * muita coisa que não era oportunidade nenhuma.
     *
     * Três mudanças, e vale saber o que cada uma custa:
     *
     * - RSI 55: acima de 50 o indicador deixa de significar "sobrevendido" e
     *   passa a significar "não está caro". A estratégia deixa de comprar
     *   pânico e passa a comprar qualquer recuo, inclusive os que são só o
     *   começo de uma queda maior.
     * - Máxima de 5 velas: rompimento de 5 velas em gráfico de 15 minutos é
     *   pouco mais que ruído. Muitos disparos, muitos falsos.
     * - Stop a 3x ATR em vez de 2x: dá espaço para a posição respirar em vez
     *   de ser tirada por oscilação normal. É a mudança mais defensável das
     *   três — e ainda assim ela AUMENTA a perda por operação errada, porque
     *   o stop está mais longe.
     *
     * O que este preset NÃO muda, porque não adiantaria: `riskFraction`. Com
     * teto por posição e alavancagem, o limite de tamanho vem do teto, não da
     * fórmula de risco — subir o risco aqui seria cosmético.
     */
    maximo: {
        rsiThreshold: '55',
        breakoutLookback: '5',
        trendPeriod: '0',
        riskFraction: '0.15',
        minVolumeRatio: '1.2',
        atrStopMultiplier: '3',
    },
} as const;

export type NomeDePreset = keyof typeof PRESETS;

/** O preset escolhido, com falha barulhenta em nome inválido. */
export function resolverPreset(): { nome: NomeDePreset; valores: (typeof PRESETS)[NomeDePreset] } {
    const escolha = (process.env.DIRECTIONAL_PRESET ?? 'padrao').trim().toLowerCase();
    if (!(escolha in PRESETS)) {
        throw new Error(
            `DIRECTIONAL_PRESET inválido: "${escolha}". Use ${Object.keys(PRESETS).join(' ou ')}.`,
        );
    }
    const nome = escolha as NomeDePreset;
    return { nome, valores: PRESETS[nome] };
}

/**
 * Resolve os parâmetros de sinal e risco a partir das variáveis `BT_*`.
 *
 * O prefixo `BT_` ficou de quando só existia backtest. Mantê-lo é deliberado:
 * é o que garante que medir e operar leiam exatamente a mesma configuração,
 * sem ninguém precisar lembrar de espelhar valores entre dois conjuntos de
 * variáveis. Vale para o preset também: `DIRECTIONAL_PRESET=agressivo` muda o
 * backtest e o motor ao vivo da mesma forma, então dá para MEDIR o preset
 * antes de operar com ele.
 */
export function resolveStrategyParams(entryStrategy: EntryStrategy = 'breakout'): ResolvedStrategyParams {
    const { valores: preset } = resolverPreset();
    return {
        entryStrategy,
        rsiPeriod: Number(process.env.BT_RSI_PERIOD ?? '14'),
        rsiThreshold: new Decimal(process.env.BT_RSI_THRESHOLD ?? preset.rsiThreshold),
        breakoutLookback: Number(process.env.BT_BREAKOUT_LOOKBACK ?? preset.breakoutLookback),
        atrPeriod: Number(process.env.BT_ATR_PERIOD ?? '14'),
        atrStopMultiplier: new Decimal(process.env.BT_ATR_STOP_MULT ?? preset.atrStopMultiplier),
        trendPeriod: Number(process.env.BT_TREND_PERIOD ?? preset.trendPeriod),
        riskFraction: new Decimal(process.env.BT_RISK_FRACTION ?? preset.riskFraction),
        trailFraction: new Decimal(process.env.BT_TRAIL_FRACTION ?? '0'),
        // Padrão em ATR, não em percentual: 3x ATR deixa a posição respirar o
        // ruído normal enquanto sobe, e aperta sozinho conforme o preço avança.
        trailAtrMultiplier: new Decimal(process.env.BT_TRAIL_ATR_MULT ?? '3'),
        // Taker com desconto de BNB, que é o que a conta tem. Ao vivo o motor
        // substitui isto pela taxa real da corretora; em papel este valor é o
        // que mantém o resultado comparável ao do backtest.
        feeRate: new Decimal(process.env.BT_FEE_RATE ?? '0.00075'),
        minNotional: new Decimal(process.env.BT_MIN_NOTIONAL ?? '5'),
        // Média que separa mercado de alta de mercado de baixa na
        // classificação das operações do relatório.
        regimePeriod: Number(process.env.BT_REGIME_PERIOD ?? '200'),
        volumePeriod: Number(process.env.BT_VOLUME_PERIOD ?? '20'),
        minVolumeRatio: new Decimal(process.env.BT_MIN_VOLUME_RATIO ?? preset.minVolumeRatio),
        // Zero desliga. Ligado só faz sentido onde o movimento é rápido e
        // devolve tudo — em tendência longa, sair no alvo corta o ganho que
        // paga os prejuízos.
        takeProfitR: new Decimal(process.env.BT_TAKE_PROFIT_R ?? '0'),
    };
}
