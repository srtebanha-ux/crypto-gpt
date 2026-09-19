// Arquivo: src/evmAbi.ts
//
// Codificação/decodificação ABI mínima para as poucas chamadas que o leitor
// de pools precisa. Sem ethers/viem de propósito: o projeto inteiro roda com
// duas dependências (decimal.js e ws), e trazer uma biblioteca de 2 MB para
// decodificar cinco funções de leitura não se paga.
//
// Nada aqui faz I/O — tudo função pura, testável sem rede.
import { Decimal } from 'decimal.js';

/**
 * Seletores das funções de leitura (primeiros 4 bytes do keccak-256 da
 * assinatura).
 *
 * ATENÇÃO — estes valores são constantes conhecidas, NÃO calculadas em tempo
 * de execução: o keccak-256 do Ethereum difere do SHA3-256 do Node (padding
 * diferente), e implementar keccak só para isto não se justifica. A
 * consequência é que um seletor errado não estoura exceção: a chamada volta
 * com dado de outra função, ou vazia, e vira um número plausível e errado.
 *
 * Por isso TODA leitura decodificada aqui passa por verificação de sanidade
 * em quem chama (ver `decodeReserves` e o sniffer). Um seletor incorreto tem
 * que aparecer como erro alto, nunca como reserva estranha aceita em
 * silêncio — é a mesma disciplina que fez o capital zerado ser detectado.
 */
export const SELECTORS = {
    /** getReserves() -> (uint112,uint112,uint32) */
    getReserves: '0x0902f1ac',
    /** token0() -> address */
    token0: '0x0dfe1681',
    /** token1() -> address */
    token1: '0xd21220a7',
    /** decimals() -> uint8 */
    decimals: '0x313ce567',
    /** allPairsLength() -> uint256 */
    allPairsLength: '0x574f2ba3',
    /** allPairs(uint256) -> address */
    allPairs: '0x1e3dd18b',
    /** factory() -> address (exposto pelo par V2, aponta para quem o criou) */
    factory: '0xc45a0155',
    /**
     * getPair(address,address) -> address (0x0 quando o par não existe).
     *
     * É o que permite perguntar a DUAS factories pelo MESMO par — a única
     * estrutura que ainda pode fechar ciclo depois de a varredura aleatória
     * ter medido que a Uniswap V2 na Base é um grafo estrela.
     *
     * Como todo seletor daqui, é constante documentada e não calculada
     * (keccak-256 do Ethereum não é o SHA3-256 do Node). Diferente dos outros,
     * este é conferido em execução contra um par conhecido antes de ser usado
     * em massa — ver `assertGetPairSelector`.
     */
    getPair: '0xe6a43905',
} as const;

/** Remove o "0x" e valida que sobrou hex puro. */
export function stripHexPrefix(hex: string): string {
    const raw = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    if (raw.length > 0 && !/^[0-9a-fA-F]+$/.test(raw)) {
        throw new Error(`Resposta não é hexadecimal válido: ${hex}`);
    }
    return raw;
}

/** Uma palavra ABI tem 32 bytes = 64 caracteres hex. */
export const WORD_HEX_LENGTH = 64;

/** Quantas palavras de 32 bytes a resposta contém. */
export function wordCount(hexData: string): number {
    return stripHexPrefix(hexData).length / WORD_HEX_LENGTH;
}

/**
 * Lê a palavra `index` como inteiro sem sinal.
 *
 * Usa Decimal e não BigInt porque uint112/uint256 excedem o Number com folga,
 * e o resto do projeto já faz toda a aritmética financeira em Decimal —
 * misturar BigInt aqui obrigaria a converter em toda fronteira.
 */
export function decodeUintWord(hexData: string, index: number): Decimal {
    const raw = stripHexPrefix(hexData);
    const start = index * WORD_HEX_LENGTH;
    const word = raw.slice(start, start + WORD_HEX_LENGTH);
    if (word.length !== WORD_HEX_LENGTH) {
        throw new Error(`Palavra ${index} ausente ou truncada na resposta (tamanho ${raw.length} hex).`);
    }
    // Decimal não lê hexadecimal direto; converte dígito a dígito em base 16.
    let value = new Decimal(0);
    for (const ch of word) {
        value = value.mul(16).plus(parseInt(ch, 16));
    }
    return value;
}

