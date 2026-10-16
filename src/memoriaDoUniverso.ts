/**
 * A MEMORIA DO UNIVERSO: os pools que o cacador JA viu negociar, no disco.
 *
 * POR QUE ELA EXISTE, e esta medido em 2026-10-16: o universo do cacador e
 * descoberto UMA vez, no boot, por `universoPorAtividade` — os pools que
 * emitiram `Swap` na janela recente. Quem nao negociou na janela nao entra, e
 * a rota sobre ele nem chega a ser gerada.
 *
 * A MEDICAO que trouxe este arquivo, nas duas vencedoras compativeis:
 *
 *     0xa72914e1…  b52632037  cobertura 2/2  ->  rota gerada, cotada, +2,2e13 liquido
 *     0x6966a108…  b52632036  cobertura 0/2  ->  rota NAO gerada
 *
 * Os dois pools da segunda (`0x3e31de9d…` V3 e `0x566bee7e…` Aerodrome) NAO
 * emitiram `Swap` em 60 blocos anteriores (cobertura 100% da varredura, 0
 * blocos falhos), e NASCERAM 14,5 milhoes de blocos antes — uns 337 dias. Ou
 * seja:
 *
 *   - janela maior de atividade NAO os acha (ficaram quietos 60 blocos, e 60 ja
 *     e 5x a janela de 12 que o cacador usou);
 *   - descoberta por EVENTO DE FABRICA em janela curta NAO os acha: o
 *     `PoolCreated` deles esta 14,5M de blocos atras;
 *   - o que os acha e MEMORIA: um pool visto negociando em qualquer ciclo
 *     anterior continua conhecido quando fica quieto.
 *
 * O QUE ELA NAO GUARDA, e isto e a regra central do arquivo: PRECO NENHUM.
 * Nem `slot0`, nem reservas, nem cotacao. So identidade e metadado verificado
 * — endereco, protocolo, os dois tokens, taxa, `stable()`, fabrica. Estado e
 * cotacao sao SEMPRE lidos no bloco, por `lerEstadoMisto` e `cotarAfetadas`.
 * Guardar preco aqui seria decidir dinheiro com numero velho, que e o defeito
 * que este projeto persegue desde a primeira pagina.
 *
 * E O QUE ELA DECLARA: memoria ausente ou torta devolve `null`, nunca uma
 * memoria VAZIA. "Nao li o arquivo" e "nao conheco pool nenhum" pedem acoes
 * opostas, e publicar a segunda no lugar da primeira e ausencia com cara de
 * resposta.
 */
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import type { PoolMisto } from './rotasMistas';

const log = createLogger('universo');

/** Um pool lembrado, com os metadados que a rota precisa. */
export interface PoolLembrado {
    /** Endereco em MINUSCULO. */
    endereco: string;
    /** `chainId`. A chave inclui a rede: o mesmo endereco em outra rede e outro pool. */
    rede: number;
    protocolo: 'v2' | 'v3' | 'aerodrome';
    token0: string;
    token1: string;
    /** `fee` do V3 em centesimos de ponto base. `null` fora do V3. */
    taxa: number | null;
    /** `stable()` do Aerodrome. `null` = NAO LI, e nao li nao e `false`. */
    estavel: boolean | null;
    fabrica: string | null;
    /** O ultimo bloco em que ele foi VISTO NEGOCIANDO. */
    vistoNoBloco: number;
    /** Em quantas descobertas ele apareceu. */
    vezes: number;
}

export interface MemoriaDoUniverso {
    versao: 1;
    rede: number;
    gravadoEm: string;
    /** O maior bloco de descoberta que entrou nesta memoria. */
    atualizadoNoBloco: number;
    pools: PoolLembrado[];
}

/**
 * A CHAVE DE DEDUPLICACAO: rede, protocolo e endereco.
 *
 * As tres, e nao so o endereco: o mesmo endereco existe em outra rede, e um
 * endereco visto com dois protocolos diferentes e leitura divergente que NAO
 * pode ser silenciosamente unida — a conta de cada venue e outra.
 */
export function chaveDoPool(p: { rede: number; protocolo: string; endereco: string }): string {
    return `${p.rede}:${p.protocolo}:${p.endereco.toLowerCase()}`;
}

export function memoriaVazia(rede: number): MemoriaDoUniverso {
    return {
        versao: 1, rede, gravadoEm: new Date().toISOString(), atualizadoNoBloco: 0, pools: [],
    };
}

/**
 * ISTO PARECE UMA MEMORIA?
 *
 * Mesmo desenho do `pareceCache` do cacador de liquidacoes, e pela mesma razao:
 * um arquivo cortado pela metade e JSON valido com cara de medicao. Um pool sem
 * os dois tokens e recusado — rota montada com token faltando mira o par errado.
 */
