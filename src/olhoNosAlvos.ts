// Arquivo: src/olhoNosAlvos.ts
//
// O olho nos alvos: quanto falta para cada um cair, e quanto ele andou desde a
// ultima olhada.
//
// Existe porque em 2026-09-27 a rede foi liberada neste ambiente e, pela
// primeira vez, deu para ler a Base direto daqui em vez de esperar um deploy e
// alguem colar o log. A primeira varredura achou o que a tabela do bot escondia
// numa media: o alvo mais proximo com dinheiro de verdade esta a 1,441% e paga
// US$ 66,44 — dez vezes a media das migalhas do censo.
//
// O que ele NAO faz, e e de proposito: nao projeta quando o alvo vai cair.
//
// Esses alvos se movem por PRECO, e `src/deriva.ts` existe inteiro para recusar
// esse tipo de extrapolacao — uma queda de 0,1% em trinta minutos vira "cruza em
// duas horas", previsao com cara de certeza. `projetar` la tem tres guardas
// justamente para isso, e a primeira (monotonicidade) reprovaria qualquer serie
// de preco. Entao aqui se mostra o que ANDOU, medido, e nao o que vai andar.
import { Decimal } from 'decimal.js';

export interface Alvo {
    devedor: string;
    /** Quanto a garantia ainda pode cair, em %. `null` = saiu (pagou a divida). */
    queda: Decimal | null;
    dividaUsd: Decimal;
    lucroUsd: Decimal;
}

export interface Leitura {
    em: number;
    alvos: Alvo[];
}

export type Movimento =
    | { tipo: 'novo'; alvo: Alvo }
    | { tipo: 'saiu'; devedor: string; antes: Decimal }
    | { tipo: 'andou'; alvo: Alvo; antes: Decimal; deltaPontos: Decimal; msDesde: number };

/**
 * O que mudou entre duas leituras.
 *
 * `deltaPontos` e em PONTOS PERCENTUAIS da margem, nao em porcentagem da
 * margem: de 1,441% para 1,398% e −0,043 pontos. Dizer "caiu 3%" seria a
 * segunda leitura e as duas confundem quem le.
 *
 * Negativo quer dizer CHEGANDO MAIS PERTO. Esse sinal e contraintuitivo o
 * bastante para merecer nome proprio em quem chama.
 */
export function compararLeituras(antes: Leitura | null, agora: Leitura): Movimento[] {
    const mapaAntes = new Map<string, Alvo>();
    if (antes) for (const a of antes.alvos) mapaAntes.set(a.devedor.toLowerCase(), a);

    const movimentos: Movimento[] = [];
    for (const a of agora.alvos) {
        const velho = mapaAntes.get(a.devedor.toLowerCase());
        mapaAntes.delete(a.devedor.toLowerCase());
        if (a.queda === null) {
            if (velho?.queda) movimentos.push({ tipo: 'saiu', devedor: a.devedor, antes: velho.queda });
            continue;
        }
        if (!velho || velho.queda === null) { movimentos.push({ tipo: 'novo', alvo: a }); continue; }
        movimentos.push({
            tipo: 'andou',
            alvo: a,
            antes: velho.queda,
            deltaPontos: a.queda.minus(velho.queda),
            msDesde: agora.em - antes!.em,
        });
    }
    // Quem estava na leitura velha e NAO veio na nova nao "saiu": nao foi lido.
    // Chamar falta de leitura de saida seria transformar um buraco em fato.
    return movimentos;
}

/** Quem foi lido antes e nao veio agora. Falta de leitura NAO e desaparecimento. */
export function naoForamLidos(antes: Leitura | null, agora: Leitura): string[] {
    if (!antes) return [];
    const agoraTem = new Set(agora.alvos.map((a) => a.devedor.toLowerCase()));
    return antes.alvos.map((a) => a.devedor).filter((d) => !agoraTem.has(d.toLowerCase()));
}

export function emQuantoTempoHumano(ms: number): string {
    if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 5_400_000) return `${Math.round(ms / 60_000)}min`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Uma linha por alvo, com o sinal explicado em palavra e nao so em simbolo. */
export function comoLerOMovimento(m: Movimento): string {
    if (m.tipo === 'saiu') return `${m.devedor.slice(0, 10)}… SAIU da lista (estava a ${m.antes.toFixed(3)}%) — pagou ou foi liquidado`;
    if (m.tipo === 'novo') {
        return `${m.alvo.devedor.slice(0, 10)}… NOVO  a ${m.alvo.queda!.toFixed(3)}%  ` +
            `dívida US$ ${m.alvo.dividaUsd.toFixed(0)}  vale US$ ${m.alvo.lucroUsd.toFixed(2)}`;
    }
    const d = m.deltaPontos;
    // Abaixo da resolucao mostrada, "parado" — e nao "CHEGOU 0.000 mais perto".
    // A primeira leitura de verdade imprimiu exatamente isso: uma frase que
    // afirma movimento ao lado de um numero que diz zero. O delta e real, so e
    // menor que meio milesimo; dizer que andou seria o texto contradizendo o
    // proprio numero, que e o defeito que este projeto mais encontra.
    const RESOLUCAO = new Decimal('0.0005');
    const sinal = d.abs().lessThan(RESOLUCAO)
        ? (d.isZero() ? 'parado' : 'parado (mexeu menos que a casa mostrada)')
        : d.isNegative() ? `CHEGOU ${d.abs().toFixed(3)} mais perto` : `afastou ${d.toFixed(3)}`;
    return `${m.alvo.devedor.slice(0, 10)}…  ${m.alvo.queda!.toFixed(3)}%  ` +
        `(era ${m.antes.toFixed(3)}%, ${sinal} em ${emQuantoTempoHumano(m.msDesde)})  ` +
        `dívida US$ ${m.alvo.dividaUsd.toFixed(0)}  vale US$ ${m.alvo.lucroUsd.toFixed(2)}`;
}
