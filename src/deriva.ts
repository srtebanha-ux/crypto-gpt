// Arquivo: src/deriva.ts
//
// QUANDO o alvo chega — para os alvos que nao dependem de preco nenhum.
//
// Isto sai de uma medicao, nao de uma ideia. Dois ensaios em seco a 9,57
// minutos de distancia, no mesmo devedor:
//
//     10:08:27  pediriaEmprestado 45869907
//     10:18:01  pediriaEmprestado 45869948
//
// 41 unidades de USDC em 9,57 minutos. Anualizado: 4,911% ao ano. Isso nao e
// preco andando — e a taxa de juros do emprestimo. A garantia dessa pessoa e
// USDC e a divida dela e USDC, e ai acontece uma coisa limpa: o preco CANCELA.
//
//     saude = (quantidade x preco x limiar) / (quantidade x preco)
//
// O preco aparece em cima e embaixo e vai embora. O que sobra e so a diferenca
// entre o juro que ela paga e o juro que ela recebe. A saude dessa posicao cai
// numa linha, sozinha, sem o mercado precisar fazer nada.
//
// E uma linha da para extrapolar. Enquanto o resto do bot corre atras de preco
// com WebSocket e ritmo de 200ms para chegar antes dos outros, ESTE tipo de
// alvo tem hora marcada — e a hora e calculavel dias antes.
//
// A divida cresce exponencialmente (juro sobre juro), entao a saude decai
// exponencialmente, entao `ln(saude)` e uma reta no tempo. A conta certa e no
// log, e nao e mais difícil que a errada:
//
//     saude(t) = saude1 x e^(k(t - t1)),  k = (ln s1 - ln s0) / (t1 - t0)
//     cruza 1 quando  t - t1 = -ln(saude1) / k
//
// O RISCO deste arquivo, e o motivo de metade dele ser guarda: numa posicao de
// moedas DIFERENTES a saude tambem anda, mas anda por preco. Extrapolar preco
// como se fosse juro produziria "cruza em 2 horas" a partir de um tropeco de
// 0,1% do ETH — uma previsao com cara de certeza, o defeito que este projeto
// ja achou umas vinte vezes. As tres guardas abaixo existem so para isso.
import { Decimal } from 'decimal.js';
import { SAUDE_UM } from './posicoes';
import { numeroDoAmbiente } from './prontidao';

export interface Amostra {
    /** `Date.now()` de quando a saude foi lida. */
    em: number;
    /** A saude crua da Aave, com 18 casas. */
    saude: Decimal;
}

/**
 * De quanto em quanto tempo guardar uma leitura.
 *
 * Era 600.000 ms — dez minutos — com o comentario "nao adianta amostrar a cada 8
 * segundos: o juro nao mexe nada nesse prazo". MEDIDO EM 2026-09-28, e e falso.
 *
 * A posicao `0x4015e52c` foi lida em varios blocos antes de ser liquidada, com a
 * saude crua de 18 casas:
 *
 *     -60 blocos (120s): 1000000023644295459
 *     -30 blocos  (60s): 1000000011592022699
 *     -10 blocos  (20s): 1000000003629135045
 *      -8 blocos  (16s): 1000000002834062669
 *
 * Entre -60 e -30 a deriva e 4,02e-10 de saude por bloco. Entre -10 e -8 — dois
 * blocos, QUATRO SEGUNDOS — e 3,97e-10. **Diferenca de 1%.** Com 18 casas, quatro
 * segundos de juro sao 1,6e-9, ou 1.600.000.000 de unidades cruas: nao e ruido, e
 * sinal limpo.
 *
 * O custo daquele numero: com tres amostras minimas a dez minutos, o previsor
 * ficava CEGO por vinte minutos depois de cada reinicio do container — e o
 * container reinicia varias vezes por dia. O log registrou "nao projetavel: so 1
 * amostra(s)" em boot depois de boot.
 *
 * A memoria nao era o motivo: `MAX_AMOSTRAS` ja limita por devedor, qualquer que
 * seja o intervalo.
 */
export const INTERVALO_DA_AMOSTRA_MS = numeroDoAmbiente('CACA_AMOSTRA_MS', process.env.CACA_AMOSTRA_MS, 8000);
/**
 * Quantas guardar por devedor. Doze a 8 segundos cobrem uns 88 segundos.
 *
 * Validado de proposito: com `NaN` aqui o `while (lista.length > NaN)` nunca corta,
 * e o historico de 233 devedores cresce para sempre ate o container morrer.
 */
export const MAX_AMOSTRAS = numeroDoAmbiente('CACA_MAX_AMOSTRAS', process.env.CACA_MAX_AMOSTRAS, 12);
/** Duas amostras nao mostram tendencia: mostram uma diferenca. */
export const MINIMO_DE_AMOSTRAS = 3;

const MS_POR_ANO = new Decimal(365 * 24 * 3600 * 1000);

