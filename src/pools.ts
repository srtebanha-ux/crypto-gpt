// Arquivo: src/pools.ts
//
// Achar o pool de venda perguntando à rede — nunca escrevendo endereço de cor.
//
// Este é o único lugar do projeto onde um endereço errado não reverte: manda o
// dinheiro embora. A Aave recusa pedido malformado, o contrato reverte abaixo
// do piso, mas um "pool" que não é pool aceita a transferência e some. Por
// isso aqui não existe tabela escrita à mão, nem endereço copiado de site.
//
// O truque que dispensa tudo isso: um pool de produto constante ANUNCIA que é
// um, a cada troca, emitindo `Sync`. Varrer os blocos recentes procurando esse
// evento devolve a lista de todos os pools ativos da rede — provados por terem
// se comportado como pool, não por alguém ter dito que são.
//
// E o tipo do evento separa as duas famílias sozinho:
//
//   Sync(uint112,uint112)  -> Uniswap V2 e seus clones
//   Sync(uint256,uint256)  -> Solidly e seus clones (Aerodrome)
//
// Essa distinção não é detalhe de catálogo. `CacadorDeLiquidacoes` lê
// `getReserves()` como `(uint112,uint112,uint32)`, que é o formato V2. Contra
// um pool Solidly isso ou reverte ou — pior — decodifica por acidente, porque
// reservas pequenas cabem em 112 bits e um timestamp cabe em 32. Um acerto por
// acidente é o defeito mais caro que existe: funciona no teste e falha no dia.
//
// Por isso a varredura conta as duas famílias e só devolve a V2 como usável.
import { Decimal } from 'decimal.js';
import { id } from 'ethers';

export const ASSINATURA_SYNC_V2 = 'Sync(uint112,uint112)';
export const ASSINATURA_SYNC_SOLIDLY = 'Sync(uint256,uint256)';

/** Calculados do nome, como todo seletor deste projeto: copiar é onde entra o erro. */
export const TOPICO_SYNC_V2 = id(ASSINATURA_SYNC_V2);
export const TOPICO_SYNC_SOLIDLY = id(ASSINATURA_SYNC_SOLIDLY);

export type Familia = 'v2' | 'solidly';

export const TOPICO_DA_FAMILIA: Record<Familia, string> = {
    v2: TOPICO_SYNC_V2,
    solidly: TOPICO_SYNC_SOLIDLY,
};

export interface LogDeSync {
    address: string;
    topics: string[];
}

/**
 * Quantas trocas cada endereço fez na janela varrida.
 *
 * Atividade e não profundidade de propósito: um pool fundo e parado pode estar
 * abandonado, com preço velho em relação ao mercado, e vender nele é doar. A
 * profundidade se lê depois, em `getReserves()`; aqui se mede se o pool está
 * VIVO, que é a pergunta que a reserva não responde.
 */
export function contarAtividade(logs: LogDeSync[]): Map<string, number> {
    const conta = new Map<string, number>();
    for (const l of logs) {
        const a = l.address.toLowerCase();
        conta.set(a, (conta.get(a) ?? 0) + 1);
    }
    return conta;
}

export interface Candidato {
    pool: string;
    trocas: number;
}

export function ordenarPorAtividade(conta: Map<string, number>, quantos = 200): Candidato[] {
    return [...conta.entries()]
        .map(([pool, trocas]) => ({ pool, trocas }))
        .sort((a, b) => b.trocas - a.trocas)
        .slice(0, quantos);
}

export interface Pool {
    endereco: string;
    familia: Familia;
    trocas: number;
    token0: string;
    token1: string;
    reserva0: Decimal;
    reserva1: Decimal;
    /** Símbolos e casas, quando deu para ler. */
    simbolo0?: string;
    simbolo1?: string;
    decimais0?: number;
    decimais1?: number;
}

/** A reserva do lado que a gente RECEBE ao vender `token` aqui. */
export function reservaDoOutroLado(pool: Pool, token: string): Decimal | null {
    const t = token.toLowerCase();
    if (pool.token0.toLowerCase() === t) return pool.reserva1;
    if (pool.token1.toLowerCase() === t) return pool.reserva0;
    return null;
}

/** Em unidades humanas: a reserva crua dividida pelas casas da moeda. */
export function emUnidades(bruto: Decimal, decimais: number | undefined): Decimal | null {
    if (decimais === undefined) return null;
    return bruto.dividedBy(new Decimal(10).pow(decimais));
}

export interface EscolhaDePool {
    pool: Pool | null;
    recebe: Decimal | null;
    motivo: string;
}

/**
 * O melhor pool para vender `garantia` recebendo `divida`.
 *
 * "Melhor" é o mais fundo do lado que se RECEBE, porque é essa reserva que
 * define o empurrão no preço — a do lado que entra só importa pela proporção.
 *
 * Devolve motivo sempre, inclusive quando não acha: "não achei" sem dizer
 * quantos foram olhados e por que nenhum serviu manda adivinhar o próximo
 * passo, e adivinhar é o que este arquivo existe para acabar.
 */
export function escolherPoolDeVenda(pools: Pool[], garantia: string, divida: string): EscolhaDePool {
    const g = garantia.toLowerCase();
    const d = divida.toLowerCase();
    const doPar = pools.filter((p) => {
        const t0 = p.token0.toLowerCase();
        const t1 = p.token1.toLowerCase();
        return (t0 === g && t1 === d) || (t0 === d && t1 === g);
    });

    if (doPar.length === 0) {
        return {
            pool: null,
            recebe: null,
            motivo: `nenhum dos ${pools.length} pools vistos negocia esse par direto`,
        };
    }

    const soV2 = doPar.filter((p) => p.familia === 'v2');
    if (soV2.length === 0) {
        return {
            pool: null,
            recebe: null,
            motivo:
                `${doPar.length} pool(s) negociam o par, mas nenhum é da família V2. ` +
                'O contrato lê getReserves() como (uint112,uint112,uint32) e não serve para Solidly',
        };
    }

    let melhor = soV2[0];
    let maior = reservaDoOutroLado(melhor, garantia) ?? new Decimal(0);
    for (const p of soV2.slice(1)) {
        const r = reservaDoOutroLado(p, garantia) ?? new Decimal(0);
        if (r.greaterThan(maior)) {
            melhor = p;
            maior = r;
        }
    }
    return {
        pool: melhor,
        recebe: maior,
        motivo: `o mais fundo de ${soV2.length} pool(s) V2 do par (${doPar.length} no total, com Solidly)`,
    };
}
