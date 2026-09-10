// Arquivo: src/excursao.ts
//
// O que decide se um scalping ganha dinheiro não é o alvo, nem o stop, nem a
// taxa de acerto isoladamente: é a DISTRIBUIÇÃO CONJUNTA do caminho que o
// preço percorre depois do sinal. Discutir "0,3% é pouco?" sem esse dado é
// discutir sobre nada.
//
// Este arquivo transforma a pergunta em medição. Para cada sinal detectado,
// guarda-se o caminho (as velas seguintes) e depois se pergunta, para CADA
// par (alvo, stop) de uma grade: quantas vezes o alvo teria vindo primeiro,
// quantas vezes o stop, e qual o lucro esperado por operação já líquido de
// taxa. A configuração deixa de ser escolha e vira resultado.
//
// A sutileza que invalida a abordagem ingênua: máximo a favor (MFE) e máximo
// contra (MAE) NÃO bastam. Um caminho com MFE 0,5% e MAE 0,5% ganha ou perde
// dependendo de QUAL veio primeiro. Por isso a avaliação aqui percorre o
// caminho vela a vela em vez de olhar só os extremos.
//
// E quando alvo e stop caem DENTRO da mesma vela, é impossível saber a ordem
// com dados de 1 minuto. Aqui isso conta como STOP. Não é pessimismo: é a
// única suposição que não inventa lucro que talvez não exista — e num sistema
// a 30x, o erro de otimismo é o caro.
import { Decimal } from 'decimal.js';
import { Vela1m } from './volumeSpike';

/** Um sinal e o caminho que o preço percorreu depois dele. */
export interface CaminhoDeSinal {
    symbol: string;
    direcao: 'alta' | 'baixa';
    entrada: Decimal;
    /** Velas APÓS a entrada, em ordem. */
    velas: Vela1m[];
}

export type DesfechoDoCaminho = 'alvo' | 'stop' | 'aberto';

/**
 * Qual nível o preço tocou primeiro.
 *
 * Usa máxima e mínima de cada vela, não o fechamento: um stop dispara no
 * momento em que o preço toca, não no fim do minuto. Avaliar por fechamento
 * esconderia todos os stops que foram tocados e voltaram — que é exatamente
 * o modo de errar que faz um backtest parecer lucrativo e a conta não.
 */
export function desfechoNoCaminho(params: {
    entrada: Decimal;
    direcao: 'alta' | 'baixa';
    alvo: Decimal;
    stop: Decimal;
    velas: Vela1m[];
}): DesfechoDoCaminho {
    const alta = params.direcao === 'alta';
    const precoAlvo = alta
        ? params.entrada.mul(new Decimal(1).plus(params.alvo))
        : params.entrada.mul(new Decimal(1).minus(params.alvo));
    const precoStop = alta
        ? params.entrada.mul(new Decimal(1).minus(params.stop))
        : params.entrada.mul(new Decimal(1).plus(params.stop));

    for (const v of params.velas) {
        const tocouStop = alta ? v.minima.lessThanOrEqualTo(precoStop) : v.maxima.greaterThanOrEqualTo(precoStop);
        const tocouAlvo = alta ? v.maxima.greaterThanOrEqualTo(precoAlvo) : v.minima.lessThanOrEqualTo(precoAlvo);
        // Ambos na mesma vela: sem dados intra-vela, conta como stop.
        if (tocouStop) return 'stop';
        if (tocouAlvo) return 'alvo';
    }
    return 'aberto';
}

/** Extremos do caminho, em fração do preço de entrada. Útil para ver o teto do que é capturável. */
export function excursoes(params: { entrada: Decimal; direcao: 'alta' | 'baixa'; velas: Vela1m[] }): {
    favoravel: Decimal;
    adversa: Decimal;
} {
    const alta = params.direcao === 'alta';
    let favoravel = new Decimal(0);
    let adversa = new Decimal(0);
    for (const v of params.velas) {
        const fav = alta
            ? v.maxima.minus(params.entrada).dividedBy(params.entrada)
            : params.entrada.minus(v.minima).dividedBy(params.entrada);
        const adv = alta
            ? params.entrada.minus(v.minima).dividedBy(params.entrada)
            : v.maxima.minus(params.entrada).dividedBy(params.entrada);
        if (fav.greaterThan(favoravel)) favoravel = fav;
        if (adv.greaterThan(adversa)) adversa = adv;
    }
    return { favoravel, adversa };
}

