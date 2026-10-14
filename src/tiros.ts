// Arquivo: src/tiros.ts
//
// O que aconteceu DEPOIS de atirar.
//
// O cacador escrevia "TIRO DE ELITE DISPARADO!" no instante em que mandava a
// transacao, e nunca mais olhava. Mas disparar nao e acertar: numa corrida por
// liquidacao o desfecho mais provavel e a transacao REVERTER, porque outro
// chegou antes e a posicao ja nao esta liquidavel quando a sua entra.
//
// Sem acompanhar o recibo, acerto e erro produzem exatamente o mesmo log — e
// quem le acha que ganhou. E a mesma familia de defeito que este projeto mais
// encontra: ausencia com cara de resposta.
import { Decimal } from 'decimal.js';

export type DesfechoDoTiro = 'acertou' | 'reverteu' | 'sumiu';

/**
 * O que o recibo diz.
 *
 * `status === 1` e a unica coisa que significa acerto. Recibo ausente NAO e
 * acerto: quer dizer que a transacao nao foi minerada no tempo que se esperou,
 * e isso precisa aparecer com nome proprio, nao virar silencio.
 */
export function lerRecibo(recibo: { status?: number | null } | null | undefined): DesfechoDoTiro {
    if (!recibo) return 'sumiu';
    if (recibo.status === 1) return 'acertou';
    return 'reverteu';
}

export interface PlacarDosTiros {
    disparados: number;
    acertou: number;
    reverteu: number;
    sumiu: number;
    /**
     * O lucro ESTIMADO dos acertos — nao o realizado.
     *
     * Vem da medicao por eth_call feita no bloco anterior, e o contrato so
     * garante 80% dela (`lucroMinimo`). Chamar isso de "no cofre" apresentava
     * estimativa como caixa, com ate 20% de sobra para cima. O numero que vale
     * e o saldo do cofre no basescan; este aqui serve para comparar tiros
     * entre si, nao para contar dinheiro.
     */
    lucroEstimadoUsd: Decimal;
    /**
     * Quantos dos `disparados` foram APOSTA na escrita do oraculo, e nao tiro
     * sobre posicao ja liquidavel.
     *
     * MEDIDO em 2026-10-08: o log imprimiu "7 de 7 reverteram: outro chegou
     * antes. E corrida perdida por pouco" sobre os SETE tiros especulativos do
     * dia anterior. Ninguem chegou antes: a posicao nunca cruzou, e nao havia
     * o que levar. Em 07/10 eu consertei exatamente essa frase na linha
     * `[ERROU]`, que ja segue o tipo do tiro — e deixei a GEMEA solta no
     * placar, porque o placar nao sabia o tipo. REGRA 3, sexta vez.
     *
     * As duas reversoes pedem conserto OPOSTO: a de corrida perdida pede
     * lance maior ou ciclo mais curto; a da aposta pede alvo mais valioso ou
     * previsao melhor, e lance maior so a encarece. Uma frase que troca uma
     * pela outra manda consertar a coisa errada.
     *
     * `null` E "NAO REGISTREI", E NAO ZERO — e a distincao custou um deploy.
     *
     * A primeira versao deste campo fazia o cache antigo voltar com zero. O
     * log de 2026-10-08 13:14, com o conserto JA no ar, imprimiu a frase
     * errada outra vez: os sete tiros foram contados antes de o campo existir,
     * voltaram como `0 especulativos`, e `0 >= 7` e falso — entao a frase caiu
     * no ramo "outro chegou antes" e afirmou, com confianca, exatamente o que
     * o conserto existia para impedir. Para sempre, porque aquele cache nunca
     * vai aprender o tipo deles.
     *
     * E a assinatura deste projeto cometida DENTRO do conserto dela: campo
     * ausente virando zero, e o zero publicado como fato positivo. Ausencia
     * com cara de resposta.
     */
    especulativos: number | null;
}

