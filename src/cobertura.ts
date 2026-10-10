/**
 * COBERTURA DE LEITURA: o vocabulario de "quanto eu de fato li".
 *
 * POR QUE ESTE ARQUIVO EXISTE. No log de 2026-10-10 a varredura publicou
 * `alvosChecados: 62000` enquanto DEZ pedacos de 250 posicoes estouraram com
 * `Cannot read properties of undefined (reading 'replace')`. Dois mil e
 * quinhentos devedores nao foram lidos, e nada no log separava "li e esta
 * seguro" de "nao consegui ler". Ela recusou o conserto cosmetico: *"Corrija o
 * comportamento que produz os dados e depois faça os logs refletirem esse
 * comportamento."*
 *
 * A CAUSA RAIZ do `.replace`, localizada por execucao e nao por leitura
 * (`src/cobertura.test.ts` a reproduz):
 *
 *   `umaChamada` terminava em `return corpo.result as T`.
 *
 * Quando o corpo JSON-RPC nao traz `result` NEM `error` — e o provedor da Base
 * faz isso sob carga —, `corpo.result` e `undefined`, o `as T` promete que e
 * uma `string`, e o `undefined` viaja ate
 * `decodificarAggregate3Rapido(dataHex)`, cuja primeira linha e
 * `dataHex.replace(/^0x/, '')`. O erro estoura a 270 linhas de distancia da
 * causa, no PEDACO todo, e o `catch` de `lerEmLote` o reportava como "um pedaço
 * da varredura não foi lido" sem dizer metodo, lote nem formato.
 *
 * Nao e defeito de preparacao: `codificarAggregate3` com `alvo` ou `dados`
 * ausente estoura `invalid address` / `invalid BytesLike value` (medido, os dois
 * casos estao no teste). E tratamento de RESPOSTA.
 *
 * O conserto e `exigirResultado`, e ele NAO usa `String(valor)`, string vazia
 * nem `?.` para tapar o buraco: resposta sem `result` e FALHA DE LEITURA, com
 * nome, metodo e as CHAVES do corpo (chaves, nunca valores — um corpo de erro
 * pode trazer credencial na URL repetida).
 *
 * `result: null` e coisa DIFERENTE e passa: `eth_getTransactionByHash` de hash
 * desconhecido responde `null`, e isso e uma resposta. O discriminador e a
 * PRESENCA da chave, nao a verdade do valor.
 */

/** A falha de leitura que antes virava `undefined` e estourava longe. */
export class RespostaSemResultado extends Error {
    constructor(public readonly metodo: string, public readonly chaves: string[]) {
        super(
            `o provedor respondeu sem \`result\` e sem \`error\` em ${metodo}: `
            + `o corpo tem ${chaves.length === 0 ? 'nenhuma chave' : `[${chaves.join(', ')}]`}. `
            + 'Isto é FALHA DE LEITURA, não resposta vazia',
        );
        this.name = 'RespostaSemResultado';
    }
}

/**
 * O `result` do corpo, ou uma falha com nome.
 *
 * `null` presente e resposta e passa. Chave ausente e falha.
 */
export function exigirResultado<T>(corpo: unknown, metodo: string): T {
    if (typeof corpo !== 'object' || corpo === null) {
        throw new RespostaSemResultado(metodo, []);
    }
    const c = corpo as Record<string, unknown>;
    if (!('result' in c)) throw new RespostaSemResultado(metodo, Object.keys(c));
    return c.result as T;
}

/**
 * Quanto de uma leitura chegou, separado em quatro contas.
 *
 * Quatro e nao duas, porque elas pedem acoes diferentes: `lidas` e fato,
 * `falharam` e buraco a reler, `reusadas` e estado velho preservado (e a idade
 * dele decide se ainda serve), e `pedidas` e o denominador — sem ele toda
 * fracao e inventada.
 */
export interface Cobertura {
    pedidas: number;
    lidas: number;
    falharam: number;
    /** As posicoes (indices na lista pedida) que nao foram lidas. */
    posicoesFalhas: Set<number>;
    /** Quantas posicoes foram respondidas com estado guardado, nao com leitura. */
    reusadas: number;
    /** A idade do estado reusado mais velho, em ms. `null` se nada foi reusado. */
    idadeMaisVelhaMs: number | null;
    /** Os lotes que falharam, com o motivo — para agrupar erro repetido no log. */
    lotesQueFalharam: Array<{ lote: string; posicoes: number; erro: string }>;
}

export function coberturaVazia(pedidas = 0): Cobertura {
    return {
        pedidas, lidas: 0, falharam: 0, posicoesFalhas: new Set(), reusadas: 0,
        idadeMaisVelhaMs: null, lotesQueFalharam: [],
    };
}

/**
 * A fracao que falhou, CALCULADA do contador.
 *
 * Existe como funcao porque o log de 2026-10-10 publicou "um quarto das janelas
 * falhou" com 40 falhas e 4 sucessos — a frase era literal, escrita a mao, e
 * dizia 25% onde a conta da 91%. Ela mandou: *"Calcule percentuais a partir dos
 * contadores."* Aqui nao ha como escrever o numero a mao.
 */
