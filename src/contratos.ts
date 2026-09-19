// Arquivo: src/contratos.ts
//
// O que esta publicado na rede, e como se sabe que esta.
//
// Existe porque endereco guardado em conversa se perde, e porque o executor —
// o unico programa que ainda falta — precisa saber a qual contrato falar e em
// que pool vender. Escrever isso num arquivo com testes transforma "eu lembro"
// em "o programa confere".
//
// Cada endereco aqui foi conferido contra a rede, nao copiado de tela. O
// metodo esta em src/conferirContrato.ts: os argumentos do construtor sao
// lidos do `Input Data` da transacao de criacao e comparados pelo programa,
// porque a caixa de texto do Remix corta o endereco no meio e esconde
// justamente onde um erro de copia moraria.
import { Decimal } from 'decimal.js';

export type FamiliaDeVenda = 'v2' | 'v2+solidly';

export interface CacadorPublicado {
    endereco: string;
    rede: string;
    /** Para onde o lucro vai. IMUTAVEL: nao existe funcao para trocar. */
    cofre: string;
    /** Quem pode mandar cacar. E o msg.sender do deploy. */
    dono: string;
    /** Em que familia de pool ele sabe vender. */
    vendeEm: FamiliaDeVenda;
    blocoDoDeploy: number;
    /** Como se sabe que os campos acima sao esses. */
    conferidoPor: string;
}

/**
 * Os dois cacadores publicados, do mais novo para o mais velho.
 *
 * O segundo nao foi substituido nem aposentado: ele continua valido para pool
 * V2 e custou o gas dele. Guardar os dois deixa uma saida caso o caminho novo
 * mostre algum problema que os testes nao pegaram.
 */
export const CACADORES: CacadorPublicado[] = [
    {
        endereco: '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78',
        rede: 'base',
        cofre: '0x3dffA934170bdD491724747Be2c4F56E3f1512A7',
        dono: '0x3D310384d674532f5D41cF2D43B03001F3515AE8',
        vendeEm: 'v2+solidly',
        blocoDoDeploy: 51499761,
        conferidoPor:
            'Input Data da criacao: _pool e _cofre conferem, getAmountOut(uint256,address) ' +
            'presente entre as chamadas, compilador 0.8.34 lido da marca CBOR',
    },
    {
        endereco: '0xb71249b14bdAEC2669341ed331cF1849c72F12d4',
        rede: 'base',
        cofre: '0x3dffA934170bdD491724747Be2c4F56E3f1512A7',
        dono: '0x3D310384d674532f5D41cF2D43B03001F3515AE8',
        vendeEm: 'v2',
        blocoDoDeploy: 51497086,
        conferidoPor: 'Input Data da criacao: _pool e _cofre conferem, 12 assinaturas presentes',
    },
];

/**
 * Um contrato criado nasce num endereco que e funcao de quem criou e de
 * quantas transacoes essa conta ja tinha feito. Como isso nao depende da rede,
 * o mesmo par (criador, contador) da o mesmo endereco em qualquer blockchain.
 *
 * Por isso `0x9066b0ba...` tambem e o endereco de um contrato que foi
 * publicado por engano na Arbitrum: mesma conta, mesmo contador, outra rede.
 * Sao dois contratos diferentes que moram no mesmo numero. Ao procurar este
 * endereco num explorador, tem de ser no da Base.
 */
export const AVISO_ENDERECO_REPETIDO_NA_ARBITRUM = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';

export function cacadorDaRede(rede: string, precisaDeSolidly = true): CacadorPublicado | null {
    const daRede = CACADORES.filter((c) => c.rede === rede);
    if (!precisaDeSolidly) return daRede[0] ?? null;
    return daRede.find((c) => c.vendeEm === 'v2+solidly') ?? null;
}

// --------------------------------------------------------------------------
// Os pools medidos, e o que cada um aguenta.

export interface PoolMedido {
    endereco: string;
    par: string;
    familia: 'v2' | 'solidly';
    /** Profundidade do lado em dolar, no dia da medicao. */
    profundidadeUsd: Decimal;
    medidoEm: string;
}

/**
 * O melhor de cada familia na Base, medido varrendo 10.000 blocos atras de
 * eventos `Sync` — ou seja, so pools que de fato negociaram.
 *
 * A diferenca entre os dois e o motivo de o contrato novo existir: 6,8 vezes
 * mais fundo vira US$300 de lucro maximo por cacada contra US$2.103, e teto
 * de US$57 mil de dividida contra US$390 mil.
 */
export const POOLS: Record<string, PoolMedido> = {
    aerodrome: {
        endereco: '0xcdac0d6c6c59727a65f871236188350531885c43',
        par: 'WETH/USDC',
        familia: 'solidly',
        profundidadeUsd: new Decimal(4_409_124),
        medidoEm: '2026-09-19',
    },
    uniswapV2: {
        endereco: '0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c',
        par: 'WETH/USDC',
        familia: 'v2',
        profundidadeUsd: new Decimal(649_469),
        medidoEm: '2026-09-19',
    },
};