export function placarVazio(): PlacarDosTiros {
    return {
        disparados: 0, acertou: 0, reverteu: 0, sumiu: 0,
        lucroEstimadoUsd: new Decimal(0), especulativos: 0,
    };
}

/**
 * Soma um desfecho. O lucro so entra quando o tiro ACERTOU.
 *
 * `disparados` conta aqui, e nao em quem envia: todo tiro termina em um dos
 * tres desfechos, entao somar no desfecho garante que o total e o denominador
 * e nunca fique menor que a soma das partes.
 */
export function contarTiro(
    p: PlacarDosTiros,
    d: DesfechoDoTiro,
    lucroUsd: Decimal | null,
    especulativo = false,
): PlacarDosTiros {
    const novo: PlacarDosTiros = { ...p, lucroEstimadoUsd: p.lucroEstimadoUsd, disparados: p.disparados + 1 };
    novo[d] += 1;
    // Contar a partir de `null` adota o zero: o que nao foi registrado antes
    // continua nao registrado, e o que esta sendo contado agora conta.
    if (especulativo) novo.especulativos = (p.especulativos ?? 0) + 1;
    else if (novo.especulativos === null) novo.especulativos = 0;
    if (d === 'acertou' && lucroUsd !== null) novo.lucroEstimadoUsd = p.lucroEstimadoUsd.plus(lucroUsd);
    return novo;
}

/**
 * Serializa o placar para o cache. O Decimal vira TEXTO, nao numero.
 *
 * `JSON.stringify` de um Decimal produz `{"s":1,"e":1,"d":[91,4]}` — os
 * internos da biblioteca — e `new Decimal` nao le isso de volta. O lucro
 * voltaria como objeto torto ou como zero, em silencio.
 */
export interface PlacarNoDisco {
    disparados: number;
    acertou: number;
    reverteu: number;
    sumiu: number;
    /** TEXTO, nao numero: ver a docstring de `placarParaCache`. */
    lucroEstimadoUsd: string;
    /** Opcional: cache gravado antes de 2026-10-08 nao tem o campo. */
    especulativos?: number;
}

export function placarParaCache(p: PlacarDosTiros): PlacarNoDisco {
    return {
        disparados: p.disparados,
        acertou: p.acertou,
        reverteu: p.reverteu,
        sumiu: p.sumiu,
        lucroEstimadoUsd: p.lucroEstimadoUsd.toString(),
        // `null` nao vai ao disco: ausencia no arquivo JA significa
        // "nao registrei", e gravar `null` seria dizer a mesma coisa duas
        // vezes de formas que podem divergir.
        ...(p.especulativos === null ? {} : { especulativos: p.especulativos }),
    };
}

/**
 * Le o placar do cache. NUNCA lanca, e campo torto nao contamina o resto.
 *
 * Um arquivo antigo nao tem o campo, e um adulterado pode ter qualquer coisa.
 * Nos dois casos a resposta certa e o placar vazio: perder a contagem e
 * barato, contar errado nao.
 */
export function placarDoCache(x: unknown): PlacarDosTiros {
    if (typeof x !== 'object' || x === null) return placarVazio();
    const c = x as Record<string, unknown>;
    const inteiro = (v: unknown): number => (
        typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
    );
    const acertou = inteiro(c.acertou);
    const reverteu = inteiro(c.reverteu);
    const sumiu = inteiro(c.sumiu);
    let lucro = new Decimal(0);
    try {
        if (typeof c.lucroEstimadoUsd === 'string') lucro = new Decimal(c.lucroEstimadoUsd);
    } catch { lucro = new Decimal(0); }
    if (!lucro.isFinite() || lucro.isNegative()) lucro = new Decimal(0);
    return {
        // `disparados` e a SOMA, nao o campo gravado: se os dois discordarem,
        // o denominador tem de ser maior ou igual as partes, senao a taxa de
        // acerto passa de 100% e o placar vira ficcao.
        disparados: Math.max(inteiro(c.disparados), acertou + reverteu + sumiu),
        acertou,
        reverteu,
        sumiu,
        lucroEstimadoUsd: lucro,
        // AUSENTE E `null`, NAO ZERO. Ver a docstring do campo: foi este
        // default que fez a frase errada sair de novo com o conserto no ar.
        // Um valor torto (texto, negativo, fracionario) tambem e `null`: nao
        // sei e melhor que sei errado.
        //
        // Teto no total: um campo adulterado nao pode fazer "especulativos"
        // passar de "disparados" e a frase afirmar mais apostas do que tiros.
        especulativos: typeof c.especulativos === 'number'
            && Number.isInteger(c.especulativos) && c.especulativos >= 0
            ? Math.min(
                c.especulativos,
                Math.max(inteiro(c.disparados), acertou + reverteu + sumiu),
            )
            : null,
    };
}