/**
 * O teto da deriva plausivel, em taxa continua ao ano.
 *
 * Juro de emprestimo em stablecoin vive entre 1% e 30% ao ano. Uma "deriva" de
 * 100% ao ano para cima nao e juro: e preco se mexendo, ou alguem que sacou
 * garantia. A conta que prova o numero: uma queda de 0,1% de saude em 30
 * minutos da 1.752% ao ano — duas ordens de grandeza acima deste teto, e por
 * isso o teto separa as duas coisas sem precisar saber quais moedas sao.
 */
export const TETO_DA_DERIVA_ANUAL = new Decimal(1);
/** Abaixo disto e ruido de arredondamento, nao tendencia. */
export const PISO_DA_DERIVA_ANUAL = new Decimal(0.0001);

export type Projecao =
    | { cruza: false; porque: string }
    | { cruza: true; emMs: number; taxaAnual: Decimal; amostras: number; spanMs: number };

/**
 * Guarda uma leitura de saude, se ela adiciona informacao.
 *
 * A brasa e lida a cada ciclo e guardar tudo seria encher a memoria com 234
 * devedores x centenas de leituras. O intervalo vive em `INTERVALO_DA_AMOSTRA_MS`,
 * que desde 2026-09-28 e de 8 segundos: a medicao daquele dia mostrou que quatro
 * segundos de juro sao 1,6e-9 de saude — 1.600.000.000 de unidades cruas —, e que
 * o intervalo de dez minutos que morava aqui deixava o previsor cego por vinte
 * minutos depois de cada reinicio.
 */
export function registrar(
    historico: Map<string, Amostra[]>,
    devedor: string,
    saude: Decimal,
    agora: number,
    intervaloMs = INTERVALO_DA_AMOSTRA_MS,
    maximo = MAX_AMOSTRAS,
): void {
    const chave = devedor.toLowerCase();
    const lista = historico.get(chave) ?? [];
    const ultima = lista[lista.length - 1];
    if (ultima !== undefined && agora - ultima.em < intervaloMs) return;
    lista.push({ em: agora, saude });
    while (lista.length > maximo) lista.shift();
    historico.set(chave, lista);
}

/**
 * Esquece quem saiu da brasa.
 *
 * Sem isto o historico cresce para sempre e — pior — uma posicao que sumiu da
 * lista (pagou, foi liquidada por outro) deixaria amostras velhas para tras
 * que, se ela voltasse, seriam misturadas com as novas. Reta ajustada em cima
 * de dois regimes diferentes e o jeito mais rapido de inventar uma previsao.
 */
export function esquecerQuemSaiu(historico: Map<string, Amostra[]>, vivos: string[]): number {
    const conjunto = new Set(vivos.map((d) => d.toLowerCase()));
    let removidos = 0;
    for (const chave of [...historico.keys()]) {
        if (!conjunto.has(chave)) { historico.delete(chave); removidos++; }
    }
    return removidos;
}

/**
 * Quando esta saude cruza 1, se ela estiver caindo por juro.
 *
 * Devolve `{cruza: false, porque}` em vez de um numero sempre que nao se pode
 * responder. O `porque` nao e enfeite: ele e a diferenca entre "nao vai
 * acontecer" e "eu nao sei", e as duas mereciam respostas opostas.
 */
export function projetar(
    amostras: Amostra[],
    minimo = MINIMO_DE_AMOSTRAS,
    tetoAnual = TETO_DA_DERIVA_ANUAL,
    pisoAnual = PISO_DA_DERIVA_ANUAL,
): Projecao {
    if (amostras.length < minimo) {
        return { cruza: false, porque: `só ${amostras.length} amostra(s); preciso de ${minimo}` };
    }

    // GUARDA 1: monotonicidade. Juro so anda para um lado. Preco vai e volta.
    // Uma unica subida no meio da serie ja delata que nao e juro.
    for (let i = 1; i < amostras.length; i++) {
        if (!amostras[i]!.saude.lessThan(amostras[i - 1]!.saude)) {
            return { cruza: false, porque: 'a saúde não cai de forma monótona — isso é preço ou depósito, não juro' };
        }
    }

    const primeira = amostras[0]!;
    const ultima = amostras[amostras.length - 1]!;
    const spanMs = ultima.em - primeira.em;
    if (spanMs <= 0) return { cruza: false, porque: 'amostras sem tempo entre elas' };

    const s0 = primeira.saude.dividedBy(SAUDE_UM);
    const s1 = ultima.saude.dividedBy(SAUDE_UM);
    if (s0.lessThanOrEqualTo(0) || s1.lessThanOrEqualTo(0)) {
        return { cruza: false, porque: 'saúde zero ou negativa' };
    }
    if (s1.lessThanOrEqualTo(1)) {
        return { cruza: true, emMs: 0, taxaAnual: new Decimal(0), amostras: amostras.length, spanMs };
    }

    // k por milissegundo, no log: e aqui que a exponencial da divida vira reta.
    const k = s1.ln().minus(s0.ln()).dividedBy(spanMs);
    if (!k.isFinite() || k.greaterThanOrEqualTo(0)) {
        return { cruza: false, porque: 'a saúde não está caindo' };
    }

    // GUARDA 2 e 3: a deriva tem de ser plausivel como JURO. Rapida demais e
    // preco; lenta demais e arredondamento.
    const taxaAnual = k.abs().mul(MS_POR_ANO);
    if (taxaAnual.greaterThan(tetoAnual)) {
        return {
            cruza: false,
            porque: `deriva de ${taxaAnual.mul(100).toFixed(0)}% ao ano é rápida demais para ser juro — é preço`,
        };
    }
    if (taxaAnual.lessThan(pisoAnual)) {
        return { cruza: false, porque: `deriva de ${taxaAnual.mul(100).toFixed(6)}% ao ano é ruído de arredondamento` };
    }

    const ms = s1.ln().dividedBy(k).negated();
    if (!ms.isFinite() || ms.lessThan(0)) return { cruza: false, porque: 'projeção não finita' };
    // Number.MAX_SAFE_INTEGER em ms e uns 285 mil anos. Acima disso o numero
    // deixa de significar coisa alguma e devolver "cruza" seria mentira.
    if (ms.greaterThan(Number.MAX_SAFE_INTEGER)) {
        return { cruza: false, porque: 'cruzaria em mais tempo que a idade do universo útil' };
    }
    return { cruza: true, emMs: ms.toNumber(), taxaAnual, amostras: amostras.length, spanMs };
}

