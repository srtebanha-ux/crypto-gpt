// Arquivo: src/scalping.ts
//
// A aritmética que decide um scalping ANTES de ele existir.
//
// Toda configuração de scalping é definida por quatro números: alvo, stop,
// taxa e alavancagem. Desses quatro sai um quinto, que é o único que importa:
//
//     a TAXA DE ACERTO NECESSÁRIA para não perder dinheiro.
//
// E esse quinto número quase nunca é calculado. É por isso que configurações
// que parecem prudentes — stop apertado, alvo modesto — são frequentemente as
// piores: um alvo MENOR que o stop exige acertar mais da metade das vezes só
// para empatar, e a taxa empurra essa exigência ainda mais para cima.
//
// A conta, sem mistério:
//
//     ganho líquido = nocional × (alvo − 2×taxa)
//     perda líquida = nocional × (stop + 2×taxa)
//     acerto mínimo = perda / (ganho + perda)
//
// A taxa aparece nos DOIS lados, e é aí que ela morde: ela reduz o ganho e
// aumenta a perda ao mesmo tempo. Num alvo de 0,3% com taxa de 0,09% por ida
// e volta, quase um terço do ganho já foi antes de o preço se mover.
//
// ALAVANCAGEM NÃO ENTRA NA TAXA DE ACERTO — e isso surpreende. Ela multiplica
// ganho, perda e taxa na mesma proporção, então a razão entre eles não muda.
// O que ela muda é o TAMANHO de cada resultado sobre a banca, e a velocidade
// com que uma sequência ruim zera a conta.
import { Decimal } from 'decimal.js';

export interface ConfiguracaoDeScalping {
    /** Alvo de lucro como fração do PREÇO (0.003 = 0,3%). */
    alvo: Decimal;
    /** Stop como fração do PREÇO (0.004 = 0,4%). */
    stop: Decimal;
    /** Taxa por perna (0.00045 = 0,045%). */
    taxaPorPerna: Decimal;
}

export interface AritmeticaDoScalping {
    /** Ganho por acerto, como fração do preço, já sem taxa. */
    ganhoLiquido: Decimal;
    /** Perda por erro, como fração do preço, já com taxa. */
    perdaLiquida: Decimal;
    /** Razão ganho/perda. Abaixo de 1 significa que o erro dói mais que o acerto. */
    razao: Decimal;
    /** A taxa de acerto que faz a expectativa ser exatamente zero. */
    acertoMinimo: Decimal;
    /** Quanto do ganho bruto a taxa consome. */
    fracaoDoGanhoComidaPelaTaxa: Decimal;
}

export function aritmeticaDoScalping(cfg: ConfiguracaoDeScalping): AritmeticaDoScalping {
    const idaEVolta = cfg.taxaPorPerna.mul(2);
    const ganhoLiquido = cfg.alvo.minus(idaEVolta);
    const perdaLiquida = cfg.stop.plus(idaEVolta);

    // Alvo que não cobre nem a própria taxa: não existe taxa de acerto que
    // salve, porque o "acerto" já é prejuízo. Devolver 1 (100%) expressa isso
    // sem mentir — devolver algo entre 0 e 1 sugeriria que há uma saída.
    if (ganhoLiquido.lessThanOrEqualTo(0)) {
        return {
            ganhoLiquido,
            perdaLiquida,
            razao: new Decimal(0),
            acertoMinimo: new Decimal(1),
            fracaoDoGanhoComidaPelaTaxa: new Decimal(1),
        };
    }

    return {
        ganhoLiquido,
        perdaLiquida,
        razao: ganhoLiquido.dividedBy(perdaLiquida),
        acertoMinimo: perdaLiquida.dividedBy(ganhoLiquido.plus(perdaLiquida)),
        fracaoDoGanhoComidaPelaTaxa: cfg.alvo.greaterThan(0) ? idaEVolta.dividedBy(cfg.alvo) : new Decimal(1),
    };
}

/**
 * O alvo necessário para uma taxa de acerto que você acredita conseguir.
 *
 * É a pergunta invertida, e é a útil: em vez de "que acerto meu alvo exige?",
 * pergunta "dado o acerto que eu realmente tenho, qual alvo fecha a conta?".
 *
 * A resposta quase sempre é um alvo MAIOR que o stop — o oposto do instinto
 * de "pegar o lucrinho rápido e cortar rápido".
 */
