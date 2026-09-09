// Arquivo: src/rateLimiter.ts
//
// Controle de vazão contra a Binance. Existe para uma consequência específica
// e cara: a corretora não te avisa que você está exagerando — ela te BANE.
//
// A escada de punição, do leve ao terminal:
//
//   429  excedeu o limite. Recuo e siga.
//   418  BANIDO por IP. De 2 minutos a 3 DIAS, e cada nova requisição durante
//        o banimento ESTENDE a pena.
//
// É por isso que o 418 aqui não é tratado como erro recuperável: tentar de
// novo é literalmente a ação que piora a situação. O único movimento correto é
// parar e esperar o tempo que a própria corretora informou.
//
// E o dano de um banimento não fica contido no motor que o causou: a conta é a
// mesma. Um sniffer bombardeando a API pode derrubar a capacidade de o motor
// direcional VENDER uma posição aberta — transformando um erro de vazão numa
// posição sem saída.
import { createLogger } from './logger';

const log = createLogger('vazao');

export interface EstadoDaVazao {
    /** Peso/ordens já gastos na janela corrente. */
    gasto: number;
    /** Quando a janela corrente começou. */
    janelaAbertaEmMs: number;
    /** Enquanto isto for maior que agora, NADA pode ser enviado. */
    bloqueadoAteMs: number;
}

/**
 * Balde de fichas com janela fixa.
 *
 * Janela FIXA e não deslizante de propósito: é assim que a Binance conta. Uma
 * janela deslizante seria mais suave, mas permitiria picos que a contagem real
 * da corretora rejeita — e o objetivo aqui não é ser justo, é não ser banido.
 */
export class ControleDeVazao {
    private estado: EstadoDaVazao;

    constructor(
        private readonly params: {
            /** Quanto cabe na janela (peso de requisição, ou nº de ordens). */
            capacidade: number;
            janelaMs: number;
            /**
             * Fração da capacidade que o motor se permite usar. 0.8 deixa 20%
             * de folga para o que não passa por aqui: reconexão de WebSocket,
             * consultas de saldo, e a margem de erro entre o nosso contador e
             * o da corretora, que nunca batem exatamente.
             */
            usoMaximo?: number;
            nome: string;
        },
        private readonly agora: () => number = () => Date.now(),
    ) {
        this.estado = { gasto: 0, janelaAbertaEmMs: agora(), bloqueadoAteMs: 0 };
    }

    private get limite(): number {
        return Math.floor(this.params.capacidade * (this.params.usoMaximo ?? 0.8));
    }

    private renovarSePreciso(): void {
        const t = this.agora();
        if (t - this.estado.janelaAbertaEmMs >= this.params.janelaMs) {
            this.estado.gasto = 0;
            this.estado.janelaAbertaEmMs = t;
        }
    }

    /**
     * Quantos ms faltam até haver vaga para `custo`. Zero significa "pode ir".
     *
     * Devolve tempo em vez de um booleano porque quem chama precisa saber
     * QUANTO esperar. Um booleano forçaria uma espera arbitrária, que ou
     * desperdiça vazão ou volta cedo demais e é recusada de novo.
     */
    public esperaNecessariaMs(custo = 1): number {
        const t = this.agora();
        if (t < this.estado.bloqueadoAteMs) return this.estado.bloqueadoAteMs - t;
        this.renovarSePreciso();
        if (this.estado.gasto + custo <= this.limite) return 0;
        return this.params.janelaMs - (t - this.estado.janelaAbertaEmMs);
    }

    /** Registra o consumo. Chamar SEMPRE que a requisição for de fato enviada. */
    public consumir(custo = 1): void {
        this.renovarSePreciso();
        this.estado.gasto += custo;
    }

    /**
     * A corretora respondeu 429 ou 418.
     *
     * `retryAfterSegundos` vem do cabeçalho `Retry-After`. Quando ele existe,
     * é a única fonte confiável — o nosso contador claramente divergiu do
     * dela, então continuar confiando no nosso seria repetir o erro.
     */
    public registrarRecusa(params: { status: number; retryAfterSegundos?: number }): void {
        const t = this.agora();
        const informado = params.retryAfterSegundos !== undefined ? params.retryAfterSegundos * 1000 : undefined;

        if (params.status === 418) {
            // Banimento. Sem Retry-After, assume o mínimo documentado (2 min) —
            // e NUNCA menos que isso, porque cada tentativa durante o banimento
            // estende a pena.
            const espera = informado ?? 120_000;
            this.estado.bloqueadoAteMs = t + espera;
            log.error(`[${this.params.nome}] BANIDO POR IP pela Binance (418).`, {
                bloqueadoPor: `${Math.round(espera / 1000)}s`,
                atencao:
                    'Cada requisição enviada durante o banimento ESTENDE a pena. O motor fica parado até o fim, ' +
                    'de propósito.',
            });
            return;
        }

        // 429: recuo proporcional. Dobrar a janela é o mínimo defensável — se
        // estourou, o nosso contador estava otimista.
        const espera = informado ?? this.params.janelaMs;
        this.estado.bloqueadoAteMs = t + espera;
        this.estado.gasto = this.limite;
        log.warn(`[${this.params.nome}] Limite de vazão atingido (429).`, {
            recuandoPor: `${Math.round(espera / 1000)}s`,
        });
    }

    /** Espera até haver vaga e consome. Uso normal: `await c.aguardarVaga()`. */
    public async aguardarVaga(custo = 1): Promise<void> {
        for (;;) {
            const espera = this.esperaNecessariaMs(custo);
            if (espera <= 0) {
                this.consumir(custo);
                return;
            }
            await new Promise((r) => setTimeout(r, Math.min(espera, 5000)));
        }
    }

    public get bloqueado(): boolean {
        return this.agora() < this.estado.bloqueadoAteMs;
    }

    public resumo(): { gasto: number; limite: number; bloqueadoPorMs: number } {
        this.renovarSePreciso();
        return {
            gasto: this.estado.gasto,
            limite: this.limite,
            bloqueadoPorMs: Math.max(0, this.estado.bloqueadoAteMs - this.agora()),
        };
    }
}

/**
 * Extrai o `Retry-After` de uma resposta.
 *
 * Isolado e testado porque o cabeçalho ausente e o cabeçalho com lixo levam ao
 * mesmo lugar — `undefined` —, e tratar lixo como zero faria o motor tentar de
 * novo IMEDIATAMENTE durante um banimento. É o pior comportamento possível
 * exatamente no pior momento possível.
 */
export function lerRetryAfter(headers: { get(nome: string): string | null }): number | undefined {
    const bruto = headers.get('retry-after');
    if (bruto === null) return undefined;
    // A guarda de string vazia vem ANTES do Number, e não é preciosismo:
    // `Number('')` é ZERO, e zero aqui significa "tente de novo agora" —
    // exatamente durante um banimento, que é quando tentar de novo estende a
    // pena. Um cabeçalho vazio precisa virar "não sei", não "pode ir".
    const limpo = bruto.trim();
    if (limpo.length === 0) return undefined;
    const n = Number(limpo);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
}