export function pareceMemoria(x: unknown): x is MemoriaDoUniverso {
    if (x === null || typeof x !== 'object') return false;
    const m = x as Record<string, unknown>;
    if (m.versao !== 1 || typeof m.rede !== 'number' || !Array.isArray(m.pools)) return false;
    if (typeof m.atualizadoNoBloco !== 'number' || !Number.isFinite(m.atualizadoNoBloco)) {
        return false;
    }
    return (m.pools as unknown[]).every((p) => {
        if (p === null || typeof p !== 'object') return false;
        const q = p as Record<string, unknown>;
        return typeof q.endereco === 'string' && /^0x[0-9a-f]{40}$/.test(q.endereco)
            && typeof q.rede === 'number'
            && (q.protocolo === 'v2' || q.protocolo === 'v3' || q.protocolo === 'aerodrome')
            && typeof q.token0 === 'string' && /^0x[0-9a-f]{40}$/i.test(q.token0)
            && typeof q.token1 === 'string' && /^0x[0-9a-f]{40}$/i.test(q.token1)
            && (q.taxa === null || typeof q.taxa === 'number')
            && (q.estavel === null || typeof q.estavel === 'boolean')
            && (q.fabrica === null || typeof q.fabrica === 'string')
            && typeof q.vistoNoBloco === 'number' && Number.isFinite(q.vistoNoBloco)
            && typeof q.vezes === 'number' && Number.isFinite(q.vezes);
    });
}

/**
 * LE a memoria. `null` quer dizer "nao tenho memoria", nunca "nao ha pool".
 *
 * Memoria de OUTRA rede tambem devolve `null`: usar pool de outra corrente seria
 * mirar endereco que nao existe aqui.
 */
export function lerMemoria(caminho: string, rede: number): MemoriaDoUniverso | null {
    try {
        if (!fs.existsSync(caminho)) return null;
        const cru = JSON.parse(fs.readFileSync(caminho, 'utf8')) as unknown;
        if (!pareceMemoria(cru)) {
            log.warn('[UNIVERSO] Memória TORTA: ignorei o arquivo.', {
                caminho,
                oQueIssoNaoE: 'não é "não conheço pool nenhum": é "não li". As duas pedem '
                    + 'ações opostas, e tratar a primeira como a segunda é ausência com cara '
                    + 'de resposta',
            });
            return null;
        }
        if (cru.rede !== rede) {
            log.warn('[UNIVERSO] Memória de OUTRA rede: ignorei.', {
                naMemoria: cru.rede, agora: rede,
            });
            return null;
        }
        return cru;
    } catch (e) {
        log.warn('[UNIVERSO] NÃO li a memória.', { caminho, erro: String(e).slice(0, 120) });
        return null;
    }
}

/**
 * A FILA DE GRAVACAO e o nome UNICO por gravacao.
 *
 * Os dois vem de um defeito MEDIDO neste projeto em 2026-10-07: o temporario
 * era `${caminho}.tmp`, duas gravacoes concorrentes disputaram o mesmo arquivo,
 * e o `rename` da segunda falhou com ENOENT porque a primeira ja o havia
 * renomeado. Pior do que perder uma gravacao: duas escritas podem se intercalar
 * e publicar um JSON cortado em cima do historico.
 */
let fila: Promise<void> = Promise.resolve();
let contador = 0;

