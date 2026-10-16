import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { id } from 'ethers';
import {
    SELETOR_BALANCE_OF,
    SELETOR_GET_RESERVE_DATA,
    SELETOR_UNDERLYING,
    camposQueParecemEndereco,
    conferirEspelhos,
    enderecoDaResposta,
    escolherParPorValor,
    separarEspelhos,
} from './reservas';

const w = (v: string | bigint) =>
    typeof v === 'bigint'
        ? v.toString(16).padStart(64, '0')
        : v.replace(/^0x/i, '').toLowerCase().padStart(64, '0');

/**
 * Um número que REALMENTE enche os 12 primeiros bytes.
 *
 * A primeira versão deste teste usava 12345678901234567890 como "número
 * grande" e 10^27 como "índice enorme". Os dois cabem em 20 bytes, então
 * passavam no filtro de endereço e o teste falhava — mas falhava por dado
 * errado meu, não por defeito do código. Um endereço cabe em 2^160; para não
 * parecer endereço, o número tem de passar disso.
 */
const NAO_CABE_EM_ENDERECO = 2n ** 200n;

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const A_USDC = '0x4e65fe4dba92790696d040ac24aa414708f5c0ab';
const D_USDC = '0x59dca05b6c26dbd64b5381374aaac5cd05644c28';

test('os seletores batem com keccak das assinaturas', () => {
    assert.equal(SELETOR_GET_RESERVE_DATA, id('getReserveData(address)').slice(0, 10));
    assert.equal(SELETOR_UNDERLYING, id('UNDERLYING_ASSET_ADDRESS()').slice(0, 10));
    assert.equal(SELETOR_BALANCE_OF, id('balanceOf(address)').slice(0, 10));
});

test('só os campos com cara de endereço são considerados', () => {
    // Uma resposta de getReserveData mistura números grandes (índices, taxas)
    // com endereços. Números grandes têm bytes nos 12 primeiros, endereços não.
    const resposta = `0x${[
        w(NAO_CABE_EM_ENDERECO), // configuração: não cabe em endereço
        w(NAO_CABE_EM_ENDERECO + 7n), // índice: idem
        w(A_USDC), // espelho de depósito
        w(0n), // zero: ignorado
        w(D_USDC), // espelho de dívida
    ].join('')}`;
    const achados = camposQueParecemEndereco(resposta);
    assert.deepEqual(
        achados.map((a) => a.endereco),
        [A_USDC, D_USDC],
    );
    assert.deepEqual(achados.map((a) => a.posicao), [2, 4]);
});

test('resposta vazia ou torta não vira endereço inventado', () => {
    assert.deepEqual(camposQueParecemEndereco('0x'), []);
    assert.deepEqual(camposQueParecemEndereco('0xabcd'), []);
    assert.equal(enderecoDaResposta('0x'), null);
    assert.equal(enderecoDaResposta(`0x${w(NAO_CABE_EM_ENDERECO)}`), null);
});

test('a resposta do espelho vira endereço minúsculo, para comparar', () => {
    assert.equal(enderecoDaResposta(`0x${w(USDC.toUpperCase())}`), USDC);
});

// ---------------------------------------------------------------------------
// Separar depósito de dívida.
// ---------------------------------------------------------------------------

test('o PRIMEIRO confirmado é o depósito, o ÚLTIMO é a dívida', () => {
    const e = separarEspelhos(USDC, [
        { posicao: 10, endereco: D_USDC },
        { posicao: 8, endereco: A_USDC },
    ]);
    assert.equal(e?.deposito, A_USDC);
    assert.equal(e?.divida, D_USDC);
});

test('com três espelhos (versão antiga tem dívida estável) ainda pega os extremos', () => {
    const estavel = '0x1111111111111111111111111111111111111111';
    const e = separarEspelhos(USDC, [
        { posicao: 8, endereco: A_USDC },
        { posicao: 9, endereco: estavel },
        { posicao: 10, endereco: D_USDC },
    ]);
    assert.equal(e?.deposito, A_USDC);
    assert.equal(e?.divida, D_USDC);
});

test('um espelho só não dá par — e devolve null em vez de repetir o mesmo', () => {
    // Usar o mesmo endereço como depósito e dívida faria o contrato pedir uma
    // liquidação impossível, e o erro sairia como recusa da Aave, não como bug.
    assert.equal(separarEspelhos(USDC, [{ posicao: 8, endereco: A_USDC }]), null);
    assert.equal(separarEspelhos(USDC, []), null);
});

