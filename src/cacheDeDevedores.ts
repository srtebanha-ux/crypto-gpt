// Arquivo: src/cacheDeDevedores.ts
//
// A MEMÓRIA QUE SOBREVIVE AO DEPLOY.
//
// O problema, com os números medidos em 2026-10-02:
//
//   - O Pool da Aave V3 na Base nasceu no bloco 2.357.134 (busca binária em
//     `eth_getCode`). São 49,7 milhões de blocos, 3,15 anos de história.
//   - Varrer tudo com `PEDACO=10000` custa 4.972 chamadas = 129.272 CUs. O teto
//     do plano é 20M/mês, então UMA varredura completa é 0,65% do mês: barato.
//   - Mas a varredura roda A CADA BOOT, e o Railway reinicia o container a cada
//     deploy. A 10 boots por dia isso vira 38,8M CUs/mês — o dobro do teto.
//
// E o sistema de arquivos do Railway é EFÊMERO: gravar em qualquer caminho que
// não seja um volume montado é gravar em algo que o próximo deploy apaga, o que
// transforma o cache num placebo caro — a varredura volta, e o log diz que
// cacheou.
//
// Por isso o caminho padrão é `/app/data/devedores.json`, dentro do volume, e
// `estadoDoCache` existe para o log poder dizer QUAL dos dois está acontecendo.
//
// POR QUE JSON E NÃO SQLITE: o dado é um mapa de endereço para bloco. SQLite
// traria dependência nativa para compilar no build do Railway e índices que
// ninguém vai consultar. MEDIDO em 2026-10-02, com 50 mil devedores: o arquivo
// tem 2,70 MB, `JSON.parse` leva 22ms e `JSON.stringify` 20ms. Vinte e dois
// milissegundos uma vez por boot, contra a história inteira relida.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Onde o Pool de cada rede passou a existir.
 *
 * MEDIDO em 2026-10-02 por busca binária em `eth_getCode` contra
 * `mainnet.base.org`: 26 chamadas, e o resultado é exato — o bloco anterior não
 * tem código e este tem.
 *
 * "Bloco zero do protocolo" é ISTO, e não o bloco 0 da chain: do bloco 0 até o
 * nascimento seriam 236 chamadas varrendo blocos em que o contrato não existia.
 * Pagar por elas não é cobertura, é desperdício com cara de rigor.
 */
export const NASCIMENTO_DO_POOL: Record<string, number> = {
    base: 2_357_134,
};

/** O caminho do cache. O padrão aponta para DENTRO do volume do Railway. */
export const CAMINHO_DO_CACHE = process.env.CACA_CACHE ?? '/app/data/devedores.json';

/** Sobe quando o formato muda, para um cache velho não ser lido torto. */
export const VERSAO_DO_CACHE = 1;

