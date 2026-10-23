/**
 * AS DUAS POLITICAS DE DESPERTAR, comparadas sobre o MESMO fluxo de eventos.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Em 2026-10-10 ficou medido, lendo o codigo, que
 * fora de 'dedo no gatilho' o ciclo espera em `dormirDeOlho`, que acorda por
 * MERCADO e nunca por BLOCO: um bloco que nasce no meio do sono espera ate ~8s.
 *
 * Ela mandou validar antes de pedir ativacao: *"Prepare uma comparação entre a
 * política atual e a candidata usando o mesmo fluxo de eventos. Quando
 * possível, calcule os horários de despertar das duas políticas sem duplicar
 * consultas externas. Meça atraso evitável e estime chamadas adicionais por
 * método."*
 *
 * Entao isto e PURO: recebe um fluxo de instantes de bloco e devolve, para
 * cada politica, quando o ciclo acordaria. Nenhuma consulta externa — e e por
 * isso que as duas podem ser calculadas sobre os MESMOS eventos sem duplicar
 * nada.
 *
 * O QUE ISTO NAO MEDE: se acordar mais cedo CAPTURA. Chegar antes na avaliacao
 * nao e chegar antes na fatia do bloco.
 */

export interface Despertar {
    /** Instante (ms) em que o ciclo comeca. */
    acordouEm: number;
    /** O que acordou: o relogio do sono, ou um aviso de bloco. */
    porque: 'sono' | 'bloco';
    /**
     * Instante do bloco que ESTE ciclo vai processar, se houver um pendente.
     * `null` quando o ciclo acordou sem bloco novo para ver.
     */
    blocoPendenteDe: number | null;
    /** Atraso entre o bloco chegar e o ciclo comecar. 0 sem bloco pendente. */
    atrasoMs: number;
}

export interface Politica {
    nome: 'atual' | 'candidata';
    /** O sono da postura, em ms. */
    ritmoMs: number;
    /** O trabalho do ciclo, em ms — o caminho critico medido. */
    trabalhoMs: number;
    /** `true` se um aviso de bloco interrompe o sono. */
    blocoInterrompe: boolean;
}

/**
 * Roda uma politica sobre um fluxo de instantes de bloco.
 *
 * O modelo e o do laco de verdade: trabalha `trabalhoMs`, dorme o que resta do
 * ritmo, e volta. Na candidata, um bloco que chega durante o sono encerra o
 * sono; na atual, ele espera.
 */
export function simular(p: Politica, blocosEm: number[], ateMs: number): Despertar[] {
    const blocos = [...blocosEm].sort((a, b) => a - b);
    const saida: Despertar[] = [];
    let agora = 0;
    let proximo = 0; // indice do primeiro bloco ainda nao processado
    let guarda = 0;
    while (agora <= ateMs && guarda < 100_000) {
        guarda += 1;
        // Blocos que chegaram ate agora e ainda nao foram vistos: o ciclo que
        // comeca processa o MAIS ANTIGO pendente — e os outros continuam
        // pendentes, sem criar ciclo novo.
        const pendente = proximo < blocos.length && blocos[proximo]! <= agora
            ? blocos[proximo]! : null;
        saida.push({
            acordouEm: agora,
            porque: saida.length === 0 ? 'sono' : (saida.at(-1)!.porque),
            blocoPendenteDe: pendente,
            atrasoMs: pendente === null ? 0 : agora - pendente,
        });
        // Um ciclo consome TODOS os pendentes ate agora: ele le o estado atual,
        // nao um por um. Contar um ciclo por bloco seria inventar fila.
        while (proximo < blocos.length && blocos[proximo]! <= agora) proximo += 1;
        const fimDoTrabalho = agora + p.trabalhoMs;
        const fimDoSono = agora + Math.max(p.trabalhoMs, p.ritmoMs);
        if (!p.blocoInterrompe) { agora = fimDoSono; saida.at(-1)!.porque = 'sono'; continue; }
        // Candidata: o primeiro bloco que chegar APOS o trabalho encerra o sono.
        const primeiroDepois = blocos.find((b) => b > fimDoTrabalho);
        if (primeiroDepois !== undefined && primeiroDepois < fimDoSono) {
            agora = primeiroDepois;
            saida.at(-1)!.porque = 'bloco';
        } else { agora = fimDoSono; saida.at(-1)!.porque = 'sono'; }
    }
    return saida;
}

