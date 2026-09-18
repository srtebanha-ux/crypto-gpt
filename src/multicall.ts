// Arquivo: src/multicall.ts
//
// Muitas leituras numa chamada só — sem depender de o provedor querer.
//
// A primeira tentativa de acelerar a ronda do vigia foi lote de JSON-RPC:
// mandar cinquenta pedidos num POST. Funciona em muitos provedores e NÃO
// funciona no `mainnet.base.org`, que é o único que serve para a Base. O log
// disse, com todas as letras:
//
//     Este provedor não faz lote; voltando para uma por vez.
//     consequencia: a ronda passa a levar uns 62 minutos
//
// O recuo estava certo — melhor lento e avisando do que rápido e mentindo —
// mas não resolvia: 62 minutos de ronda para uma janela de 18.
//
// O Multicall3 resolve por outro caminho. É um contrato publicado no MESMO
// endereço em praticamente toda rede EVM, e o que ele faz é receber uma lista
// de chamadas, executar todas e devolver todas as respostas. Do ponto de vista
// do provedor é UM `eth_call` comum — ele não precisa aceitar nada especial,
// não precisa nem saber que está fazendo mil leituras.
//
// A diferença entre os dois: o lote de JSON-RPC pede um favor ao provedor; o
// Multicall3 não pede nada a ninguém.
import { AbiCoder } from 'ethers';

/**
 * O mesmo endereço em Base, Ethereum, Arbitrum, Optimism, Polygon, Avalanche e
 * dezenas de outras. Não é coincidência: foi publicado com uma técnica que faz
 * o endereço depender só do código, então cai igual em toda rede.
 *
 * Mesmo assim o vigia CONFERE que existe contrato ali antes de usar, porque
 * "praticamente toda rede" não é "toda rede", e numa que não tenha a leitura
 * voltaria vazia — o que se leria como "ninguém perto de liquidar".
 */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** `aggregate3((address,bool,bytes)[])`, conferido com keccak. */
export const SELETOR_AGGREGATE3 = '0x82ad56cb';

const coder = AbiCoder.defaultAbiCoder();

export interface ChamadaMulti {
    alvo: string;
    dados: string;
}

/**
 * Monta a chamada. `allowFailure` é sempre true, de propósito.
 *
 * Com false, uma única leitura que falhe derruba as outras novecentas e
 * noventa e nove junto. Com true, cada uma volta com o seu próprio "deu certo
 * ou não", e quem falhou é contado à parte em vez de sumir.
 */
export function codificarAggregate3(chamadas: ChamadaMulti[]): string {
    const tuplas = chamadas.map((c) => [c.alvo, true, c.dados]);
    return SELETOR_AGGREGATE3 + coder.encode(['tuple(address,bool,bytes)[]'], [tuplas]).slice(2);
}

export interface RespostaMulti {
    ok: boolean;
    dados: string;
}

export function decodificarAggregate3(dataHex: string): RespostaMulti[] {
    const [lista] = coder.decode(['tuple(bool,bytes)[]'], dataHex) as unknown as [
        Array<[boolean, string]>,
    ];
    return [...lista].map((r) => ({ ok: r[0], dados: r[1] }));
}

/**
 * Em quantos pedaços partir, e por que não mandar tudo de uma vez.
 *
 * Oito mil leituras numa chamada só estouram o limite de gás que o provedor
 * aceita para leitura, e a resposta viria como erro — sem dizer que o problema
 * era tamanho. Quinhentas por vez cabem com folga e ainda derrubam a ronda de
 * 62 minutos para menos de um.
 */
export const CHAMADAS_POR_MULTICALL = 500;

export function partirEmPedacos<T>(itens: T[], tamanho = CHAMADAS_POR_MULTICALL): T[][] {
    if (tamanho < 1) throw new Error('tamanho de pedaço tem de ser pelo menos 1');
    const fora: T[][] = [];
    for (let i = 0; i < itens.length; i += tamanho) fora.push(itens.slice(i, i + tamanho));
    return fora;
}