export interface CacheDeDevedores {
    versao: number;
    /** A rede e o POOL de onde estes devedores vieram. */
    rede: string;
    pool: string;
    /**
     * O bloco MAIS VELHO coberto sem buraco, descendo do `ultimoBloco`.
     *
     * A varredura profunda anda para trás, então é ESTE número que mede o
     * progresso: ele desce em direção a `NASCIMENTO_DO_POOL` boot após boot, e
     * quando chega lá a cobertura é total. Enquanto não chega, `comoEstaACobertura`
     * diz em quantos blocos e dias falta — nunca "cacheado" sozinho.
     */
    blocoInicial: number;
    /**
     * O último bloco COBERTO SEM BURACO.
     *
     * Esta é a parte que decide se o cache é memória ou mentira. Se uma janela
     * no meio falhar e o `ultimoBloco` avançar por cima dela, o buraco fica
     * gravado PARA SEMPRE: o próximo boot começa depois dele e ninguém volta.
     * Então este número é o maior bloco abaixo do qual TUDO foi lido, e não o
     * maior bloco que a varredura tentou.
     */
    ultimoBloco: number;
    /** endereço (minúsculo) -> bloco em que foi visto tomando emprestado. */
    devedores: Record<string, number>;
    /**
     * O QUE O BOT APRENDEU sobre cada devedor: por onde a posição quebra.
     *
     * endereço (minúsculo) -> 'long' | 'short' | 'ambas' | 'imune'.
     *
     * Opcional de propósito: um cache gravado antes desta versão não tem o
     * campo, e tem de continuar servindo — invalidar 3 anos de história por
     * causa de um campo novo seria cobrar o preço inteiro por uma melhoria.
     *
     * POR QUE ELE EXISTE, medido em 2026-10-06. O cache fazia os DEVEDORES
     * sobreviverem ao deploy, e o que o bot sabia sobre eles morria junto: a
     * bússola voltava com `57163 ainda não sei`. Três consequências, e só a
     * primeira é cosmética:
     *
     *   1. As tabelas inflam. `alcancaNaDirecao` conta o desconhecido como
     *      alcançável — viés correto — e com 57 mil desconhecidos o log passou
     *      a publicar US$ 171.137 a 10%, dos quais 3.589 de 3.593 eram palpite.
     *   2. A BRASA ENCHE DE IMUNE. Os 600 pares que o bot resolveu depois do
     *      deploy deram 589 imunes — 98%. Não é azar: ele resolve de cima para
     *      baixo, e quem está no topo da fila de fragilidade está lá PORQUE é
     *      imune (moeda única, o preço se cancela e a queda aparente some). Com
     *      o par desconhecido contando como sensível, eles ocupam as 233 vagas
     *      e empurram alvos reais para fora da patrulha rápida.
     *   3. Reencher custa 4 dias: 57.168 pares a 600 por varredura completa, uma
     *      por hora. E cada deploy zera de novo.
     */
    vias?: Record<string, string>;
    /**
     * O PLACAR DOS TIROS, que morria em todo deploy.
     *
     * MEDIDO em 2026-10-06: o nonce da carteira estava em 6 — duas transações
     * tinham saído — e o log imprimia `tiros: "Nenhum tiro ainda."`. O placar
     * morava em memória e o Railway reinicia o container várias vezes por dia,
     * então a pergunta que mais importa ("ele já atirou?") era respondida com a
     * memória do boot de agora e tinha cara de resposta sobre o passado inteiro.
     *
     * É a MESMA classe de defeito que a bússola (o campo `vias` acima) e tem o
     * mesmo conserto, pelo mesmo arquivo. Opcional pela mesma razão: cache
     * gravado antes desta versão não tem o campo e tem de continuar servindo.
     *
     * O lucro vai como TEXTO porque `JSON.stringify` de um `Decimal` grava os
     * internos da biblioteca (`{"s":1,"e":1,"d":[…]}`), que `new Decimal` não lê
     * de volta: voltaria zero em silêncio. Ver `placarParaCache` em `tiros.ts`.
     */
    placar?: {
        disparados: number;
        acertou: number;
        reverteu: number;
        sumiu: number;
        lucroEstimadoUsd: string;
    };
}

export type EstadoDoCache =
    | { usavel: true; cache: CacheDeDevedores; porque: string }
    | { usavel: false; cache: null; porque: string };

/** O cache é desta rede e deste pool? Cache de outra pool é veneno, não dado. */
export function cacheServe(c: CacheDeDevedores, rede: string, pool: string): boolean {
    return c.versao === VERSAO_DO_CACHE
        && c.rede === rede
        && c.pool.toLowerCase() === pool.toLowerCase();
}

/**
 * Valida a FORMA do que veio do disco.
 *
 * Um arquivo cortado no meio da gravação faz `JSON.parse` passar e devolver um
 * objeto sem campos. Carregar isso como "cache vazio" perderia 3 anos de
 * história em silêncio, que é o defeito mais caro possível aqui.
 */
export function pareceCache(x: unknown): x is CacheDeDevedores {
    if (typeof x !== 'object' || x === null) return false;
    const c = x as Partial<CacheDeDevedores>;
    return typeof c.versao === 'number'
        && typeof c.rede === 'string'
        && typeof c.pool === 'string'
        && Number.isFinite(c.blocoInicial) && typeof c.blocoInicial === 'number'
        && Number.isFinite(c.ultimoBloco) && typeof c.ultimoBloco === 'number'
        && c.ultimoBloco >= c.blocoInicial
        && typeof c.devedores === 'object' && c.devedores !== null;
}

