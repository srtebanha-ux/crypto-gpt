// Arquivo: src/ricochete.ts
//
// Caçador de ricochete: não compra a queda, compra a CONFIRMAÇÃO da volta.
//
// A diferença entre os dois não é de estilo, é estrutural. Comprando a queda
// a 30x, a liquidação fica 2,83% abaixo da entrada, ou seja DENTRO da cascata
// que ainda está acontecendo — a faca corta antes de o fundo existir.
// Comprando o repique, a entrada fica acima do fundo, e a liquidação vai
// parar ABAIXO de um preço que o mercado acabou de testar e rejeitar.
//
// Só que essa proteção tem um TETO, e ele é estreito. Entrando a um repique
// `r` acima do fundo, a liquidação cai em:
//
//     fundo × (1 + r) × (1 − 0,0283)
//
// Isso só fica abaixo do fundo enquanto (1 + r) × 0,9717 < 1, ou seja
// enquanto r < 2,91%. Repicou 3,5% antes de o bot entrar? A liquidação
// passa para CIMA do fundo, e um simples reteste — o movimento mais comum
// que existe depois de uma agulhada — liquida a posição.
//
// Por isso o gatilho aqui tem piso E teto. Um repique tarde demais não é uma
// entrada pior: é uma entrada sem a proteção que justificava a operação
// inteira. `janelaDeEntrada` calcula esse teto a partir da alavancagem real,
// em vez de fixá-lo — a 20x o teto é 5,0%, a 10x é 10,6%, e cada alavancagem
// tem a sua.
import { Decimal } from 'decimal.js';
import { Vela1m } from './volumeSpike';
import { movimentoAteLiquidacao } from './futurosMath';

export type FaseDoRicochete = 'caindo' | 'disparado';

export interface EstadoDeRicochete {
    fase: FaseDoRicochete;
    /** Menor preço visto desde que a queda foi detectada. */
    fundo: Decimal;
    /** Quando o fundo foi marcado. Reinicia a cada novo fundo: a cascata ainda anda. */
    fundoEmMs: number;
    /** Preço de onde a queda partiu — só para relatório. */
    referencia: Decimal;
}

export interface SinalDeRicochete {
    entrada: Decimal;
    fundo: Decimal;
    /** Repique real no momento da entrada, em fração do fundo. */
    repique: Decimal;
    /** Queda que originou o evento, em fração. */
    queda: Decimal;
    /** Onde a liquidação cai em relação ao FUNDO. Negativo = abaixo (protegido). */
    liquidacaoVsFundo: Decimal;
}

/**
 * O repique máximo que ainda deixa a liquidação abaixo do fundo.
 *
 * É o teto da janela de entrada. Acima dele, a operação perde a única coisa
 * que a distinguia de comprar faca caindo.
 */
export function janelaDeEntrada(params: { alavancagem: Decimal; manutencao: Decimal }): Decimal {
    const mov = movimentoAteLiquidacao(params);
    if (mov.greaterThanOrEqualTo(1)) return new Decimal(0);
    // (1+r)(1−mov) < 1  =>  r < 1/(1−mov) − 1
    return new Decimal(1).dividedBy(new Decimal(1).minus(mov)).minus(1);
}

/** Onde a liquidação cai em relação ao fundo. Negativo = abaixo do fundo. */
export function liquidacaoVsFundo(params: {
    entrada: Decimal;
    fundo: Decimal;
    alavancagem: Decimal;
    manutencao: Decimal;
}): Decimal {
    const mov = movimentoAteLiquidacao({ alavancagem: params.alavancagem, manutencao: params.manutencao });
    const precoLiq = params.entrada.mul(new Decimal(1).minus(mov));
    return precoLiq.minus(params.fundo).dividedBy(params.fundo);
}

export interface ParametrosDoRicochete {
    /** Queda mínima numa vela para abrir o evento (0.08 = 8%). */
    quedaMinima: Decimal;
    /** Repique mínimo a partir do fundo para disparar (0.02 = 2%). */
    repiqueMinimo: Decimal;
    /** Repique máximo aceito. Acima disso a liquidação sobe acima do fundo. */
    repiqueMaximo: Decimal;
    /** Tempo máximo esperando o repique depois do último fundo. */
    janelaMs: number;
    alavancagem: Decimal;
    manutencao: Decimal;
}

