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
    lucroUsd: Decimal;
}

export function placarVazio(): PlacarDosTiros {
    return { disparados: 0, acertou: 0, reverteu: 0, sumiu: 0, lucroUsd: new Decimal(0) };
}

/**
 * Soma um desfecho. O lucro so entra quando o tiro ACERTOU.
 *
 * `disparados` conta aqui, e nao em quem envia: todo tiro termina em um dos
 * tres desfechos, entao somar no desfecho garante que o total e o denominador
 * e nunca fique menor que a soma das partes.
 */
export function contarTiro(p: PlacarDosTiros, d: DesfechoDoTiro, lucroUsd: Decimal | null): PlacarDosTiros {
    const novo: PlacarDosTiros = { ...p, lucroUsd: p.lucroUsd, disparados: p.disparados + 1 };
    novo[d] += 1;
    if (d === 'acertou' && lucroUsd !== null) novo.lucroUsd = p.lucroUsd.plus(lucroUsd);
    return novo;
}

/**
 * O placar em uma frase, para nao virar uma tabela que ninguem sabe ler.
 *
 * Reverter muito nao e defeito do bot: e a resposta de que a corrida esta
 * sendo perdida por pouco, e isso pede conserto diferente de nao achar alvo.
 */
export function comoEstaIndo(p: PlacarDosTiros): string {
    if (p.disparados === 0) return 'Nenhum tiro ainda.';
    if (p.acertou === 0 && p.reverteu > 0) {
        return `${p.reverteu} de ${p.disparados} reverteram: outro chegou antes. É corrida perdida por pouco, não falta de alvo.`;
    }
    const taxa = ((p.acertou / p.disparados) * 100).toFixed(0);
    return `${p.acertou} de ${p.disparados} acertaram (${taxa}%), US$ ${p.lucroUsd.toFixed(2)} no cofre.`;
}