/**
 * O MAIOR bloco abaixo do qual tudo foi lido.
 *
 * `faixasLidas` são as faixas `[de, ate]` que voltaram sem erro. A resposta é o
 * fim da sequência contígua que começa em `inicio` — e `inicio - 1` quando a
 * PRIMEIRA faixa falhou, que significa "não avancei nada".
 *
 * Pura e exportada porque é ela que impede o buraco permanente, e uma função
 * que decide isso dentro de um laço de rede não dá para testar.
 */
export function ateOndeSemBuraco(inicio: number, faixasLidas: Array<[number, number]>): number {
    const ordenadas = [...faixasLidas].sort((a, b) => a[0] - b[0]);
    let fronteira = inicio - 1;
    for (const [de, ate] of ordenadas) {
        // Uma faixa que começa depois da fronteira + 1 deixa buraco: para aqui.
        if (de > fronteira + 1) break;
        if (ate > fronteira) fronteira = ate;
    }
    return fronteira;
}

/**
 * O MENOR bloco acima do qual tudo foi lido, descendo a partir de `fim`.
 *
 * O espelho de `ateOndeSemBuraco`, e existe porque a varredura profunda anda
 * PARA TRÁS. A ordem não é capricho: o histórico de 3,15 anos leva mais de uma
 * hora para ser lido, e o bot não pode ficar cego esse tempo em cada boot.
 * Lendo do mais novo para o mais velho, a cobertura cresce pela ponta que vale
 * — quem tomou emprestado na semana passada ainda deve; quem tomou em 2023 já
 * pagou, foi liquidado, ou vai reaparecer num `Borrow` novo de qualquer forma.
 *
 * `inicio - 1`, no espelho, é `fim + 1`: "não desci nada".
 */
export function deOndeSemBuraco(fim: number, faixasLidas: Array<[number, number]>): number {
    const ordenadas = [...faixasLidas].sort((a, b) => b[1] - a[1]);
    let fronteira = fim + 1;
    for (const [de, ate] of ordenadas) {
        // Uma faixa que termina antes da fronteira - 1 deixa buraco: para aqui.
        if (ate < fronteira - 1) break;
        if (de < fronteira) fronteira = de;
    }
    return fronteira;
}

/**
 * Tira da memória quem NÃO DEVE MAIS NADA.
 *
 * A regra de esquecimento anterior era por IDADE: quem entrou há mais de 30
 * dias saía da lista. Com o cache isso vira contradição — o cache existe
 * justamente para guardar os velhos, e a regra de idade apagaria exatamente o
 * que ele guardou. Pior: apagava sem olhar, então um devedor de 2024 com
 * dívida viva hoje era descartado por ser velho.
 *
 * A regra certa não é idade, é ESTADO, e a varredura completa já o mede de
 * graça: `quedaAteLiquidar` devolve `null` quando a conta não tem dívida. Sem
 * dívida não há liquidação possível — e se a pessoa voltar a tomar emprestado,
 * o `Borrow` novo a traz de volta, porque é exatamente isso que a varredura lê.
 *
 * Então esquecer por estado é reversível e exato; esquecer por idade era
 * irreversível e cego.
 */
export function esquecerQuemNaoDeveMais(
    devedores: Record<string, number>,
    semDivida: Iterable<string>,
): { devedores: Record<string, number>; esquecidos: number } {
    const fora = { ...devedores };
    let esquecidos = 0;
    for (const d of semDivida) {
        const chave = d.toLowerCase();
        if (chave in fora) { delete fora[chave]; esquecidos += 1; }
    }
    return { devedores: fora, esquecidos };
}

/**
 * Quanto do histórico já está coberto, em texto que não mente.
 *
 * Existe porque "cache usável" não é a mesma coisa que "cobertura total", e
 * publicar o primeiro como se fosse o segundo é o defeito que este projeto
 * persegue: o placar dela acusou 11 liquidações com "nem sabia" justamente
 * porque o log dizia que a varredura tinha acontecido sem dizer até onde.
 */