/** Uma célula da grade: o que teria acontecido com este par (alvo, stop). */
export interface CelulaDaGrade {
    alvo: Decimal;
    stop: Decimal;
    alvos: number;
    stops: number;
    abertos: number;
    /** Acerto entre os caminhos RESOLVIDOS (alvo + stop). Os abertos não votam. */
    taxaDeAcerto: Decimal;
    /** Lucro esperado por operação, em fração do NOCIONAL, já líquido de taxa. */
    evPorOperacao: Decimal;
    /** Acerto que esta célula EXIGIRIA para empatar. */
    acertoDeEquilibrio: Decimal;
    /**
     * Acerto que um passeio ALEATÓRIO daria neste par (alvo, stop).
     *
     * Sem esta linha de base, 62,9% parece ótimo. Com ela, sabe-se que para
     * alvo 0,8% e stop 1,0% o acaso já entrega 55,6% — e que a "vantagem"
     * eram 7 pontos, não 63.
     */
    acaso: Decimal;
    /**
     * Desvios-padrão acima do acaso.
     *
     * É o número que separa achado de sorte. Escolhendo o máximo entre 126
     * combinações, encontrar uma a 1,1 desvio acima do acaso é o ESPERADO —
     * acontece quase sempre, mesmo quando não existe vantagem nenhuma.
     */
    z: Decimal;
}

/**
 * O acerto de um passeio aleatório sem deriva.
 *
 * Para um preço que sobe e desce sem tendência, a chance de tocar +alvo antes
 * de −stop é stop/(alvo+stop): quanto mais longe o alvo em relação ao stop,
 * menos vezes ele chega. É por isso que alvo curto com stop largo "acerta
 * muito" sem valer nada — o acerto alto já vem embutido na geometria, e a
 * taxa continua cobrando.
 */
export function acasoDaCelula(alvo: Decimal, stop: Decimal): Decimal {
    const soma = alvo.plus(stop);
    if (soma.lessThanOrEqualTo(0)) return new Decimal('0.5');
    return stop.dividedBy(soma);
}

export interface TaxasDaOperacao {
    /** Entrada é sempre taker: o sinal exige velocidade. */
    entrada: Decimal;
    /** Saída no alvo pode ser maker (ordem limitada parada no livro). */
    alvo: Decimal;
    /** Saída no stop é sempre taker: tem de preencher. */
    stop: Decimal;
}

/**
 * Avalia CADA par (alvo, stop) contra os caminhos medidos.
 *
 * O EV sai em fração do nocional porque é assim que ele escala: dobrar o
 * nocional dobra o resultado, e a banca só entra depois, na hora de decidir
 * quanto arriscar (ver kelly.ts).
 *
 * Caminhos que não resolveram dentro da janela ('aberto') são excluídos do
 * acerto mas contados no campo `abertos`. Contá-los como perda inventaria
 * prejuízo; como ganho, inventaria lucro. O honesto é dizer quantos foram —
 * uma grade com muitos abertos significa janela curta demais, não estratégia
 * ruim.
 */