/**
 * O que a CORRENTE diz sobre quantas transacoes sairam desta carteira.
 *
 * MEDIDO em 2026-10-06: o nonce da `conta_bot` estava em 6 e o log dizia
 * "Nenhum tiro ainda". Duas transacoes sairam e o bot nao sabia de nenhuma,
 * porque o placar morava em memoria e o Railway reinicia o container varias
 * vezes por dia. Levou meia hora de investigacao para descobrir que a
 * ausencia era de MEMORIA e nao de tiro — ausencia com cara de resposta, no
 * numero que responde "ele ja atirou?".
 *
 * O nonce e a resposta de fora, custa zero (ja e lido no boot) e nunca volta
 * para tras. O que ele NAO diz e que toda transacao foi um tiro: a carteira
 * poderia ter mandado outra coisa. Por isso a frase fala em TRANSACOES e
 * manda conferir, em vez de afirmar tiros que nao foram contados.
 */
/**
 * AS TRANSACOES JA RECONCILIADAS FORA DO PLACAR, com a prova de cada grupo.
 *
 * Isto NAO e um palpite nem um ajuste para a conta fechar. E o registro de uma
 * reconciliacao que ja foi feita e esta documentada no CLAUDE.md (2026-10-09):
 * as transacoes da carteira foram achadas por particao recursiva do nonce
 * (`eth_getTransactionCount` e monotonico) e LIDAS nos recibos, com ZERO nonce
 * sem transacao achada — cobertura 100% de nonce 0 a 44.
 *
 * Ela mandou: *"Nao reconstrua novamente as transacoes. Use os registros e
 * provas existentes."* Entao e isso: os numeros abaixo vem daquela varredura,
 * e nenhum deles foi recalculado aqui.
 *
 * POR QUE O PLACAR DIVERGE, e a divergencia e dele e nao da corrente:
 *
 *     a corrente (nonce)        45 transacoes saidas
 *     o placar no Railway       31 tiros contados
 *     diferenca                 14
 *
 * E as 14 estao INTEIRAMENTE explicadas, em dois grupos de causas diferentes:
 *
 *     8 tiros de 07/10   foram contados e DEPOIS APAGADOS DO DISCO pelo write
 *                        do boot, que nao levava o campo `placar`. O defeito
 *                        esta consertado (e o teste que le os gravadores de
 *                        cache o impede de voltar), mas o conserto impede a
 *                        PROXIMA perda — nao desfaz esta. Todos reverteram
 *     6 de instalacao    nonce 0 a 5. As de nonce 4 e 5 gastaram 3,67M de gas
 *                        cada: sao DEPLOYS DE CONTRATO. Nenhuma foi tiro
 *
 * O que isto corrige na frase: `45 - 31 = 14` e aritmeticamente certo e
 * FACTUALMENTE enganoso, porque trata como desconhecidas 14 transacoes das
 * quais nenhuma e desconhecida. Dizer "sairam sem eu lembrar" sobre transacao
 * reconciliada e ausencia com cara de resposta ao contrario: eu TENHO a
 * resposta e publico a duvida.
 *
 * E o que ele NAO faz, de proposito: NAO entra em `disparados`, nao mexe em
 * `acertou` e nao vai ao disco. O placar continua contando o que ele proprio
 * viu — somar aqui inflaria o denominador de uma taxa de acerto com tiros que
 * este cache nunca registrou, e as 8 foram todas REVERSOES: nada a creditar.
 */