export function gravarMemoria(caminho: string, m: MemoriaDoUniverso): Promise<void> {
    fila = fila.then(async () => {
        try {
            fs.mkdirSync(path.dirname(caminho), { recursive: true });
            contador += 1;
            const tmp = `${caminho}.${process.pid}.${Date.now()}.${contador}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ ...m, gravadoEm: new Date().toISOString() }));
            fs.renameSync(tmp, caminho);
        } catch (e) {
            log.warn('[UNIVERSO] NÃO gravei a memória.', { erro: String(e).slice(0, 120) });
        }
    });
    return fila;
}

/**
 * JUNTA os pools recem-descobertos na memoria, e DIZ quais sao novos.
 *
 * A lista de novos e o que decide se as rotas precisam ser refeitas: refazer
 * `candidatasMistas` a cada ciclo seria gastar CPU para repetir a resposta de
 * antes, e nao refazer nunca e o defeito que este arquivo conserta.
 *
 * O TETO existe para a memoria nao crescer sem limite num processo que roda por
 * dias. Quando corta, corta o que negociou mais ANTIGO — e devolve quantos
 * cortou, porque "a memoria esta cheia" e uma causa de cobertura perdida que
 * nao pode ficar invisivel.
 *
 * METADADO VERIFICADO SOBREPOE o nao-verificado: um pool que entra sem
 * `stable()` lido (`null`) nao apaga um `stable()` que a memoria ja tinha. O
 * contrario — `null` sobrescrevendo medicao — e trocar dado por ausencia.
 */
export function juntar(
    m: MemoriaDoUniverso,
    novos: PoolLembrado[],
    opcoes: { teto?: number } = {},
): {
        memoria: MemoriaDoUniverso;
        novas: string[];
        atualizadas: number;
        descartadosPorTeto: number;
        recusadosPorRede: number;
    } {
    const teto = opcoes.teto ?? 5_000;
    const porChave = new Map(m.pools.map((p) => [chaveDoPool(p), { ...p }]));
    const novas: string[] = [];
    let atualizadas = 0;
    let recusadosPorRede = 0;
    let maiorBloco = m.atualizadoNoBloco;
    for (const p of novos) {
        if (p.rede !== m.rede) { recusadosPorRede += 1; continue; }
        const k = chaveDoPool(p);
        maiorBloco = Math.max(maiorBloco, p.vistoNoBloco);
        const antes = porChave.get(k);
        if (antes === undefined) {
            porChave.set(k, { ...p, endereco: p.endereco.toLowerCase(), vezes: p.vezes || 1 });
            novas.push(k);
            continue;
        }
        porChave.set(k, {
            ...antes,
            // O ESTADO nao entra aqui, so identidade e metadado. Veja o
            // cabecalho: preco e lido no bloco, sempre.
            token0: p.token0 || antes.token0,
            token1: p.token1 || antes.token1,
            taxa: p.taxa ?? antes.taxa,
            estavel: p.estavel ?? antes.estavel,
            fabrica: p.fabrica ?? antes.fabrica,
            vistoNoBloco: Math.max(antes.vistoNoBloco, p.vistoNoBloco),
            vezes: antes.vezes + 1,
        });
        atualizadas += 1;
    }
    let pools = [...porChave.values()];
    let descartadosPorTeto = 0;
    if (pools.length > teto) {
        pools.sort((a, b) => b.vistoNoBloco - a.vistoNoBloco);
        descartadosPorTeto = pools.length - teto;
        pools = pools.slice(0, teto);
    }
    return {
        memoria: {
            versao: 1,
            rede: m.rede,
            gravadoEm: m.gravadoEm,
            atualizadoNoBloco: maiorBloco,
            pools,
        },
        novas,
        atualizadas,
        descartadosPorTeto,
        recusadosPorRede,
    };
}

/**
 * OS POOLS LEMBRADOS na forma que `candidatasMistas` recebe.
 *
 * So os de liquidez CONCENTRADA e Aerodrome: e deles que sai a rota mista, e e
 * esse o caminho que o `CacadorV3` executa. Pool sem os dois tokens nao sai
 * daqui — rota com token faltando mira o par errado.
 */
export function paraRotas(m: MemoriaDoUniverso): PoolMisto[] {
    return m.pools
        .filter((p) => (p.protocolo === 'v3' || p.protocolo === 'aerodrome')
            && p.token0 !== '' && p.token1 !== '')
        .map((p) => ({
            endereco: p.endereco,
            token0: p.token0,
            token1: p.token1,
            venue: p.protocolo === 'v3' ? ('v3' as const) : ('aerodrome' as const),
            taxa: p.taxa,
            estavel: p.estavel,
            fabrica: p.fabrica,
        }));
}

/**
 * Os `PoolMisto` que a descoberta devolveu, na forma lembrada.
 *
 * `vistoNoBloco` e o bloco da descoberta: e ele que ordena o corte pelo teto, e
 * e ele que diz, depois, se um pool esta quieto ha muito tempo.
 */
export function deDescoberta(
    concentrados: PoolMisto[], rede: number, bloco: number,
): PoolLembrado[] {
    return concentrados.map((p) => ({
        endereco: p.endereco.toLowerCase(),
        rede,
        protocolo: p.venue === 'v3' ? ('v3' as const) : ('aerodrome' as const),
        token0: p.token0,
        token1: p.token1,
        taxa: p.taxa,
        estavel: p.estavel ?? null,
        fabrica: p.fabrica ?? null,
        vistoNoBloco: bloco,
        vezes: 1,
    }));
}

/** A frase do log, com o que decide ação: novos, teto e idade. */
export function comoLerAMemoria(m: MemoriaDoUniverso): string {
    const v3 = m.pools.filter((p) => p.protocolo === 'v3').length;
    const aero = m.pools.filter((p) => p.protocolo === 'aerodrome').length;
    const v2 = m.pools.filter((p) => p.protocolo === 'v2').length;
    return `${m.pools.length} pool(s) lembrado(s) (${v3} V3, ${aero} Aerodrome, ${v2} V2), `
        + `atualizada no bloco ${m.atualizadoNoBloco}. Ela guarda identidade e metadado — `
        + 'preço nenhum: estado e cotação são lidos no bloco, sempre';
}
