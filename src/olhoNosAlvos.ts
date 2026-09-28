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
import { comparaPremio } from './perdidas';

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

export interface Resumo {
    /** O que o bot atiraria HOJE, com o maior premio primeiro. */
    naFaixa: Alvo[];
    /** O melhor que existe, atirando ou nao. */
    melhorDeTodos: Alvo | null;
    /** O melhor que o bot NAO alcanca, e o teto que faltaria para alcancar. */
    melhorForaDaFaixa: Alvo | null;
    somaNaFaixa: Decimal;
}

/**
 * O resumo, porque a lista ordenada por PROXIMIDADE enterra a resposta.
 *
 * A leitura de 2026-09-27 imprimiu 16 linhas em que o alvo de R$ 359 e o de
 * 12 centavos apareciam com a mesma marca `>> ATIRA`, separados por seis
 * linhas. Ordenar por quem cai primeiro esta certo para saber quem cai
 * primeiro, e errado para saber o que vale a pena — sao duas perguntas, e a
 * lista so respondia a primeira.
 */
export function resumir(alvos: Alvo[], tetoDaFaixa: Decimal | null): Resumo {
    const vivos = alvos.filter((a) => a.queda !== null && a.lucroUsd.greaterThan(0));
    const cabe = (a: Alvo) => tetoDaFaixa === null || a.lucroUsd.lessThanOrEqualTo(tetoDaFaixa);
    // Ordenar por lucro so NAO basta: o lucro satura no teto do pool, entao as
    // baleias empatam e o empate caia na ordem do array. `comparaPremio` e a
    // mesma regra que escolhe o maior de um degrau em `oQueUmaQuedaRenderia` —
    // uma regra em dois lugares e a mesma regra.
    const porValor = [...vivos].sort((a, b) =>
        comparaPremio({ lucroUsd: a.lucroUsd, quedaPct: a.queda! }, { lucroUsd: b.lucroUsd, quedaPct: b.queda! }));
    const naFaixa = porValor.filter(cabe);
    return {
        naFaixa,
        melhorDeTodos: porValor[0] ?? null,
        melhorForaDaFaixa: porValor.find((a) => !cabe(a)) ?? null,
        somaNaFaixa: naFaixa.reduce((acc, a) => acc.plus(a.lucroUsd), new Decimal(0)),
    };
}

/** De onde veio cada endereco que a leitura tentou ler. */
export interface Cobertura {
    /** Lidos com sucesso. */
    lidos: number;
    /** Achados varrendo eventos de emprestimo na janela. */
    daJanela: number;
    /** Ja conhecidos de leituras anteriores, que a janela nao acharia. */
    daMemoria: number;
    /** Tamanho da janela varrida, em blocos. Zero quando nao varreu. */
    blocos: number;
    /**
     * Quantas janelas de `eth_getLogs` falharam, e quantas eram.
     *
     * Sem estes dois campos a linha dizia "li 24 de 24 endereços (100.0%): 0 que
     * pediram emprestado nos últimos 320000 blocos (~7.4 dias)" com TODAS as
     * janelas falhadas — uma varredura que nao aconteceu, publicada como censo
     * completo de 7,4 dias. A porcentagem e `lidos / (daJanela + daMemoria)`, e
     * perder janelas encolhe o denominador: o 100% fica intacto justamente quando
     * a medicao morreu.
     */
    janelasQueFalharam?: number;
    janelas?: number;
    /** Segundos por bloco da rede, para virar dias. Base: 2s. */
    segundosPorBloco?: number;
}

/**
 * A linha da cobertura, dizendo QUAL universo foi lido.
 *
 * Existe por um erro meu de 2026-09-27, do tipo que este projeto mais comete.
 * A varredura imprimiu `li 3290 de 3290 (100.0%)` e, no MESMO minuto, um
 * `eth_call` direto mostrou que os dois alvos que mais importam estavam vivos e
 * fora da lista: `0x9ff24fd4` a 1,1551% e a baleia `0x67d0938f` a 2,1251% com
 * US$ 1,93M. Os dois pegaram o emprestimo antes da janela de ~7,4 dias, entao
 * nenhum evento `Borrow` os revelou.
 *
 * O `100.0%` estava aritmeticamente certo e semanticamente falso: era 100% do
 * que eu ACHEI, lido como 100% de quem existe. Por causa dele o RESUMO disse
 * que o maior premio fora do alcance estava a 3,846%, quando o mesmo premio
 * (saturado no teto do pool) estava a 2,125% — quase o dobro mais perto.
 *
 * Entao a linha nunca mais diz so uma porcentagem: diz de onde veio o universo
 * e avisa que emprestimo mais antigo que a janela so entra pela memoria.
 */
export function comoLerACobertura(c: Cobertura): string {
    const total = c.daJanela + c.daMemoria;
    const pct = total === 0 ? 100 : (c.lidos / total) * 100;
    const dias = c.blocos === 0 ? null : (c.blocos * (c.segundosPorBloco ?? 2)) / 86_400;
    const falharam = c.janelasQueFalharam ?? 0;
    const partes = [
        `li ${c.lidos} de ${total} endereços (${pct.toFixed(1)}%)`,
        dias === null
            ? `${c.daMemoria} guardados de leituras anteriores`
            : `${c.daJanela} que pediram emprestado nos últimos ${c.blocos} blocos (~${dias.toFixed(1)} dias)`
                + (falharam > 0 && (c.janelas ?? 0) > 0
                    ? `, mas só ${(c.janelas ?? 0) - falharam} das ${c.janelas} janelas deram certo`
                    : falharam > 0 ? `, com ${falharam} janelas falhadas` : '')
                + (c.daMemoria > 0 ? ` + ${c.daMemoria} guardados de leituras anteriores` : ''),
    ];
    // Os avisos vivem FORA do ramo que depende de `dias`: uma varredura que falhou
    // inteira tem `blocos` zero, e era justamente nela que o aviso sumia.
    const avisos: string[] = [];
    if (pct < 99) avisos.push('COBERTURA BAIXA: não conclua daqui');
    if (falharam > 0) {
        const total = c.janelas ?? 0;
        avisos.push(total > 0 && falharam >= total
            ? `TODAS as ${total} janelas falharam: esta varredura NÃO aconteceu. `
              + 'O que está aqui vem só da memória'
            : `${falharam}${total > 0 ? ` de ${total}` : ''} janelas falharam: `
              + 'a lista está incompleta e não sei de quanto');
    }
    // O aviso vale SEMPRE que houve varredura, inclusive a 100%: foi justamente
    // com 100% que a lista perdeu a baleia.
    if (c.blocos > 0) avisos.push('este total é quem eu ACHEI, não quem existe: empréstimo mais antigo que a janela só entra se já estiver guardado');
    return partes.join(': ') + avisos.map((a) => `\n  >>> ${a}`).join('');
}