export function avaliarGrade(params: {
    caminhos: CaminhoDeSinal[];
    alvos: Decimal[];
    stops: Decimal[];
    taxas: TaxasDaOperacao;
}): CelulaDaGrade[] {
    const celulas: CelulaDaGrade[] = [];

    for (const alvo of params.alvos) {
        for (const stop of params.stops) {
            let alvos = 0;
            let stops = 0;
            let abertos = 0;

            for (const c of params.caminhos) {
                const d = desfechoNoCaminho({ entrada: c.entrada, direcao: c.direcao, alvo, stop, velas: c.velas });
                if (d === 'alvo') alvos += 1;
                else if (d === 'stop') stops += 1;
                else abertos += 1;
            }

            const resolvidos = alvos + stops;
            const p = resolvidos > 0 ? new Decimal(alvos).dividedBy(resolvidos) : new Decimal(0);

            const ganho = alvo.minus(params.taxas.entrada).minus(params.taxas.alvo);
            const perda = stop.plus(params.taxas.entrada).plus(params.taxas.stop);
            const ev = p.mul(ganho).minus(new Decimal(1).minus(p).mul(perda));
            const equilibrio = ganho.plus(perda).isZero() ? new Decimal(1) : perda.dividedBy(ganho.plus(perda));

            const acaso = acasoDaCelula(alvo, stop);
            // z = (p medido − p do acaso) / erro padrão. Com poucos caminhos o
            // erro padrão é grande e quase nada passa — que é exatamente o
            // comportamento certo.
            const variancia = acaso.mul(new Decimal(1).minus(acaso));
            const z =
                resolvidos > 0 && variancia.greaterThan(0)
                    ? p.minus(acaso).dividedBy(variancia.dividedBy(resolvidos).sqrt())
                    : new Decimal(0);

            celulas.push({
                alvo,
                stop,
                alvos,
                stops,
                abertos,
                taxaDeAcerto: p,
                evPorOperacao: ev,
                acertoDeEquilibrio: equilibrio,
                acaso,
                z,
            });
        }
    }
    return celulas;
}

/**
 * A melhor célula — ou nenhuma.
 *
 * `minimoResolvidos` existe porque a célula de maior EV numa amostra pequena é
 * quase sempre ruído: entre centenas de combinações, alguma sempre parece
 * excelente por acaso. Exigir amostra é o que separa medir de garimpar.
 */
export function melhorDaGrade(params: {
    celulas: CelulaDaGrade[];
    minimoResolvidos: number;
    /**
     * Desvios acima do acaso exigidos.
     *
     * O padrão 3,0 é a correção para comparações múltiplas: testando 126
     * combinações a 5%, cerca de SEIS pareceriam significativas por puro
     * acaso. Bonferroni sobre 126 pede ~3,5; 3,0 é um meio-termo consciente
     * entre não anunciar ruído e não descartar efeito verdadeiro.
     *
     * Sem isto, `melhorDaGrade` era um selecionador de máximo — e o máximo de
     * 126 células correlacionadas está SEMPRE acima do acaso, exista ou não
     * vantagem. O sintoma foi a melhor célula trocar de lugar entre dois
     * relatórios com cinco minutos de diferença.
     */
    zMinimo?: number;
}): CelulaDaGrade | null {
    const zMin = new Decimal(params.zMinimo ?? 3);
    const elegiveis = params.celulas.filter(
        (c) =>
            c.alvos + c.stops >= params.minimoResolvidos &&
            c.evPorOperacao.greaterThan(0) &&
            c.z.greaterThanOrEqualTo(zMin),
    );
    if (elegiveis.length === 0) return null;
    return elegiveis.reduce((melhor, c) => {
        const diff = c.evPorOperacao.comparedTo(melhor.evPorOperacao);
        if (diff > 0) return c;
        if (diff < 0) return melhor;
        // Empate no EV: fica o de stop mais curto — mesma expectativa com menos
        // capital em risco por operação é estritamente melhor.
        return c.stop.lessThan(melhor.stop) ? c : melhor;
    });
}

/** Grade padrão: alvos de 0,2% a 1,5%, stops de 0,2% a 1,0%, passo de 0,1pp. */
export function gradePadrao(): { alvos: Decimal[]; stops: Decimal[] } {
    const alvos: Decimal[] = [];
    const stops: Decimal[] = [];
    for (let i = 2; i <= 15; i += 1) alvos.push(new Decimal(i).dividedBy(1000));
    for (let i = 2; i <= 10; i += 1) stops.push(new Decimal(i).dividedBy(1000));
    return { alvos, stops };
}