export interface Comparacao {
    eventos: number;
    janelaMs: number;
    atual: { ciclos: number; atrasoP50: number | null; atrasoP90: number | null; atrasoMax: number | null };
    candidata: { ciclos: number; atrasoP50: number | null; atrasoP90: number | null; atrasoMax: number | null };
    /** Atraso EVITAVEL: a diferenca de mediana entre as duas. */
    atrasoEvitavelP50Ms: number | null;
    /** Ciclos a mais que a candidata roda — e o custo. */
    ciclosAMais: number;
    /** Chamadas a mais, POR METODO, estimadas pelo custo de um ciclo. */
    chamadasAMais: Record<string, number>;
    oQueIssoNaoMede: string;
}

const pct = (v: number[], q: number): number | null => {
    if (v.length === 0) return null;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

/**
 * Compara as duas politicas sobre o MESMO fluxo.
 *
 * `chamadasPorCiclo` e o custo medido de um ciclo, por metodo de RPC — para a
 * estimativa de chamadas a mais nao ser um palpite meu.
 */
export function comparar(
    blocosEm: number[],
    ateMs: number,
    ritmoMs: number,
    trabalhoMs: number,
    chamadasPorCiclo: Record<string, number>,
): Comparacao {
    const base: Omit<Politica, 'nome' | 'blocoInterrompe'> = { ritmoMs, trabalhoMs };
    const a = simular({ nome: 'atual', ...base, blocoInterrompe: false }, blocosEm, ateMs);
    const c = simular({ nome: 'candidata', ...base, blocoInterrompe: true }, blocosEm, ateMs);
    const atrasos = (d: Despertar[]) => d.filter((x) => x.blocoPendenteDe !== null).map((x) => x.atrasoMs);
    const aA = atrasos(a); const aC = atrasos(c);
    const ciclosAMais = c.length - a.length;
    const chamadasAMais: Record<string, number> = {};
    for (const [m, n] of Object.entries(chamadasPorCiclo)) chamadasAMais[m] = n * ciclosAMais;
    const p50a = pct(aA, 0.5); const p50c = pct(aC, 0.5);
    return {
        eventos: blocosEm.length,
        janelaMs: ateMs,
        atual: { ciclos: a.length, atrasoP50: p50a, atrasoP90: pct(aA, 0.9), atrasoMax: aA.length === 0 ? null : Math.max(...aA) },
        candidata: { ciclos: c.length, atrasoP50: p50c, atrasoP90: pct(aC, 0.9), atrasoMax: aC.length === 0 ? null : Math.max(...aC) },
        atrasoEvitavelP50Ms: p50a === null || p50c === null ? null : p50a - p50c,
        ciclosAMais,
        chamadasAMais,
        oQueIssoNaoMede: 'CAPTURA. Acordar mais cedo põe a avaliação mais perto do bloco; '
            + 'não diz nada sobre em que fatia a transação cairia. E o fluxo de eventos é '
            + 'de ENTRADA: com `newHeads` ele é a cadência do bloco (~2s), não da fatia (~200ms)',
    };
}

/** A frase do log/relatório. Diz os dois custos lado a lado. */
export function comoLerAComparacao(c: Comparacao): string {
    if (c.eventos === 0) return 'nenhum evento no fluxo — nada a comparar';
    const ms = (x: number | null) => (x === null ? '—' : `${x.toFixed(0)}ms`);
    return `${c.eventos} evento(s) em ${(c.janelaMs / 1000).toFixed(0)}s | `
        + `atual: ${c.atual.ciclos} ciclos, atraso p50 ${ms(c.atual.atrasoP50)} `
        + `p90 ${ms(c.atual.atrasoP90)} máx ${ms(c.atual.atrasoMax)} | `
        + `candidata: ${c.candidata.ciclos} ciclos, atraso p50 ${ms(c.candidata.atrasoP50)} `
        + `p90 ${ms(c.candidata.atrasoP90)} máx ${ms(c.candidata.atrasoMax)} | `
        + `atraso EVITÁVEL p50 ${ms(c.atrasoEvitavelP50Ms)} | `
        + `custo: +${c.ciclosAMais} ciclos = `
        + `${Object.entries(c.chamadasAMais).map(([m, n]) => `+${n} ${m}`).join(', ')}`;
}

// ---------------------------------------------------------------------------
// O PASSO DE ESPERA DE PRODUCAO, extraido para ser testavel.
//
// Ela recusou a minha prova anterior: *"Resolver e remover um ouvinte uma
// única vez não comprova, sozinho, ausência de ciclos concorrentes ou
// consultas duplicadas. Use dependências controladas para contar avaliações,
// chamadas RPC e reservas de nonce."*
//
// Esta funcao e o passo que o laco de producao executa no `finally`. Producao
// chama ela; o teste chama ELA com dependencias falsas e CONTA. Nao ha copia.
// ---------------------------------------------------------------------------

export interface DependenciasDaEspera {
    /** `vivo` e `assinar` do ouvinte de blocos. `null` quando nao ha. */
    ouvinte: { vivo: boolean; assinar: (f: (n: number) => void) => () => void } | null;
    acordaPorBloco: boolean;
    /** O sono simples. */
    dormir: (ms: number) => Promise<void>;
    /** O sono que olha o mercado entre fatias. */
    dormirDeOlho: (totalMs: number, fatiaMs: number) => Promise<boolean>;
    /** Espera por bloco com teto de tempo. */
    esperarBloco: (
        assinar: (f: (n: number) => void) => () => void, tetoMs: number,
    ) => Promise<'bloco' | 'tempo'>;
    /** Relogio monotonico, injetavel para o teste nao depender do tempo real. */
    agoraNs: () => bigint;
}

export interface ResultadoDaEspera {
    /** O que encerrou a espera. */
    porque: 'bloco' | 'sono' | 'mercado' | 'semEspera';
    /** Instante monotonico do PRIMEIRO aviso que chegou durante a espera. */
    primeiroAvisoNs: bigint | null;
    /** Quantos avisos chegaram durante a espera — a rajada e contada. */
    avisos: number;
    /** `true` se o ouvinte foi desassinado. Pendurado e vazamento. */
    desassinou: boolean;
}

/**
 * Espera o proximo ciclo.
 *
 * REGRA que os testes guardam: esta funcao retorna UMA vez por chamada, e
 * desassina SEMPRE. Uma rajada de avisos durante a espera e CONTADA e produz
 * UM retorno — nunca um ciclo por aviso.
 */
export async function esperarOProximoCiclo(
    postura: 'dormindo' | 'atento' | 'dedo no gatilho',
    ritmoMs: number,
    restaMs: number,
    olharMercadoMs: number,
    d: DependenciasDaEspera,
): Promise<ResultadoDaEspera> {
    let avisos = 0;
    let primeiro: bigint | null = null;
    let desassinou = false;
    const contar = (): (() => void) | null => {
        if (d.ouvinte === null || !d.ouvinte.vivo) return null;
        const parar = d.ouvinte.assinar(() => {
            avisos += 1;
            if (primeiro === null) primeiro = d.agoraNs();
        });
        return () => { if (!desassinou) { desassinou = true; parar(); } };
    };

    if (postura === 'dedo no gatilho') {
        if (d.ouvinte !== null && d.ouvinte.vivo) {
            const parar = contar();
            try {
                const como = await d.esperarBloco((f) => d.ouvinte!.assinar(f), 2500);
                return { porque: como === 'bloco' ? 'bloco' : 'sono', primeiroAvisoNs: primeiro, avisos, desassinou: true };
            } finally { parar?.(); }
        }
        await d.dormir(ritmoMs);
        return { porque: 'sono', primeiroAvisoNs: null, avisos: 0, desassinou: false };
    }
    if (restaMs <= 0) return { porque: 'semEspera', primeiroAvisoNs: null, avisos: 0, desassinou: false };
    const parar = contar();
    try {
        if (d.acordaPorBloco && d.ouvinte !== null && d.ouvinte.vivo) {
            const como = await d.esperarBloco((f) => d.ouvinte!.assinar(f), restaMs);
            return { porque: como === 'bloco' ? 'bloco' : 'sono', primeiroAvisoNs: primeiro, avisos, desassinou: true };
        }
        const porMercado = await d.dormirDeOlho(restaMs, olharMercadoMs);
        return {
            porque: porMercado ? 'mercado' : 'sono',
            primeiroAvisoNs: primeiro, avisos, desassinou: parar !== null,
        };
    } finally { parar?.(); }
}
