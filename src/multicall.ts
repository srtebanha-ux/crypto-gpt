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

/**
 * O mesmo que `decodificarAggregate3`, fatiando o hexadecimal na mao.
 *
 * O ethers decodifica `tuple(bool,bytes)[]` de forma generica, e generico
 * custa: medido no caçador, 841ms para 34 respostas de 250 leituras — 41% do
 * tempo de varrer um bloco, e tempo de CPU, que trava o processo inteiro
 * enquanto roda. Um bloco da Base dura 2.000ms.
 *
 * Aqui o formato e conhecido e fixo, entao da para andar direto pelas
 * posicoes. O layout ABI de um array dinamico de tuplas com campo dinamico:
 *
 *   [0]        deslocamento ate o array (sempre 0x20 na resposta do aggregate3)
 *   [base]     quantidade de itens
 *   [base+1+i] deslocamento do item i, contado a partir de `base+1`
 *   no item:   bool ok, depois o deslocamento dos bytes, contado do inicio do item
 *   nos bytes: tamanho, depois o conteudo
 *
 * Existe ao lado do original de proposito: o teste compara os dois sobre a
 * mesma resposta. Um decodificador rapido que discorda do lento nao e rapido,
 * e errado — e erraria em silencio, devolvendo a saude de uma pessoa no lugar
 * da de outra.
 */
export function decodificarAggregate3Rapido(dataHex: string): RespostaMulti[] {
    const hex = dataHex.replace(/^0x/, '');
    const palavra = (i: number) => hex.slice(i * 64, (i + 1) * 64);
    const numero = (i: number) => Number(BigInt(`0x${palavra(i)}`));

    // A resposta inteira e um unico valor dinamico: a primeira palavra aponta
    // para onde o array comeca, em bytes.
    const base = numero(0) / 32;
    const quantos = numero(base);
    const fora: RespostaMulti[] = new Array(quantos);

    for (let i = 0; i < quantos; i += 1) {
        // Deslocamento do item, em bytes, a partir da palavra seguinte ao
        // tamanho do array.
        const item = base + 1 + numero(base + 1 + i) / 32;
        const ok = palavra(item).endsWith('1');
        // Dentro do item: [0] ok, [1] deslocamento dos bytes a partir do item.
        const bytes = item + numero(item + 1) / 32;
        const tamanho = numero(bytes);
        const inicio = (bytes + 1) * 64;
        fora[i] = { ok, dados: `0x${hex.slice(inicio, inicio + tamanho * 2)}` };
    }
    return fora;
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
 * era tamanho.
 *
 * Eram 500, e 500 fazia o `mainnet.base.org` recusar por excesso: 742 de 8.242
 * endereços ficavam sem ser olhados a cada ronda. Nove por cento — logo abaixo
 * do alarme de dez, então o vigia ficava calado sobre gente que ele não
 * olhou. Passar raspando de um alarme é pior que estourá-lo, porque não deixa
 * rastro.
 *
 * 250 dobra o número de chamadas e continua deixando a ronda em segundos.
 */
export const CHAMADAS_POR_MULTICALL = Number(process.env.MULTICALL_PEDACO ?? '250');

export function partirEmPedacos<T>(itens: T[], tamanho = CHAMADAS_POR_MULTICALL): T[][] {
    if (tamanho < 1) throw new Error('tamanho de pedaço tem de ser pelo menos 1');
    const fora: T[][] = [];
    for (let i = 0; i < itens.length; i += tamanho) fora.push(itens.slice(i, i + tamanho));
    return fora;
}