export function alvoNecessario(params: {
    acertoEsperado: Decimal;
    stop: Decimal;
    taxaPorPerna: Decimal;
}): Decimal | null {
    const p = params.acertoEsperado;
    if (p.lessThanOrEqualTo(0) || p.greaterThanOrEqualTo(1)) return null;
    const idaEVolta = params.taxaPorPerna.mul(2);
    const perdaLiquida = params.stop.plus(idaEVolta);
    // p·(alvo − taxa) = (1−p)·(stop + taxa)  →  alvo = (1−p)/p · perda + taxa
    return new Decimal(1).minus(p).dividedBy(p).mul(perdaLiquida).plus(idaEVolta);
}

/**
 * O custo de UMA operação sobre a banca inteira.
 *
 * Aqui a alavancagem entra, e é o número que revela o preço de operar grande
 * com pouco: a taxa incide sobre o nocional, mas quem paga é a banca. A 30x,
 * 0,045% por perna vira 2,7% da conta por ida e volta — e trinta e sete
 * operações consomem a banca inteira em pedágio, sem ter perdido nenhuma.
 */
export function custoPorOperacaoSobreBanca(params: {
    taxaPorPerna: Decimal;
    alavancagem: Decimal;
}): Decimal {
    return params.taxaPorPerna.mul(2).mul(params.alavancagem);
}

/** Quantas operações a banca aguenta só de taxa, sem nenhuma perda. */
export function operacoesAteZerarSoDeTaxa(params: {
    taxaPorPerna: Decimal;
    alavancagem: Decimal;
}): Decimal {
    const custo = custoPorOperacaoSobreBanca(params);
    if (custo.lessThanOrEqualTo(0)) return new Decimal(Infinity);
    return new Decimal(1).dividedBy(custo).floor();
}

export type VeredictoDeScalping =
    | { viavel: true; aritmetica: AritmeticaDoScalping; motivo: string }
    | { viavel: false; aritmetica: AritmeticaDoScalping; motivo: string; alvoQueFecharia: Decimal | null };

/**
 * A configuração fecha, dada a taxa de acerto que se pode esperar de verdade?
 *
 * `acertoRealista` existe para não deixar a decisão implícita. Sistemas
 * direcionais sistemáticos bons vivem entre 40% e 55% — e uma configuração
 * que precisa de 70% não está pedindo disciplina, está pedindo outra
 * realidade. Deixar esse número explícito no código força quem configura a
 * declarar em que acerto acredita, em vez de descobrir depois no extrato.
 */
export function veredictoDeScalping(params: {
    configuracao: ConfiguracaoDeScalping;
    acertoRealista: Decimal;
}): VeredictoDeScalping {
    const a = aritmeticaDoScalping(params.configuracao);

    if (a.ganhoLiquido.lessThanOrEqualTo(0)) {
        return {
            viavel: false,
            aritmetica: a,
            motivo:
                `O alvo de ${params.configuracao.alvo.mul(100).toFixed(3)}% não cobre nem a ida e volta de ` +
                `${params.configuracao.taxaPorPerna.mul(200).toFixed(3)}%. O "acerto" já nasce prejuízo.`,
            alvoQueFecharia: alvoNecessario({
                acertoEsperado: params.acertoRealista,
                stop: params.configuracao.stop,
                taxaPorPerna: params.configuracao.taxaPorPerna,
            }),
        };
    }

    if (a.acertoMinimo.greaterThan(params.acertoRealista)) {
        return {
            viavel: false,
            aritmetica: a,
            motivo:
                `Exige acertar ${a.acertoMinimo.mul(100).toFixed(1)}% das operações para EMPATAR, e o acerto ` +
                `assumido é ${params.acertoRealista.mul(100).toFixed(1)}%. A taxa come ` +
                `${a.fracaoDoGanhoComidaPelaTaxa.mul(100).toFixed(1)}% do ganho bruto.`,
            alvoQueFecharia: alvoNecessario({
                acertoEsperado: params.acertoRealista,
                stop: params.configuracao.stop,
                taxaPorPerna: params.configuracao.taxaPorPerna,
            }),
        };
    }

    return {
        viavel: true,
        aritmetica: a,
        motivo:
            `Empata com ${a.acertoMinimo.mul(100).toFixed(1)}% de acerto, abaixo dos ` +
            `${params.acertoRealista.mul(100).toFixed(1)}% assumidos. Razão ganho/perda: ${a.razao.toFixed(2)}.`,
    };
}