// ---------------------------------------------------------------------------
// Escolher o par: por VALOR, nunca por unidade crua.
// ---------------------------------------------------------------------------

/** USDC tem 6 casas, WETH tem 18. 1 USDC = $1, 1 WETH = $2.600. */
const valorDe = (ativo: string, cru: Decimal): Decimal | null => {
    if (ativo === USDC) return cru.dividedBy(1e6);
    if (ativo === WETH) return cru.dividedBy(new Decimal('1e18')).mul(2600);
    return null;
};

test('o par é escolhido por VALOR, não por unidade crua', () => {
    // A armadilha: 1.000 unidades cruas de WETH são poeira (0,000000000000001
    // ETH) e 1.000 de USDC são 0,001 dólar. Comparar cru escolheria sempre o
    // token de mais casas decimais, e o par pareceria plausível.
    const par = escolherParPorValor(
        [
            { ativo: WETH, garantiaCrua: new Decimal('1e18'), dividaCrua: new Decimal(0) }, // $2.600
            { ativo: USDC, garantiaCrua: new Decimal('5e9'), dividaCrua: new Decimal('2e9') }, // $5.000 / $2.000
        ],
        valorDe,
    );
    assert.equal(par?.garantia, USDC, 'USDC vale mais, apesar de ter menos unidades cruas');
    assert.equal(par?.garantiaUsd.toString(), '5000');
    assert.equal(par?.divida, USDC);
});

test('moeda sem cotação é ignorada em vez de entrar com valor zero', () => {
    // Entrar com zero faria ela nunca ser escolhida — que por acaso é o certo
    // — mas também mascararia a falta de cotação. Ignorar explicitamente
    // mantém a diferença entre "não vale nada" e "não sei quanto vale".
    const desconhecida = '0x9999999999999999999999999999999999999999';
    const par = escolherParPorValor(
        [
            { ativo: desconhecida, garantiaCrua: new Decimal('1e30'), dividaCrua: new Decimal('1e30') },
            { ativo: USDC, garantiaCrua: new Decimal('1e6'), dividaCrua: new Decimal('1e6') },
        ],
        valorDe,
    );
    assert.equal(par?.garantia, USDC);
    assert.equal(par?.divida, USDC);
});

test('sem dívida ou sem garantia não há par', () => {
    assert.equal(escolherParPorValor([], valorDe), null);
    assert.equal(
        escolherParPorValor(
            [{ ativo: USDC, garantiaCrua: new Decimal('1e6'), dividaCrua: new Decimal(0) }],
            valorDe,
        ),
        null,
    );
});

// ---------------------------------------------------------------------------
// A conferência: a descoberta bate com o que a Aave diz?
// ---------------------------------------------------------------------------

test('dívida encontrada perto da informada CONFERE', () => {
    const c = conferirEspelhos({
        dividaEncontradaUsd: new Decimal(980),
        dividaSegundoAave: new Decimal(1000),
    });
    assert.equal(c.confere, true);
    assert.match(c.leitura, /confere/);
});

test('dívida encontrada muito abaixo NÃO confere — espelho trocado', () => {
    // O caso que isso pega: eu separei errado e li o espelho de depósito como
    // se fosse o de dívida. Sem esta conferência, o par sairia plausível e só
    // falharia na hora de valer.
    const c = conferirEspelhos({
        dividaEncontradaUsd: new Decimal(10),
        dividaSegundoAave: new Decimal(1000),
    });
    assert.equal(c.confere, false);
    assert.match(c.leitura, /NÃO CONFERE/);
    assert.match(c.leitura, /às cegas/);
});

test('dívida encontrada muito ACIMA também não confere', () => {
    const c = conferirEspelhos({
        dividaEncontradaUsd: new Decimal(5000),
        dividaSegundoAave: new Decimal(1000),
    });
    assert.equal(c.confere, false);
});

test('usuário sem dívida não passa na conferência, e diz por quê', () => {
    const c = conferirEspelhos({
        dividaEncontradaUsd: new Decimal(0),
        dividaSegundoAave: new Decimal(0),
    });
    assert.equal(c.confere, false);
    assert.match(c.leitura, /não deve nada/);
});
