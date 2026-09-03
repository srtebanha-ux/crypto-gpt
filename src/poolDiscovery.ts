// Arquivo: src/poolDiscovery.ts
//
// Seleção de quais pools varrer quando a factory tem milhares.
//
// A estratégia de amostragem não é detalhe: ela decide ONDE se está olhando.
// Pools são indexados por ordem de criação, então:
//
//   - 'oldest' varre os primeiros índices — majoritariamente pools mortos de
//     tokens que não existem mais. Quase sempre desperdício.
//   - 'newest' varre os últimos — pools recém-criados, cujo preço ainda não
//     foi alinhado e que os indexadores profissionais podem não ter pego.
//     É a cauda onde há mais chance de ninguém estar olhando.
//   - 'random' cobre o espaço todo de forma não enviesada, com semente fixa
//     para a varredura ser reprodutível: sem isso, duas rodadas seguidas
//     olhariam conjuntos diferentes e não daria para saber se uma mudança no
//     resultado veio do mercado ou do sorteio.
//
// Sem I/O: só decide índices, quem busca é o sniffer.
import { createSeededRandom } from './prng';

export type ScanMode = 'newest' | 'oldest' | 'random';

export function parseScanMode(raw: string | undefined): ScanMode {
    if (raw === undefined) return 'newest';
    if (raw === 'newest' || raw === 'oldest' || raw === 'random') return raw;
    throw new Error(`DEX_SCAN_MODE inválido: "${raw}". Use newest, oldest ou random.`);
}

/**
 * Devolve os índices de pool a buscar, em ordem crescente.
 *
 * Nunca devolve índice repetido nem fora de [0, total): um índice inválido
 * faria `allPairs(i)` reverter e derrubaria o lote inteiro do JSON-RPC.
 */
export function selectPoolIndices(total: number, limit: number, mode: ScanMode, seed = 1): number[] {
    if (!Number.isInteger(total) || total < 0) {
        throw new Error(`Total de pools inválido: ${total}`);
    }
    if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error(`Limite de varredura inválido: ${limit}`);
    }
    if (total === 0) return [];

    const count = Math.min(limit, total);

    if (mode === 'oldest') {
        return Array.from({ length: count }, (_, i) => i);
    }
    if (mode === 'newest') {
        const start = total - count;
        return Array.from({ length: count }, (_, i) => start + i);
    }

    // random: amostragem sem reposição, reprodutível pela semente.
    const random = createSeededRandom(seed);
    const chosen = new Set<number>();
    // Teto de tentativas evita laço infinito se a aleatoriedade for degenerada;
    // o preenchimento sequencial abaixo garante que o resultado sempre tenha
    // `count` índices, mesmo assim.
    const maxAttempts = count * 20;
    let attempts = 0;
    while (chosen.size < count && attempts < maxAttempts) {
        chosen.add(Math.floor(random() * total));
        attempts += 1;
    }
    for (let i = 0; chosen.size < count && i < total; i++) {
        chosen.add(i);
    }
    return Array.from(chosen).sort((a, b) => a - b);
}

/**
 * Verifica se o número devolvido por `allPairsLength()` é plausível para uma
 * factory de verdade.
 *
 * Um endereço que não é factory não estoura: `eth_call` devolve `0x` (que
 * decodifica como zero) ou o dado de outra função. Sem esta checagem, o
 * sniffer diria "0 pools encontrados" e o operador procuraria o problema no
 * lugar errado — exatamente o modo de falha que custou horas no capital
 * zerado do motor triangular.
 */
export function assertPlausiblePoolCount(count: number, factoryAddress: string): void {
    if (!Number.isFinite(count) || count < 0) {
        throw new Error(`allPairsLength() devolveu valor inválido (${count}) em ${factoryAddress}.`);
    }
    if (count === 0) {
        throw new Error(
            `allPairsLength() devolveu 0 em ${factoryAddress}. ` +
                `Uma factory em uso nunca tem zero pools — o endereço provavelmente não é uma factory V2, ` +
                `ou é de outra rede.`,
        );
    }
    // Nenhuma factory real passou de alguns milhões de pares; acima disso o
    // valor quase certamente é lixo decodificado de outra função.
    const SANITY_MAX = 50_000_000;
    if (count > SANITY_MAX) {
        throw new Error(
            `allPairsLength() devolveu ${count} em ${factoryAddress}, acima de qualquer factory real. ` +
                `A resposta provavelmente não é de allPairsLength().`,
        );
    }
}