export function comoEstaACobertura(
    cache: CacheDeDevedores | null,
    nascimento: number,
    topo: number,
): string {
    if (cache === null) return `NADA ainda: falta tudo do bloco ${nascimento} até ${topo}`;
    const dias = (n: number) => `${Math.round((n * 2) / 86400)} dias`;
    const cobertos = cache.ultimoBloco - cache.blocoInicial + 1;
    const faltaAtras = Math.max(0, cache.blocoInicial - nascimento);
    const faltaNaFrente = Math.max(0, topo - cache.ultimoBloco);
    const pct = ((cobertos / (topo - nascimento + 1)) * 100).toFixed(2);
    return `${cobertos.toLocaleString('pt-BR')} blocos (${dias(cobertos)}) = ${pct}% da história; `
        + (faltaAtras === 0
            ? 'chego ao nascimento do Pool: cobertura TOTAL para trás'
            : `faltam ${faltaAtras.toLocaleString('pt-BR')} blocos (${dias(faltaAtras)}) para trás`)
        + (faltaNaFrente > 0 ? `, e ${faltaNaFrente.toLocaleString('pt-BR')} na frente` : '');
}

/** Junta o que já se sabia com o que a varredura nova achou. */
/**
 * Junta o que se sabia das vias com o que se aprendeu agora.
 *
 * O novo manda: uma posição muda de par quando o dono troca de garantia ou de
 * dívida, e nesse caso a leitura de agora é a verdade e a antiga é lixo.
 *
 * Só aceita os quatro valores conhecidos. Um cache adulterado ou de uma versão
 * futura não pode injetar uma via que o resto do código não sabe ler — ela
 * cairia no `undefined` e viraria "ainda não sei", que é benigno, mas um valor
 * TORTO viajaria pelas comparações sem ninguém notar.
 */
export const VIAS_CONHECIDAS = ['long', 'short', 'ambas', 'imune'] as const;
export function juntarVias(
    antigas: Record<string, string> | undefined,
    novas: Iterable<[string, string]>,
): Record<string, string> {
    const fora: Record<string, string> = {};
    for (const [k, v] of Object.entries(antigas ?? {})) {
        if ((VIAS_CONHECIDAS as readonly string[]).includes(v)) fora[k.toLowerCase()] = v;
    }
    for (const [k, v] of novas) {
        if ((VIAS_CONHECIDAS as readonly string[]).includes(v)) fora[k.toLowerCase()] = v;
    }
    return fora;
}

/**
 * Tira das vias quem não está mais na lista de devedores.
 *
 * Sem isto o mapa de vias cresceria para sempre, guardando o par de gente que
 * pagou a dívida em 2024 — e é o mesmo vazamento que a regra de esquecimento
 * por estado conserta do outro lado.
 */
export function viasQueAindaImportam(
    vias: Record<string, string>,
    devedores: Record<string, number>,
): Record<string, string> {
    const fora: Record<string, string> = {};
    for (const [k, v] of Object.entries(vias)) if (k in devedores) fora[k] = v;
    return fora;
}

export function juntarDevedoresDoCache(
    antigos: Record<string, number>,
    novos: Iterable<string>,
    bloco: number,
): Record<string, number> {
    const fora: Record<string, number> = { ...antigos };
    for (const d of novos) {
        const chave = d.toLowerCase();
        // O bloco guardado é o MAIS RECENTE em que a pessoa apareceu: é ele que
        // qualquer regra de idade vai ler depois.
        const visto = fora[chave];
        if (visto === undefined || bloco > visto) fora[chave] = bloco;
    }
    return fora;
}

/**
 * De onde a varredura deve começar.
 *
 * Com cache usável: do bloco seguinte ao último coberto sem buraco. Sem cache:
 * do nascimento do Pool. Nunca do bloco 0, e nunca de uma janela de dias — a
 * janela de 30 dias era o buraco no radar que ela viu no placar.
 */
