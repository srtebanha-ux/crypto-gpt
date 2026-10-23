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

import { sanitizar } from './capacidade';

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

// ---------------------------------------------------------------------------
// DIAGNOSTICO LIMITADO DE `eth_getLogs`: o que a RESPOSTA comprova.
//
// Ela proibiu a inferencia que eu ia fazer: *"não deduza restrição de tamanho
// ou método apenas de `request limit reached`."* Esta funcao devolve o que a
// mensagem COMPROVA e deixa o resto DESCONHECIDO, em vez de escolher um dos
// quatro no escuro.
//
// Os textos sao os que este projeto OBSERVOU, com a data:
//   `request limit reached`                 mainnet.base.org, 2026-10-10
//   `Monthly capacity limit exceeded`       alchemy, 2026-10-10
//   `eth_getLogs is limited to a 500 range` mainnet.base.org, 2026-10-06
//   `query exceeds max results`             usado no proxy de verificacao
// ---------------------------------------------------------------------------

export type RestricaoDeLogs = 'frequencia' | 'tamanho' | 'metodo' | 'capacidade'
    /** Um limite foi alcancado e a mensagem NAO diz qual. Ver a retratacao abaixo. */
    | 'indeterminada'
    /** Nenhum padrao observado reconhece a mensagem. */
    | 'desconhecida';

export interface DiagnosticoDeLogs {
    restricao: RestricaoDeLogs;
    /** O que a resposta COMPROVA, com as palavras dela. */
    comprova: string;
    /** O que continua DESCONHECIDO depois desta resposta. */
    desconhecido: string[];
    /** A proxima medicao que resolveria o desconhecido — barata e especifica. */
    comoDescobrir: string;
}

export function diagnosticarRecusaDeLogs(mensagem: string): DiagnosticoDeLogs {
    const m = mensagem.toLowerCase();
    const s = sanitizar(mensagem);
    // TAMANHO: so quando a mensagem FALA de faixa, intervalo ou resultados.
    if (/limited to a \d+ range|block range|exceeds max results|too many (logs|results)|range is too large/.test(m)) {
        return {
            restricao: 'tamanho',
            comprova: `a resposta fala de FAIXA/RESULTADOS ("${s}"): a recusa é do TAMANHO da `
                + 'consulta, e uma janela menor pode passar',
            desconhecido: ['se o metodo esta liberado em qualquer tamanho',
                'qual o teto exato (so a sondagem por tamanhos responde)'],
            comoDescobrir: 'sondar tamanhos decrescentes com o MESMO filtro (é o que '
                + '`descobrirPedaco` faz) — e tamanho não medido fica DESCONHECIDO, não 250',
        };
    }
    if (/method\b[^.]{0,40}\bnot (found|supported|available)|unsupported method|-32601/.test(m)) {
        return {
            restricao: 'metodo',
            comprova: `a resposta diz que o MÉTODO não existe ou não é servido ("${s}")`,
            desconhecido: ['nada sobre frequência ou tamanho: o método nem chegou a ser executado'],
            comoDescobrir: 'outro provedor, ou o endpoint correto deste — repetir não muda',
        };
    }
    if (classificarRecusa(mensagem).tipo === 'cota') {
        return {
            restricao: 'capacidade',
            comprova: `a resposta fala de CAPACIDADE/COTA da conta ("${s}"): vale para todo método `
                + 'deste provedor, e esperar não a devolve',
            desconhecido: ['se o tamanho da consulta seria aceito com cota disponível',
                'se o método é servido por este plano'],
            comoDescobrir: 'nada a medir neste provedor até a cota voltar; medir no secundário '
                + 'responde sobre o secundário, não sobre este',
        };
    }
    if (classificarRecusa(mensagem).tipo === 'taxa') {
        return {
            // RETRATACAO, 2026-10-11. Eu publiquei que `request limit reached`
            // COMPROVA frequencia. Nao comprova. Ela recusou: *"Retire a
            // conclusão de que `request limit reached` comprova frequência.
            // Registre a causa específica como indeterminada até haver
            // evidência."*
            //
            // A mensagem diz que um LIMITE foi alcancado e nao diz QUAL: pode
            // ser pedidos por segundo, pedidos por janela maior, peso da
            // consulta, ou limite do plano com outro texto. O que ela autoriza
            // e ESPERAR — e esperar e compativel com os quatro.
            restricao: 'indeterminada',
            comprova: `a resposta diz que um LIMITE foi alcançado ("${s}") e autoriza ESPERAR. `
                + 'NÃO comprova qual: frequência, tamanho, método e capacidade seguem todos '
                + 'possíveis',
            desconhecido: ['QUAL limite foi alcançado — a causa específica é INDETERMINADA',
                'o teto de TAMANHO deste provedor',
                'se o método seria servido numa janela sem rajada',
                'quanto de cota resta'],
            comoDescobrir: 'UMA consulta pequena, com filtro conhecido, depois do recuo. Se ela '
                + 'passar, a evidência aponta frequência ou peso; se falhar com mensagem de '
                + 'faixa, tamanho; se falhar igual, continua indeterminada',
        };
    }
    return {
        restricao: 'desconhecida',
        comprova: `a resposta não se encaixa em nenhum padrão observado ("${s}")`,
        desconhecido: ['frequência, tamanho, método e capacidade — todos os quatro'],
        comoDescobrir: 'guardar a mensagem e uma consulta pequena de controle; sem padrão '
            + 'reconhecido, escolher um dos quatro seria invenção',
    };
}

export function comoLerODiagnosticoDeLogs(d: DiagnosticoDeLogs): string {
    return `restrição ${d.restricao.toUpperCase()} | COMPROVA: ${d.comprova} | `
        + `DESCONHECIDO: ${d.desconhecido.join('; ')} | PRÓXIMA MEDIÇÃO: ${d.comoDescobrir}`;
}