export const RECONCILIADAS_FORA_DO_PLACAR = {
    /** Tiros reais, lidos nos recibos, apagados do disco pelo write do boot. */
    tirosPerdidosDoDisco: 8,
    /** Deploys e instalacao: nonce 0 a 5, nenhuma delas um tiro. */
    instalacao: 6,
    /** O nonce ate onde a reconciliacao por recibo tem cobertura 100%. */
    nonceReconciliadoAte: 45,
    prova: 'CLAUDE.md 2026-10-09: partição recursiva do nonce + leitura dos recibos, '
        + 'cobertura 100% de nonce 0 a 44, zero nonce sem transação achada',
} as const;

export function oQueACorrenteDiz(p: PlacarDosTiros, nonce: number | null | undefined): string | null {
    if (nonce === null || nonce === undefined || !Number.isFinite(nonce) || nonce < 0) return null;
    if (nonce <= p.disparados) return null;
    const faltam = nonce - p.disparados;
    const r = RECONCILIADAS_FORA_DO_PLACAR;
    // A RECONCILIACAO SO VALE DENTRO DA JANELA QUE ELA COBRE.
    //
    // Ela foi medida ate o nonce 45. Um nonce ACIMA disso tem transacao que
    // aquela varredura nao viu, e aplicar o registro ali seria estender uma
    // medicao para fora da janela dela — a REGRA 4 deste projeto. Entao: o que
    // cabe na janela e explicado, e o que passa dela continua desconhecido.
    const explicaveis = Math.max(0, Math.min(faltam, r.nonceReconciliadoAte - p.disparados));
    const reconciliadas = Math.min(explicaveis, r.tirosPerdidosDoDisco + r.instalacao);
    const semExplicacao = faltam - reconciliadas;
    const base = `A corrente diz ${nonce} transações já saídas desta carteira e eu contei `
        + `${p.disparados} tiro(s): ${faltam} não estão nesta contagem.`;
    if (reconciliadas === 0) {
        return `${base} Saíram sem eu lembrar — antes deste boot, ou antes de existir cache. `
            + 'Confira no basescan.';
    }
    // A FRASE DESCREVE O CONJUNTO QUE ELA CONTA, e nao o registro inteiro.
    //
    // A primeira versao citava os dois grupos sempre: com nonce 2 e placar 0
    // ela dizia "2 JA ESTAO RECONCILIADAS (8 tiros … e 6 instalacao)" — numero
    // certo, prosa errada, porque 2 transacoes nao podem vir de um grupo de 8.
    // Etiqueta que nao descreve o conjunto, que e o defeito que este projeto
    // persegue desde a primeira pagina, cometido dentro do conserto dele.
    //
    // A atribuicao segue a ORDEM DO NONCE, que e o que a corrente garante: os
    // nonces 0 a 5 sao a instalacao, e os tiros vem depois dela.
    const daInstalacao = Math.min(reconciliadas, r.instalacao);
    const dosTirosPerdidos = reconciliadas - daInstalacao;
    const grupos: string[] = [];
    if (daInstalacao > 0) {
        grupos.push(`${daInstalacao} de instalação (nonces 0 a 5`
            + (daInstalacao >= r.instalacao ? ', duas delas deploys de contrato de 3,67M de gás' : '')
            + ')');
    }
    if (dosTirosPerdidos > 0) {
        grupos.push(`${dosTirosPerdidos} tiro(s) de 07/10 que o write do boot apagou do disco, `
            + 'todos revertidos');
    }
    const parteReconciliada = `Dessas, ${reconciliadas} JÁ ESTÃO RECONCILIADAS por fora `
        + `(${grupos.join('; ')}): ${r.prova}.`;
    if (semExplicacao === 0) {
        return `${base} ${parteReconciliada} Nenhuma transação desta carteira está sem `
            + 'explicação — a contagem do placar é que está incompleta, não a corrente.';
    }
    return `${base} ${parteReconciliada} Restam ${semExplicacao} FORA da janela reconciliada `
        + `(que vai até o nonce ${r.nonceReconciliadoAte}): essas eu não sei. Confira no basescan.`;
}