/**
 * Em quantos BLOCOS a saude cruza 1 — a pergunta que decide se da para atirar.
 *
 * `projetar` devolve milissegundos, que servem para escolher o ritmo. Mas quem
 * decide um tiro nao conta em minutos: conta em blocos, porque a transacao tem de
 * estar DENTRO do bloco em que a saude cruza.
 *
 * Por que isso importa, medido em 2026-09-28: a posicao `0x4015e52c` ficou a
 * 0,0000024% de liquidar por mais de dois minutos e foi levada no bloco exato em
 * que cruzou. O bot le o estado DEPOIS do bloco minerado, entao no instante em que
 * ele ve "liquidavel" a posicao ja foi. Reagir nao alcanca; so chegar antes.
 *
 * Devolve `null` quando nao se pode responder — nunca um numero inventado.
 */
export function blocosAteCruzar(
    amostras: Amostra[],
    msPorBloco = 2000,
    agora = Date.now(),
    minimo = MINIMO_DE_AMOSTRAS,
): { blocos: number; taxaAnual: Decimal } | null {
    // NaN nao e pego por `<= 0`: `NaN <= 0` e falso. E com msPorBloco = NaN a
    // funcao devolvia `{blocos: NaN}` em vez de `null`, o que desliga o tiro em
    // silencio enquanto o ensaio em seco continua dizendo LIGADO.
    if (!Number.isFinite(msPorBloco) || msPorBloco <= 0) return null;
    if (!Number.isFinite(agora)) return null;
    const p = projetar(amostras, minimo);
    if (!p.cruza) return null;
    // `projetar` conta os milissegundos a partir da ULTIMA AMOSTRA, nao de agora.
    // Sem descontar o tempo decorrido, uma amostra de 8 segundos atras — quatro
    // blocos da Base — desloca a origem em 2x a janela de disparo: uma posicao que
    // cruza no proximo bloco lia "cruza em 5 blocos" e nunca era atirada, e uma que
    // lia "cruza em 2" podia ja ter cruzado. O erro de origem derrotava a unica
    // coisa que a funcao existe para fazer: cair no bloco exato.
    const ultima = amostras[amostras.length - 1]!;
    const desdeAAmostra = agora - ultima.em;
    if (!Number.isFinite(desdeAAmostra) || desdeAAmostra < 0) return null;
    const blocos = (p.emMs - desdeAAmostra) / msPorBloco;
    if (!Number.isFinite(blocos)) return null;
    // Passou do ponto: a projecao dizia que ja devia ter cruzado. Isso nao e
    // "cruza agora" — e "a leitura esta velha", e mentir de menos e melhor.
    return { blocos: Math.max(0, blocos), taxaAnual: p.taxaAnual };
}

export interface Chegada {
    devedor: string;
    emMs: number;
    taxaAnual: Decimal;
}

/**
 * Quem chega dentro da janela, do mais cedo para o mais tarde.
 *
 * A ordenacao e explicita. Fatiar uma lista que veio na ordem do `Map` e
 * publicar como ranking e o defeito mais repetido deste projeto.
 */
export function oQueVemPorAi(
    historico: Map<string, Amostra[]>,
    dentroDeMs: number,
    minimo = MINIMO_DE_AMOSTRAS,
): Chegada[] {
    const chegadas: Chegada[] = [];
    for (const [devedor, amostras] of historico) {
        const p = projetar(amostras, minimo);
        if (p.cruza && p.emMs <= dentroDeMs) {
            chegadas.push({ devedor, emMs: p.emMs, taxaAnual: p.taxaAnual });
        }
    }
    return chegadas.sort((a, b) => a.emMs - b.emMs);
}

/** Em portugues, para o log. */
export function emQuantoTempo(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(0)}min`;
    if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
    return `${(ms / 86_400_000).toFixed(1)} dias`;
}