/**
 * O ERRO JSON-RPC, qualquer que seja a FORMA em que ele chegou.
 *
 * MEDIDO no log de 2026-10-11: a varredura perdeu 5.750 posicoes e a mensagem
 * saiu vazia, porque o `error` chegou como **array** `[code, message]` e o
 * codigo fazia `corpo.error.message` — `undefined` num array, entao a prosa
 * virava "erro sem mensagem".
 *
 * E a ressalva dela importa: *"Não atribua a causa apenas ao formato."* A forma
 * explica por que a MENSAGEM se perdeu; ela nao diz por que o provedor recusou.
 * Entao esta funcao devolve as duas coisas separadas: o que veio (`codigo`,
 * `mensagem`, `status` HTTP) e em que FORMA veio, sem concluir causa de forma.
 */
export interface ErroJsonRpc {
    codigo: number | null;
    mensagem: string | null;
    /** O status HTTP, quando quem chamou souber. */
    status: number | null;
    /** A forma em que o `error` chegou. Diagnostico de LEITURA, nao de causa. */
    formato: 'objeto' | 'par' | 'texto' | 'ausente' | 'estranho';
}

export function lerErroJsonRpc(corpo: unknown, status: number | null = null): ErroJsonRpc {
    const vazio: ErroJsonRpc = { codigo: null, mensagem: null, status, formato: 'ausente' };
    if (typeof corpo !== 'object' || corpo === null) return { ...vazio, formato: 'estranho' };
    const e = (corpo as Record<string, unknown>).error;
    if (e === undefined || e === null) return vazio;
    // A FORMA QUE SE PERDIA: `[code, message]`.
    if (Array.isArray(e)) {
        const codigo = typeof e[0] === 'number' ? e[0] : null;
        const texto = e.find((x) => typeof x === 'string');
        return {
            codigo,
            mensagem: typeof texto === 'string' ? sanitizar(texto) : null,
            status, formato: 'par',
        };
    }
    if (typeof e === 'string') return { codigo: null, mensagem: sanitizar(e), status, formato: 'texto' };
    if (typeof e === 'object') {
        const o = e as Record<string, unknown>;
        return {
            codigo: typeof o.code === 'number' ? o.code : null,
            mensagem: typeof o.message === 'string' ? sanitizar(o.message) : null,
            status, formato: 'objeto',
        };
    }
    return { ...vazio, formato: 'estranho' };
}

/**
 * A prosa do erro, para subir como `Error`. Nunca vazia.
 *
 * Quando nao ha mensagem, ela DIZ que nao ha — e diz o codigo e a forma, que e
 * o que sobrou para diagnosticar. "erro sem mensagem" sozinho nao deixava nem
 * saber que havia um codigo.
 */
export function comoLerOErroJsonRpc(e: ErroJsonRpc): string {
    const partes: string[] = [];
    if (e.mensagem !== null) partes.push(e.mensagem);
    if (e.codigo !== null) partes.push(`code ${e.codigo}`);
    if (e.status !== null) partes.push(`HTTP ${e.status}`);
    partes.push(`forma do erro: ${e.formato}`);
    if (e.mensagem === null) {
        partes.push('SEM mensagem legível — e a forma explica por que ela faltou, '
            + 'não por que o provedor recusou: a causa continua indeterminada');
    }
    return partes.join(' | ');
}

/**
 * O CORPO, exigido como JSON — e a falha com NOME quando ele nao e JSON.
 *
 * MEDIDO no log de 2026-10-14: TODA chamada falhava com
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. O provedor estava
 * devolvendo uma PAGINA HTML em vez de resposta JSON-RPC — gateway, pagina de
 * erro ou de autenticacao.
 *
 * E o defeito nao era a pagina: era a CLASSIFICACAO. `res.json()` estourava um
 * `SyntaxError` cru, que nao casa com `ehFalhaDeTransporte` nem com
 * `classificarRecusa` — entao a escada NUNCA trocava de provedor e o laco de
 * fora reiniciava a cada segundo, para sempre, com o log repetindo a mesma
 * linha a cada 6 segundos.
 *
 * Corpo que nao e JSON e FALHA DO PROVEDOR, e a mensagem diz o status HTTP, o
 * `content-type` e os primeiros bytes — com as palavras que a escada reconhece.
 */
export class CorpoNaoEhJson extends Error {
    constructor(
        public readonly metodo: string,
        public readonly status: number,
        public readonly tipo: string | null,
        public readonly inicio: string,
    ) {
        // "network" e "bad gateway" estao aqui de proposito: sao as palavras que
        // `ehFalhaDeTransporte` reconhece, e e o reconhecimento que faz a escada
        // trocar de provedor em vez de repetir contra a mesma pagina.
        super(
            `o provedor respondeu NAO-JSON em ${metodo}: HTTP ${status}, `
            + `content-type ${tipo ?? 'ausente'}, começa com "${inicio}". `
            + 'Isto é falha de transporte do provedor (network/bad gateway), não resposta: '
            + 'trocar de degrau é o que resolve, repetir não',
        );
        this.name = 'CorpoNaoEhJson';
    }
}

/** Le o corpo como JSON, ou estoura `CorpoNaoEhJson` com o diagnostico. */
export async function lerCorpoJson<T>(
    res: { status: number; headers: { get(n: string): string | null }; text(): Promise<string> },
    metodo: string,
): Promise<T> {
    const texto = await res.text();
    try {
        return JSON.parse(texto) as T;
    } catch {
        throw new CorpoNaoEhJson(
            metodo, res.status, res.headers.get('content-type'),
            sanitizar(texto.slice(0, 60).replace(/\s+/g, ' ').trim()),
        );
    }
}