/**
 * O placar em uma frase, para nao virar uma tabela que ninguem sabe ler.
 *
 * Reverter muito nao e defeito do bot: e a resposta de que a corrida esta
 * sendo perdida por pouco, e isso pede conserto diferente de nao achar alvo.
 *
 * O `nonce` e opcional e serve de CONFERENCIA de fora: ver o texto completo em
 * `oQueACorrenteDiz`. Sem ele a frase e a mesma de antes.
 */
export function comoEstaIndo(p: PlacarDosTiros, nonce?: number | null): string {
    const daCorrente = oQueACorrenteDiz(p, nonce);
    const comConferencia = (frase: string) => (daCorrente === null ? frase : `${frase} ${daCorrente}`);
    // "que eu lembre", e nao "ainda": a contagem mora no cache, e cache pode
    // nao ter montado. Afirmar que nunca houve tiro e afirmar sobre o passado
    // inteiro com memoria do boot de agora.
    if (p.disparados === 0) return comConferencia('Nenhum tiro que eu lembre.');
    if (p.acertou === 0 && p.reverteu > 0) {
        // A FRASE SEGUE O TIPO DO TIRO. Ver a docstring de `especulativos`:
        // "outro chegou antes" sobre uma aposta que nao cruzou e etiqueta que
        // nao descreve o evento, e manda consertar o lance quando o que falta
        // e alvo valioso.
        //
        // E NAO REGISTRADO NAO ESCOLHE LADO. Os sete tiros de 07/10 foram
        // contados antes de o campo existir: a frase sobre eles tem de dizer
        // que nao sabe, e nao cair no ramo "outro chegou antes" por falta de
        // dado. Quem le precisa poder distinguir "medi e foi corrida" de
        // "nao registrei o tipo".
        if (p.especulativos === null) {
            return comConferencia(
                `${p.reverteu} de ${p.disparados} reverteram, e eu NÃO REGISTREI o tipo deles`
                + ' — foram contados antes de eu passar a separar aposta de corrida, então não sei'
                + ' se ninguém chegou antes (aposta que não cruzou) ou se perdi a corrida. Os dois'
                + ' pedem conserto oposto, e os próximos tiros saem com o tipo.',
            );
        }
        const todasAposta = p.especulativos >= p.disparados;
        if (todasAposta) {
            return comConferencia(
                `${p.reverteu} de ${p.disparados} reverteram, e TODOS eram aposta na escrita do oráculo:`
                + ' ninguém chegou antes — a posição não cruzou e não havia o que levar.'
                + ' Isso não é corrida perdida: lance maior não evitaria nenhuma delas, só encareceria a próxima.',
            );
        }
        if (p.especulativos > 0) {
            const corrida = p.disparados - p.especulativos;
            return comConferencia(
                `${p.reverteu} de ${p.disparados} reverteram: ${p.especulativos} eram aposta na escrita do oráculo`
                + ` (a posição não cruzou) e ${corrida} em posição já liquidável (aí sim outro chegou antes).`
                + ' Os dois pedem conserto diferente.',
            );
        }
        return comConferencia(`${p.reverteu} de ${p.disparados} reverteram: outro chegou antes. É corrida perdida por pouco, não falta de alvo.`);
    }
    const taxa = ((p.acertou / p.disparados) * 100).toFixed(0);
    // "estimado", e nao "no cofre": o numero vem da medicao, e o contrato so
    // garante 80% dela. Quem conta dinheiro e o saldo do cofre no basescan.
    return comConferencia(`${p.acertou} de ${p.disparados} acertaram (${taxa}%), ~US$ ${p.lucroEstimadoUsd.toFixed(2)} estimados (confira o cofre).`);
}
