// Arquivo: src/evmAbi.test.ts
//
// A verificação de sanidade da decodificação é o que separa "erro alto" de
// "número plausível e errado". Como os seletores são constantes que NÃO podem
// ser calculadas em tempo de execução (keccak-256 != SHA3-256 do Node), um
// seletor incorreto se manifesta como resposta inesperada — e é justamente
// isso que estes testes fixam que precisa estourar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    decodeAddressWord,
    decodeDecimals,
    decodeReserves,
    decodeUintWord,
    encodeUint256,
    fromRawUnits,
    stripHexPrefix,
    wordCount,
} from './evmAbi';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

/** Monta uma palavra ABI de 32 bytes a partir de um hex curto. */
function word(hex: string): string {
    return hex.replace(/^0x/, '').padStart(64, '0');
}

test('stripHexPrefix remove 0x e aceita hex vazio', () => {
    assert.equal(stripHexPrefix('0xabcd'), 'abcd');
    assert.equal(stripHexPrefix('abcd'), 'abcd');
    assert.equal(stripHexPrefix('0x'), '');
});

test('stripHexPrefix rejeita conteúdo não hexadecimal em vez de seguir adiante', () => {
    assert.throws(() => stripHexPrefix('0xzz'), /não é hexadecimal/);
});

test('decodeUintWord lê valores maiores que Number.MAX_SAFE_INTEGER sem perder precisão', () => {
    // 2^112 - 1, o teto de uint112 — bem além do que um Number representa.
    const maxUint112 = new Decimal(2).pow(112).minus(1);
    const hex = '0x' + word('f'.repeat(28));
    assert.equal(decodeUintWord(hex, 0).toString(), maxUint112.toString());
});

test('decodeUintWord: palavra truncada estoura em vez de devolver lixo', () => {
    assert.throws(() => decodeUintWord('0xabcd', 0), /truncada/);
});

test('decodeAddressWord extrai os 20 bytes finais em minúsculas', () => {
    const addr = '0x4200000000000000000000000000000000000006';
    const hex = '0x' + word(addr);
    assert.equal(decodeAddressWord(hex, 0), addr.toLowerCase());
});

test('encodeUint256 gera palavra de 32 bytes com padding à esquerda', () => {
    assert.equal(encodeUint256(0), '0'.repeat(64));
    assert.equal(encodeUint256(1), '0'.repeat(63) + '1');
    assert.equal(encodeUint256(255), '0'.repeat(62) + 'ff');
    assert.equal(encodeUint256(new Decimal('1000000')), word('f4240'));
});

test('encodeUint256 rejeita negativo e fracionário', () => {
    assert.throws(() => encodeUint256(-1), /inteiro não negativo/);
    assert.throws(() => encodeUint256(new Decimal('1.5')), /inteiro não negativo/);
});

test('wordCount conta palavras de 32 bytes', () => {
    assert.equal(wordCount('0x' + word('1') + word('2') + word('3')), 3);
    assert.equal(wordCount('0x'), 0);
});

// --- decodeReserves: a defesa contra seletor errado -------------------------

test('decodeReserves lê as três palavras de um getReserves() válido', () => {
    const hex = '0x' + word('3b9aca00') + word('1bc16d674ec80000') + word('66d1a2b0');
    const r = decodeReserves(hex);
    assert.equal(r.reserve0.toString(), '1000000000'); // 1e9
    assert.equal(r.reserve1.toString(), '2000000000000000000'); // 2e18
    assert.ok(r.blockTimestampLast.greaterThan(0));
});

test('resposta vazia do RPC estoura com mensagem acionável, não vira reserva zero', () => {
    // É o caso de endereço que não é pool, ou seletor errado: o nó devolve
    // "0x". Aceitar isso silenciosamente colocaria um pool fantasma no grafo.
    assert.throws(() => decodeReserves('0x'), /devolveu 0 palavra\(s\)/);
});

test('resposta curta demais estoura (seletor errado devolvendo outra coisa)', () => {
    assert.throws(() => decodeReserves('0x' + word('1') + word('2')), /esperado 3/);
});

test('reservas acima de uint112 estouram — não é um pool V2', () => {
    // Todas as palavras cheias: passa na contagem, mas o valor é impossível
    // para uint112. Sem esta checagem viraria uma "oportunidade" absurda.
    const hex = '0x' + word('f'.repeat(64)) + word('1') + word('1');
    assert.throws(() => decodeReserves(hex), /excedem uint112/);
});

// --- decimals ---------------------------------------------------------------

test('decodeDecimals aceita os valores usuais de ERC-20', () => {
    assert.equal(decodeDecimals('0x' + word('6')), 6); // USDC
    assert.equal(decodeDecimals('0x' + word('12')), 18); // WETH (0x12 = 18)
});

test('decodeDecimals rejeita valor fora da faixa plausível', () => {
    assert.throws(() => decodeDecimals('0x' + word('ff')), /fora da faixa plausível/);
});

// --- Normalização de casas decimais ----------------------------------------

test('fromRawUnits normaliza tokens com decimais diferentes', () => {
    // Comparar USDC (6) com WETH (18) sem normalizar dá erro de 1e12 — e o
    // erro sai como "arbitragem gigante", não como exceção.
    assert.equal(fromRawUnits(new Decimal('1000000'), 6).toString(), '1');
    assert.equal(fromRawUnits(new Decimal('1000000000000000000'), 18).toString(), '1');
});

test('fromRawUnits preserva fração', () => {
    assert.equal(fromRawUnits(new Decimal('1500000'), 6).toString(), '1.5');
});
