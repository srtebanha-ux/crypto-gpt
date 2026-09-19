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
    /**
     * Teto ABSOLUTO de prejuízo acumulado no dia, em USDT.
     *
     * Os outros limites são percentuais, e percentual é a linguagem errada
     * para um teste pago: quem autoriza um teste autoriza um VALOR — "pode
     * perder um dólar" —, não uma fração de uma banca que ele vai ter de
     * calcular de cabeça. 15% de 45 USDT são 6,75, e ninguém que disse "um
     * dólar" quis dizer isso.
     *
     * Permanente de propósito. O objetivo de um teto assim não é pausar até
     * melhorar: é garantir que o experimento custe exatamente o combinado, e
     * religar sozinho quebraria essa garantia.
     */
    perdaAbsolutaMaxima?: Decimal;
    /**
     * Piso ABSOLUTO de banca, em USDT. Abaixo dele o robô para de vez.
     *
     * Existe porque `perdaAbsolutaMaxima` mede um contador que vive na
     * memória do processo, e memória de processo não sobrevive a um deploy.
     * Quem combinou "pode perder um dólar" e teve dois deploys no meio do
     * teste pagou três dólares: cada reinício zerou `resultadoDoDia` e o teto
     * recomeçou do zero, sem que nada no log parecesse errado.
     *
     * O piso não tem esse problema porque não é um contador. É uma
     * comparação contra um número fixo, dado de fora, que o reinício não
     * apaga: banca de referência menos o prejuízo autorizado. Um processo
     * recém-nascido lê o saldo real, compara com o piso e para na primeira
     * avaliação — exatamente como o que morreu teria feito.
     *
     * Depósito ou saque mudam o saldo sem serem resultado de operação, e o
     * piso não sabe disso. Quem move dinheiro na conta reescreve a
     * referência; é a mesma conversa de quem autorizou o valor.
     */
    pisoDeBanca?: Decimal;
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

    // O piso vem antes do teto do dia porque os dois dizem a mesma coisa e só
    // um deles sobrevive a um reinício. Quando ambos valem, quem fala é o que
    // não depende de memória.
    if (limites.pisoDeBanca !== undefined && estado.banca.lessThanOrEqualTo(limites.pisoDeBanca)) {
        return {
            podeOperar: false,
            permanente: true,
            motivo:
                `Banca (${estado.banca.toFixed(4)} USDT) chegou ao piso combinado de ` +
                `${limites.pisoDeBanca.toFixed(4)} USDT. O teste custou o que foi autorizado e para aqui — ` +
                `e para aqui mesmo depois de um reinício, porque o piso é um número fixo, não um contador.`,
        };
    }

    // Logo depois da queda do pico, e antes de qualquer limite que religue:
    // um teto combinado em dinheiro não pode ser contornado por uma pausa que
    // termina sozinha.
    if (limites.perdaAbsolutaMaxima !== undefined && estado.resultadoDoDia.lessThanOrEqualTo(limites.perdaAbsolutaMaxima.negated())) {
        return {
            podeOperar: false,
            permanente: true,
            motivo:
                `Prejuízo do dia (${estado.resultadoDoDia.toFixed(4)} USDT) atingiu o teto combinado de ` +
                `${limites.perdaAbsolutaMaxima.toFixed(2)} USDT. O teste custou o que foi autorizado e para aqui.`,
        };
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

/**
 * Reconcilia o disjuntor com a banca real depois de um saque ou depósito.
 *
 * O `banca` interno só cresce e diminui por resultado de operação. Um saque
 * não passa por ali, então sem esta função ele fica mentindo — e a mentira é
 * cara: a queda é medida contra o PICO, e sacar derruba a banca abaixo do
 * próprio pico. Sacar R$1.000 de uma banca de R$2.800 apareceria como queda
 * de 35,7% e dispararia a parada PERMANENTE, por causa de um saque
 * planejado, sem nada de ruim ter acontecido.
 *
 * O pico é reescalado na MESMA proporção da banca, e não deslocado pelo valor
 * transferido. Escalar preserva a queda em PORCENTAGEM, que é a unidade em
 * que o limite é escrito: quem estava 10% abaixo do pico continua 10% abaixo
 * depois de sacar. Deslocar pioraria a situação de quem saca durante uma
 * queda, punindo justamente quem tirou dinheiro da mesa na hora certa.
 */
export function ajustarPorTransferencia(params: {
    estado: EstadoDoDisjuntor;
    bancaReal: Decimal;
}): EstadoDoDisjuntor {
    const { estado, bancaReal } = params;
    if (bancaReal.isNegative()) return estado;

    // Sem banca anterior não há proporção a preservar: o pico passa a ser o
    // que existe agora, que é o único ponto de referência honesto.
    if (estado.banca.lessThanOrEqualTo(0)) {
        return { ...estado, banca: bancaReal, pico: bancaReal };
    }

    const proporcao = bancaReal.dividedBy(estado.banca);
    return {
        ...estado,
        banca: bancaReal,
        // Decimal.max com a banca nova cobre o depósito que ultrapassa o pico
        // antigo: dinheiro novo não deve nascer já "abaixo do pico".
        pico: Decimal.max(estado.pico.mul(proporcao), bancaReal),
    };
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