/** Lê a palavra `index` como address (20 bytes finais), em minúsculas. */
export function decodeAddressWord(hexData: string, index: number): string {
    const raw = stripHexPrefix(hexData);
    const start = index * WORD_HEX_LENGTH;
    const word = raw.slice(start, start + WORD_HEX_LENGTH);
    if (word.length !== WORD_HEX_LENGTH) {
        throw new Error(`Palavra ${index} ausente ou truncada na resposta de address.`);
    }
    return `0x${word.slice(24).toLowerCase()}`;
}

/** Codifica um uint256 como argumento (uma palavra de 32 bytes). */
export function encodeUint256(value: number | Decimal): string {
    const v = new Decimal(value);
    if (v.lessThan(0) || !v.isInteger()) {
        throw new Error(`encodeUint256 exige inteiro não negativo, recebeu ${v.toString()}`);
    }
    // Conversão para hex por divisões sucessivas — Decimal.toHex() não existe.
    let n = v;
    let hex = '';
    const sixteen = new Decimal(16);
    while (n.greaterThan(0)) {
        const digit = n.mod(sixteen).toNumber();
        hex = digit.toString(16) + hex;
        n = n.dividedToIntegerBy(sixteen);
    }
    if (hex === '') hex = '0';
    return hex.padStart(WORD_HEX_LENGTH, '0');
}

/**
 * Codifica um endereço como argumento (uma palavra de 32 bytes, alinhada à
 * direita).
 *
 * Valida o formato em vez de só preencher com zeros: um endereço truncado
 * viraria outro endereço válido, e a chamada devolveria dado de um contrato
 * que ninguém pediu — sem erro nenhum.
 */
export function encodeAddress(address: string): string {
    const raw = stripHexPrefix(address).toLowerCase();
    if (raw.length !== 40) {
        throw new Error(`Endereço deve ter 20 bytes (40 hex), recebeu ${raw.length / 2} bytes: ${address}`);
    }
    return raw.padStart(WORD_HEX_LENGTH, '0');
}

export interface PoolReserves {
    reserve0: Decimal;
    reserve1: Decimal;
    blockTimestampLast: Decimal;
}

/**
 * Decodifica `getReserves()` COM verificação de sanidade.
 *
 * A verificação não é zelo excessivo: é a única defesa contra um seletor
 * errado, um endereço que não é um pool, ou um RPC devolvendo `0x`. Sem ela,
 * qualquer um desses casos vira uma reserva absurda que atravessa a
 * otimização inteira e sai como "oportunidade" no relatório.
 */
export function decodeReserves(hexData: string): PoolReserves {
    const words = wordCount(hexData);
    if (words < 3) {
        throw new Error(
            `getReserves() devolveu ${words} palavra(s); esperado 3. ` +
                `Endereço provavelmente não é um pool de produto constante, ou o RPC retornou vazio.`,
        );
    }

    const reserve0 = decodeUintWord(hexData, 0);
    const reserve1 = decodeUintWord(hexData, 1);
    const blockTimestampLast = decodeUintWord(hexData, 2);

    // uint112 tem teto de 2^112-1. Um valor acima disso significa que a
    // resposta não é o que se pensa que é.
    const MAX_UINT112 = new Decimal(2).pow(112).minus(1);
    if (reserve0.greaterThan(MAX_UINT112) || reserve1.greaterThan(MAX_UINT112)) {
        throw new Error('Reservas excedem uint112 — a resposta não corresponde a getReserves() de um pool V2.');
    }

    return { reserve0, reserve1, blockTimestampLast };
}

/** Decodifica `decimals()` validando a faixa plausível de um ERC-20. */
export function decodeDecimals(hexData: string): number {
    const value = decodeUintWord(hexData, 0).toNumber();
    if (!Number.isInteger(value) || value < 0 || value > 36) {
        throw new Error(`decimals() devolveu ${value}, fora da faixa plausível de um ERC-20 (0-36).`);
    }
    return value;
}

/**
 * Converte um valor bruto on-chain (inteiro na menor unidade) para unidade
 * humana. Sem isso, comparar reservas de tokens com decimais diferentes (USDC
 * com 6, WETH com 18) produz erro de 12 ordens de grandeza — e o erro sai
 * como "arbitragem gigante" em vez de como exceção.
 */
export function fromRawUnits(raw: Decimal, decimals: number): Decimal {
    return raw.dividedBy(new Decimal(10).pow(decimals));
}