/**
 * Um passo da máquina de estados, por símbolo.
 *
 * Recebe o estado atual (ou null) e a vela mais recente; devolve o estado
 * seguinte e, quando for o caso, o sinal. Estado fora da função de propósito:
 * assim ela é testável sem relógio, sem rede e sem instância.
 */
export function passoDoRicochete(params: {
    estado: EstadoDeRicochete | null;
    vela: Vela1m;
    agoraMs: number;
    cfg: ParametrosDoRicochete;
}): { estado: EstadoDeRicochete | null; sinal: SinalDeRicochete | null } {
    const { vela, cfg } = params;

    if (params.estado === null) {
        if (vela.abertura.lessThanOrEqualTo(0)) return { estado: null, sinal: null };
        const queda = vela.abertura.minus(vela.minima).dividedBy(vela.abertura);
        if (queda.lessThan(cfg.quedaMinima)) return { estado: null, sinal: null };
        return {
            estado: { fase: 'caindo', fundo: vela.minima, fundoEmMs: params.agoraMs, referencia: vela.abertura },
            sinal: null,
        };
    }

    const e = params.estado;
    if (e.fase === 'disparado') return { estado: e, sinal: null };

    // Novo fundo: a cascata ainda está acontecendo. Marca e RECOMEÇA o relógio
    // — comprar o primeiro repique de 2% no meio de uma queda em curso é
    // exatamente o erro que a confirmação existia para evitar.
    if (vela.minima.lessThan(e.fundo)) {
        return {
            estado: { ...e, fundo: vela.minima, fundoEmMs: params.agoraMs },
            sinal: null,
        };
    }

    if (params.agoraMs - e.fundoEmMs > cfg.janelaMs) {
        // Sem repique dentro da janela: não foi mola, foi degrau. Descarta.
        return { estado: null, sinal: null };
    }

    const repique = vela.fechamento.minus(e.fundo).dividedBy(e.fundo);
    if (repique.lessThan(cfg.repiqueMinimo)) return { estado: e, sinal: null };

    if (repique.greaterThan(cfg.repiqueMaximo)) {
        // Repicou demais antes de a gente entrar. Entrar aqui põe a liquidação
        // ACIMA do fundo — perde a proteção inteira. Melhor não existir.
        return { estado: null, sinal: null };
    }

    const vsFundo = liquidacaoVsFundo({
        entrada: vela.fechamento,
        fundo: e.fundo,
        alavancagem: cfg.alavancagem,
        manutencao: cfg.manutencao,
    });

    return {
        estado: { ...e, fase: 'disparado' },
        sinal: {
            entrada: vela.fechamento,
            fundo: e.fundo,
            repique,
            queda: e.referencia.minus(e.fundo).dividedBy(e.referencia),
            liquidacaoVsFundo: vsFundo,
        },
    };
}

/** Parâmetros padrão, com o teto derivado da alavancagem em vez de chutado. */
export function parametrosPadrao(params: {
    alavancagem: Decimal;
    manutencao?: Decimal;
    quedaMinima?: Decimal;
    repiqueMinimo?: Decimal;
    janelaMs?: number;
}): ParametrosDoRicochete {
    const manutencao = params.manutencao ?? new Decimal('0.005');
    const teto = janelaDeEntrada({ alavancagem: params.alavancagem, manutencao });
    return {
        quedaMinima: params.quedaMinima ?? new Decimal('0.08'),
        repiqueMinimo: params.repiqueMinimo ?? new Decimal('0.02'),
        // Margem de segurança: 90% do teto teórico, para o preço andar entre a
        // decisão e o preenchimento sem estourar a proteção.
        repiqueMaximo: teto.mul('0.9'),
        janelaMs: params.janelaMs ?? 5 * 60_000,
        alavancagem: params.alavancagem,
        manutencao,
    };
}
