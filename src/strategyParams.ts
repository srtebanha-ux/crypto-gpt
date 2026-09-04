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
 * Resolve os parâmetros de sinal e risco a partir das variáveis `BT_*`.
 *
 * O prefixo `BT_` ficou de quando só existia backtest. Mantê-lo é deliberado:
 * é o que garante que medir e operar leiam exatamente a mesma configuração,
 * sem ninguém precisar lembrar de espelhar valores entre dois conjuntos de
 * variáveis.
 */
export function resolveStrategyParams(entryStrategy: EntryStrategy = 'breakout'): ResolvedStrategyParams {
    return {
        entryStrategy,
        rsiPeriod: Number(process.env.BT_RSI_PERIOD ?? '14'),
        // 30 é o valor de manual para mercado lateral. Para comprar correção
        // DENTRO de uma tendência de alta ele quase nunca é atingido — as
        // quedas param em 40-45 —, e o resultado é a estratégia não disparar
        // nenhuma vez, que não é "perdeu": é "nunca foi testada".
        rsiThreshold: new Decimal(process.env.BT_RSI_THRESHOLD ?? '30'),
        breakoutLookback: Number(process.env.BT_BREAKOUT_LOOKBACK ?? '20'),
        atrPeriod: Number(process.env.BT_ATR_PERIOD ?? '14'),
        atrStopMultiplier: new Decimal(process.env.BT_ATR_STOP_MULT ?? '2'),
        trendPeriod: Number(process.env.BT_TREND_PERIOD ?? '50'),
        riskFraction: new Decimal(process.env.BT_RISK_FRACTION ?? '0.02'),
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
    };
}
