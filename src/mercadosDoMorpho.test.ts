import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { AbiCoder, id } from 'ethers';
import {
    julgarMorpho, lerCreateMarket, SELETORES_DO_MORPHO, SELETOR_DO_CALLBACK,
    TOPICO_CREATE_MARKET, LLTV_MAXIMO_QUE_PAGA,
} from './mercadosDoMorpho';

const coder = AbiCoder.defaultAbiCoder();
const MP = '(address,address,address,address,uint256)';

test('o Morpho se identifica pelo BYTECODE, e um candidato errado REPROVA', () => {
    // MEDIDO em 2026-10-09: o contrato de 15.623 bytes em
    // 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb tem os dez seletores e o
    // 0xcf7ea196 do callback. Um candidato com código mas sem a superfície —
    // testei um de 2.323 bytes — reprova em todos os dez.
    //
    // Isto existe por causa do `0x80d1e0f4…` que a REGRA 0 registra: endereço
    // de cabeça publicado sem conferir.
    const cheio = `0x${Object.values(SELETORES_DO_MORPHO).map((s) => s.slice(2)).join('')}${SELETOR_DO_CALLBACK.slice(2)}`;
    const v = julgarMorpho(cheio);
    assert.equal(v.eh, true);
    assert.deepEqual(v.faltando, []);
    assert.equal(v.temCallback, true);

    // Falta UM seletor -> não é, e a função DIZ qual falta.
    const semLiquidate = Object.entries(SELETORES_DO_MORPHO)
        .filter(([k]) => !k.startsWith('liquidate'))
        .map(([, s]) => s.slice(2)).join('');
    const parcial = julgarMorpho(`0x${semLiquidate}`);
    assert.equal(parcial.eh, false);
    assert.equal(parcial.faltando.length, 1);
    assert.match(parcial.faltando[0]!, /^liquidate/);

    // Sem código e com código vazio: reprova, e não explode.
    assert.equal(julgarMorpho('0x').eh, false);
    assert.equal(julgarMorpho('').eh, false);
    assert.equal(julgarMorpho('0x').faltando.length, Object.keys(SELETORES_DO_MORPHO).length);
});

test('o tópico do CreateMarket é calculado por keccak, não copiado', () => {
    assert.equal(TOPICO_CREATE_MARKET, id(`CreateMarket(bytes32,${MP})`));
    assert.equal(TOPICO_CREATE_MARKET.length, 66);
});

test('evento que não decodifica NÃO vira mercado inventado', () => {
    const bom = {
        topics: ['0x' + '0'.repeat(64), `0x${'ab'.repeat(32)}`],
        data: coder.encode([MP], [[
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            '0x4200000000000000000000000000000000000006',
            '0x0000000000000000000000000000000000000111',
            '0x0000000000000000000000000000000000000222',
            625000000000000000n,
        ]]),
        blockNumber: '0x31e2f40',
    };
    const torto = { topics: ['0x00', '0x00'], data: '0xdeadbeef', blockNumber: '0x1' };

    const lidos = lerCreateMarket([bom, torto, bom]);
    // Dois bons, e o torto SOME em vez de virar um mercado com zeros.
    assert.equal(lidos.length, 2, 'evento torto não pode produzir mercado');
    assert.equal(lidos[0]!.lltv.toFixed(3), '0.625');
    assert.equal(lidos[0]!.loanToken, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(lidos[0]!.collateralToken, '0x4200000000000000000000000000000000000006');
    assert.equal(lidos[0]!.blocoDaCriacao, 0x31e2f40);
    // E o bônus sai da fórmula verificada contra o censo: 12,68% a 62,5%.
    assert.equal(lidos[0]!.bonusPct!.toFixed(2), '12.68');
});

test('o corte de LLTV é a conta, não uma preferência', () => {
    // Acima de 77% a fórmula dá 7,41% ou menos, e o alvo real da Aave de
    // 2026-10-07 rendeu 4,56% de bônus: sem vantagem, sem obra.
    assert.equal(LLTV_MAXIMO_QUE_PAGA.toFixed(2), '0.77');
    const { bonusPct } = require('./morpho');
    assert.ok(bonusPct(LLTV_MAXIMO_QUE_PAGA)!.greaterThan(4.56),
        'no limite do corte o Morpho tem de pagar MAIS que a Aave real');
    assert.ok(bonusPct(new Decimal('0.86'))!.lessThan(4.56),
        'e logo acima dele tem de pagar MENOS: é isso que o corte significa');
});
