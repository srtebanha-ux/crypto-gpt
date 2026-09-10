// Arquivo: src/disjuntor.ts
//
// Um disjuntor não melhora a expectativa de nada. Ele não faz o sistema
// ganhar mais nem acertar mais. O que ele faz é limitar o estrago de a
// expectativa estar ERRADA — e essa é uma possibilidade que nenhuma medição
// elimina, porque toda medição é feita numa amostra e o mercado muda depois
// dela.
//
// É seguro contra o modelo, não contra o mercado.
//
// A distinção importa porque decide o que ele desliga. Um sistema com
// vantagem real também toma sequências de perda — com 55% de acerto, cinco
// seguidas acontecem várias vezes por mês. Um disjuntor que corta na
// primeira sequência ruim desligaria justamente o sistema bom. Por isso os
// três gatilhos aqui olham para coisas diferentes:
//
//   PERDAS SEGUIDAS  — o regime pode ter virado; para e espera
//   PERDA DO DIA     — o dia está ruim; para até amanhã
//   QUEDA DO PICO    — a tese pode estar morta; para e chama alguém
//
// O terceiro é o único que não se rearma sozinho. Se a conta caiu 30% do
// topo, nenhuma regra automática deveria decidir voltar — isso é decisão de
// quem colocou o dinheiro.
import { Decimal } from 'decimal.js';

export interface EstadoDoDisjuntor {
    /** Perdas consecutivas desde o último ganho. */
    perdasSeguidas: number;
    /** Resultado acumulado do dia, em USDT. Negativo é prejuízo. */
    resultadoDoDia: Decimal;
    /** Maior banca já vista. A referência da queda. */
    pico: Decimal;
    /** Banca agora. */
    banca: Decimal;
    /** Início do dia corrente, em ms. */
    diaComecouEmMs: number;
    /** Quando o disjuntor religa sozinho. 0 = não está desarmado. */
    bloqueadoAteMs: number;
}

export interface LimitesDoDisjuntor {
    /** Perdas seguidas que desarmam. */
    perdasSeguidasMaximas: number;
    /** Quanto tempo esperar depois de uma sequência ruim. */
    pausaMs: number;
    /** Fração da banca do início do dia que pode ser perdida (0.15 = 15%). */
    perdaDiariaMaxima: Decimal;
    /** Queda do pico que para tudo permanentemente (0.30 = 30%). */
    quedaDoPicoMaxima: Decimal;
}

export const LIMITES_PADRAO: LimitesDoDisjuntor = {
    // Quatro, e não duas: com 45% de acerto, duas seguidas acontecem a cada
    // três operações. Um disjuntor que corta aí nunca deixa o sistema operar.
    perdasSeguidasMaximas: 4,
    pausaMs: 60 * 60_000,
    perdaDiariaMaxima: new Decimal('0.15'),
    quedaDoPicoMaxima: new Decimal('0.30'),
};

export type VeredictoDoDisjuntor =
    | { podeOperar: true }
    | { podeOperar: false; motivo: string; permanente: boolean; religaEmMs?: number };

export function podeOperar(params: {
    estado: EstadoDoDisjuntor;
    limites: LimitesDoDisjuntor;
    agoraMs: number;
    /** Banca no início do dia — a referência da perda diária. */
    bancaNoInicioDoDia: Decimal;
}): VeredictoDoDisjuntor {
    const { estado, limites } = params;

    // A queda do pico vem primeiro: é a única permanente, e nenhuma das
    // outras deve poder mascará-la.
    if (estado.pico.greaterThan(0)) {
        const queda = estado.pico.minus(estado.banca).dividedBy(estado.pico);
        if (queda.greaterThanOrEqualTo(limites.quedaDoPicoMaxima)) {
            return {
                podeOperar: false,
                permanente: true,
                motivo:
                    `Banca caiu ${queda.mul(100).toFixed(1)}% do pico de ${estado.pico.toFixed(2)} USDT ` +
                    `(limite ${limites.quedaDoPicoMaxima.mul(100).toFixed(0)}%). Isto não religa sozinho: uma queda ` +
                    `desse tamanho significa que a vantagem medida pode não existir mais, e voltar é decisão de quem ` +
                    `pôs o dinheiro, não de uma regra.`,
            };
        }
    }

    if (params.agoraMs < estado.bloqueadoAteMs) {
        return {
            podeOperar: false,
            permanente: false,
            religaEmMs: estado.bloqueadoAteMs - params.agoraMs,
            motivo:
                `${estado.perdasSeguidas} perdas seguidas. Pausa até ` +
                `${new Date(estado.bloqueadoAteMs).toISOString()} — sequência ruim pode ser azar ou pode ser o ` +
                `regime virando, e parar uma hora custa pouco perto de descobrir qual dos dois era.`,
        };
    }

    if (params.bancaNoInicioDoDia.greaterThan(0) && estado.resultadoDoDia.isNegative()) {
        const perda = estado.resultadoDoDia.abs().dividedBy(params.bancaNoInicioDoDia);
        if (perda.greaterThanOrEqualTo(limites.perdaDiariaMaxima)) {
            return {
                podeOperar: false,
                permanente: false,
                motivo:
                    `Perda do dia em ${perda.mul(100).toFixed(1)}% da banca ` +
                    `(limite ${limites.perdaDiariaMaxima.mul(100).toFixed(0)}%). Para até amanhã.`,
            };
        }
    }

    return { podeOperar: true };
}

/** Registra o resultado de uma operação e devolve o estado seguinte. */
export function registrarResultado(params: {
    estado: EstadoDoDisjuntor;
    limites: LimitesDoDisjuntor;
    resultadoUsdt: Decimal;
    agoraMs: number;
}): EstadoDoDisjuntor {
    const ganhou = params.resultadoUsdt.greaterThan(0);
    const banca = params.estado.banca.plus(params.resultadoUsdt);
    const perdasSeguidas = ganhou ? 0 : params.estado.perdasSeguidas + 1;

    return {
        ...params.estado,
        banca,
        // O pico só sobe. É a memória do melhor momento, e é contra ele que a
        // queda é medida — não contra o depósito inicial, que ficaria para
        // trás assim que a conta crescesse.
        pico: Decimal.max(params.estado.pico, banca),
        perdasSeguidas,
        resultadoDoDia: params.estado.resultadoDoDia.plus(params.resultadoUsdt),
        bloqueadoAteMs:
            perdasSeguidas >= params.limites.perdasSeguidasMaximas
                ? params.agoraMs + params.limites.pausaMs
                : params.estado.bloqueadoAteMs,
    };
}

/** Vira o dia: zera o resultado diário sem tocar em pico nem em sequência. */
export function virarODia(estado: EstadoDoDisjuntor, agoraMs: number): EstadoDoDisjuntor {
    return { ...estado, resultadoDoDia: new Decimal(0), diaComecouEmMs: agoraMs };
}

export function estadoInicial(banca: Decimal, agoraMs: number): EstadoDoDisjuntor {
    return {
        perdasSeguidas: 0,
        resultadoDoDia: new Decimal(0),
        pico: banca,
        banca,
        diaComecouEmMs: agoraMs,
        bloqueadoAteMs: 0,
    };
}