export function fracaoQueFalhou(c: Cobertura): number | null {
    const tentadas = c.lidas + c.falharam;
    if (tentadas <= 0) return null;
    return c.falharam / tentadas;
}

/** `true` so quando TODAS as posicoes pedidas foram lidas de verdade. */
export function coberturaCompleta(c: Cobertura): boolean {
    return c.pedidas > 0 && c.lidas === c.pedidas && c.falharam === 0;
}

/**
 * A frase da cobertura.
 *
 * Ela separa "a varredura ENCERROU" de "a cobertura esta COMPLETA", porque as
 * duas eram a mesma linha e sao conclusoes diferentes: a primeira e sobre o
 * laco, a segunda sobre os dados. Foi a confusao entre as duas que fez o log
 * dizer `alvosChecados: 62000` com 2.500 posicoes nao lidas.
 */
export function comoLerACobertura(c: Cobertura): string {
    if (c.pedidas === 0) return 'nada foi pedido nesta leitura: não há cobertura a declarar';
    const f = fracaoQueFalhou(c);
    const pct = ((c.lidas / c.pedidas) * 100).toFixed(1);
    if (coberturaCompleta(c)) {
        return `cobertura COMPLETA: ${c.lidas} de ${c.pedidas} lidas de verdade`;
    }
    const partes = [
        `cobertura INCOMPLETA: ${c.lidas} de ${c.pedidas} lidas (${pct}%)`,
        `${c.falharam} não foram lidas`
        + (f === null ? '' : ` — ${(f * 100).toFixed(1)}% das tentativas falharam`),
    ];
    if (c.reusadas > 0) {
        partes.push(
            `${c.reusadas} respondidas com estado GUARDADO`
            + (c.idadeMaisVelhaMs === null
                ? ''
                : `, o mais velho com ${(c.idadeMaisVelhaMs / 1000).toFixed(0)}s de idade`),
        );
    }
    partes.push('quem não foi lido NÃO é ausência de oportunidade: é falta de leitura');
    return partes.join('; ');
}

/**
 * O id de um lote, estavel dentro de uma leitura.
 *
 * Existe para o log agrupar erro repetido sem perder o exemplo: ela pediu
 * *"Agrupe erros repetidos com contagem e identificação de lote, preservando
 * exemplos completos."* Sem id, dez linhas iguais nao se distinguem de uma
 * linha repetida dez vezes.
 */
export function idDoLote(leitura: string, posicao: number, de: number, ate: number): string {
    return `${leitura}#${posicao}[${de}..${ate}]`;
}

/**
 * O TIPO de recusa do provedor, e por que os tres pedem acoes diferentes.
 *
 * MEDIDO no log de 2026-10-10: `request limit reached` apareceu em 28 de 28
 * janelas — e `ehLimiteDoProvedor` NAO o reconhecia. A mensagem nao contem
 * "rate limit", nem "429", nem "too many requests", nem "timeout", nem
 * "capacity": ela caia fora da escada de espera e subia como erro duro, sem
 * backoff nenhum. A avalanche nao era falta de paciencia no codigo da escada —
 * era a escada nunca ter sido chamada.
 *
 *   'taxa'  pedidos por segundo. Espera curta resolve, e repetir compensa.
 *   'cota'  credito do mes ou do plano. Esperar NAO resolve: repetir queima
 *           o que sobrou. Pede trocar de provedor ou parar.
 *   'tempo' a chamada nao voltou. Pode ser a janela grande demais, nao o
 *           provedor — repetir menor resolve, repetir igual nao.
 *   'outra' nao identificada. Sem identificacao positiva nao se trata como
 *           limite: tratar erro desconhecido como "o provedor pediu calma"
 *           esconderia defeito nosso atras de paciencia.
 */
export type TipoDeRecusa = 'taxa' | 'cota' | 'tempo' | 'outra';

export function classificarRecusa(mensagem: string): {
    tipo: TipoDeRecusa; absorveEsperando: boolean; oQueFazer: string;
} {
    const m = mensagem.toLowerCase();
    // COTA primeiro: ela tambem casa com palavras de taxa em alguns provedores,
    // e errar para "taxa" faria o bot repetir contra credito esgotado.
    if (/quota|monthly|credits? exhausted|payment required|402|insufficient funds for (cu|compute)/.test(m)) {
        return {
            tipo: 'cota', absorveEsperando: false,
            oQueFazer: 'esperar NÃO resolve: é crédito do plano. Trocar de provedor ou parar de ler',
        };
    }
    if (/rate limit|request limit|429|too many requests|exceeded.*(limit|requests)|capacity|over (the )?rate/.test(m)) {
        return {
            tipo: 'taxa', absorveEsperando: true,
            oQueFazer: 'espera progressiva e concorrência menor; repetir compensa',
        };
    }
    if (/timeout|timed out|aborted|etimedout|socket hang up/.test(m)) {
        return {
            tipo: 'tempo', absorveEsperando: true,
            oQueFazer: 'repetir com pedaço MENOR: pode ser a janela, não o provedor',
        };
    }
    return {
        tipo: 'outra', absorveEsperando: false,
        oQueFazer: 'não identificada: não trato como limite, porque tratar erro desconhecido como '
            + '"pediu calma" esconde defeito nosso atrás de paciência',
    };
}