export function deOndeComecar(estado: EstadoDoCache, nascimento: number): number {
    if (!estado.usavel) return nascimento;
    return Math.max(nascimento, estado.cache.ultimoBloco + 1);
}

/**
 * Lê o cache do disco. NUNCA lança.
 *
 * Todo caminho de falha devolve `usavel: false` com o motivo escrito, porque
 * "não tinha cache" e "o cache estava corrompido" pedem a mesma ação (varrer
 * tudo) mas são fatos diferentes, e o log precisa dizer qual foi.
 */
export async function lerCache(
    caminho: string,
    rede: string,
    pool: string,
    ler: (p: string) => Promise<string> = (p) => fs.readFile(p, 'utf8'),
): Promise<EstadoDoCache> {
    let cru: string;
    try {
        cru = await ler(caminho);
    } catch (e) {
        const erro = e as { code?: string };
        return {
            usavel: false,
            cache: null,
            porque: erro.code === 'ENOENT'
                ? `não existe ainda em ${caminho}: primeira varredura, do nascimento do Pool`
                : `não consegui ler ${caminho}: ${(e as Error).message.slice(0, 80)}`,
        };
    }
    let lido: unknown;
    try {
        lido = JSON.parse(cru);
    } catch {
        return { usavel: false, cache: null, porque: `${caminho} não é JSON válido — gravação cortada? varro tudo de novo` };
    }
    if (!pareceCache(lido)) {
        return { usavel: false, cache: null, porque: `${caminho} tem JSON mas não tem a forma do cache: varro tudo de novo` };
    }
    if (!cacheServe(lido, rede, pool)) {
        return {
            usavel: false,
            cache: null,
            porque: `o cache é da rede "${lido.rede}" / pool ${lido.pool.slice(0, 10)}… e eu estou em `
                + `"${rede}" / ${pool.slice(0, 10)}… (ou a versão mudou): NÃO uso, seria dado de outro lugar`,
        };
    }
    const quantos = Object.keys(lido.devedores).length;
    return {
        usavel: true,
        cache: lido,
        porque: `${quantos.toLocaleString('pt-BR')} devedores, coberto até o bloco ${lido.ultimoBloco}`,
    };
}

/**
 * Grava o cache ATOMICAMENTE: arquivo temporário e depois `rename`.
 *
 * `rename` no mesmo sistema de arquivos é atômico, então um container morto no
 * meio da gravação deixa o cache ANTERIOR inteiro em vez de um arquivo cortado.
 * Gravar direto no destino é o jeito de perder 3 anos de história num deploy
 * malcronometrado — e o `pareceCache` acima existe porque eu não confio nem
 * nisto.
 *
 * Devolve o que aconteceu em vez de lançar: cache é acelerador, não motor. Se o
 * volume não estiver montado o bot tem de continuar caçando, reclamando alto.
 */
export async function gravarCache(
    caminho: string,
    dados: CacheDeDevedores,
    io: {
        mkdir?: (p: string) => Promise<void>;
        escrever?: (p: string, conteudo: string) => Promise<void>;
        renomear?: (de: string, para: string) => Promise<void>;
    } = {},
): Promise<{ gravou: boolean; porque: string }> {
    const mkdir = io.mkdir ?? (async (p: string) => { await fs.mkdir(p, { recursive: true }); });
    const escrever = io.escrever ?? ((p: string, c: string) => fs.writeFile(p, c, 'utf8'));
    const renomear = io.renomear ?? ((a: string, b: string) => fs.rename(a, b));
    const temporario = `${caminho}.tmp`;
    try {
        await mkdir(path.dirname(caminho));
        await escrever(temporario, JSON.stringify(dados));
        await renomear(temporario, caminho);
        return {
            gravou: true,
            porque: `${Object.keys(dados.devedores).length.toLocaleString('pt-BR')} devedores até o bloco `
                + `${dados.ultimoBloco} em ${caminho}`,
        };
    } catch (e) {
        return {
            gravou: false,
            porque: `NÃO gravei em ${caminho}: ${(e as Error).message.slice(0, 100)}. O volume está montado? `
                + 'Sem isto o próximo boot varre a história inteira de novo',
        };
    }
}
