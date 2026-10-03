// Arquivo: src/statistics.ts
//
// Rastreador de média/variância móvel exponencial (EWMA) — a base do kill
// switch estatístico do engine: uma ineficiência só é "assertiva" o
// suficiente para disparar capital quando é uma anomalia estatisticamente
// significativa frente ao comportamento recente do próprio par sintético,
// não apenas "positiva" no sentido puramente determinístico do RiskManager.
// Isso reduz falsos positivos causados por um tick isolado ruidoso ou por
// artefato de latência que passou pelo filtro de obsolescência.
//
// Fórmula: variância exponencial em uma passada (recorrência exata,
// numericamente estável — o mesmo filtro usado para estimar volatilidade
// realizada de curto prazo em sistemas de trading):
//
//   diff_t = x_t - mean_{t-1}
//   incr_t = alpha * diff_t
//   mean_t = mean_{t-1} + incr_t
//   var_t  = (1 - alpha) * (var_{t-1} + diff_t * incr_t)
//
// alpha ∈ (0, 1] controla a "memória" do filtro; alpha = 2 / (N + 1)
// aproxima uma média móvel de janela N. Por indução, var_t >= 0 sempre
// (diff_t * incr_t = alpha * diff_t² >= 0 e var_0 = 0), então stdDev()
// nunca opera sobre um número negativo.
import { Decimal } from 'decimal.js';

export class EwmaTracker {
    private readonly alpha: Decimal;
    private meanValue = new Decimal(0);
    private varianceValue = new Decimal(0);
    private count = 0;

    constructor(alpha: Decimal) {
        if (!alpha.greaterThan(0) || alpha.greaterThan(1)) {
            throw new Error('EwmaTracker: alpha deve estar em (0, 1].');
        }
        this.alpha = alpha;
    }

    /** Incorpora uma nova amostra ao filtro. */
    public update(x: Decimal): void {
        if (this.count === 0) {
            this.meanValue = x;
            this.varianceValue = new Decimal(0);
            this.count = 1;
            return;
        }
        const diff = x.minus(this.meanValue);
        const incr = this.alpha.mul(diff);
        this.meanValue = this.meanValue.plus(incr);
        this.varianceValue = new Decimal(1).minus(this.alpha).mul(this.varianceValue.plus(diff.mul(incr)));
        this.count += 1;
    }

    public mean(): Decimal {
        return this.meanValue;
    }

    public stdDev(): Decimal {
        return this.varianceValue.sqrt();
    }

    public sampleCount(): number {
        return this.count;
    }

    /**
     * Quantos desvios-padrão `x` está acima da média corrente. Retorna 0
     * quando stdDev == 0 (inclusive com 0 ou 1 amostra) — nesse regime não
     * há variância observada o suficiente para um z-score ser significativo.
     */
    public zScore(x: Decimal): Decimal {
        const sd = this.stdDev();
        if (sd.isZero()) return new Decimal(0);
        return x.minus(this.meanValue).dividedBy(sd);
    }
}
