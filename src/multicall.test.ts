import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import {
    CHAMADAS_POR_MULTICALL,
    MULTICALL3,
    SELETOR_AGGREGATE3,
    codificarAggregate3,
    decodificarAggregate3,
    partirEmPedacos,
} from './multicall';

const coder = AbiCoder.defaultAbiCoder();
const ALVO = '0x1111111111111111111111111111111111111111';

test('o seletor bate com keccak("aggregate3((address,bool,bytes)[])")', () => {
    assert.equal(SELETOR_AGGREGATE3, '0x82ad56cb');
});

test('o endereço do Multicall3 está no formato certo', () => {
    assert.match(MULTICALL3, /^0x[0-9a-fA-F]{40}$/);
});

test('a chamada começa com o seletor e volta a decodificar igual', () => {
    const c = codificarAggregate3([
        { alvo: ALVO, dados: '0xdeadbeef' },
        { alvo: ALVO, dados: '0xcafe' },
    ]);
    assert.ok(c.startsWith(SELETOR_AGGREGATE3));

    const [tuplas] = coder.decode(['tuple(address,bool,bytes)[]'], `0x${c.slice(10)}`) as unknown as [
        Array<[string, boolean, string]>,
    ];
    assert.equal(tuplas.length, 2);
    assert.equal(tuplas[0][0].toLowerCase(), ALVO);
    assert.equal(tuplas[0][2], '0xdeadbeef');
});

test('allowFailure é SEMPRE true', () => {
    // Com false, uma leitura ruim derruba as outras 499 junto — e a lista da
    // borda voltaria vazia, que aqui se lê como "ninguém perto de liquidar".
    const c = codificarAggregate3([{ alvo: ALVO, dados: '0x01' }, { alvo: ALVO, dados: '0x02' }]);
    const [tuplas] = coder.decode(['tuple(address,bool,bytes)[]'], `0x${c.slice(10)}`) as unknown as [
        Array<[string, boolean, string]>,
    ];
    assert.deepEqual(tuplas.map((t) => t[1]), [true, true]);
});

test('a resposta separa quem deu certo de quem falhou, em vez de sumir', () => {
    const bruto = coder.encode(['tuple(bool,bytes)[]'], [[[true, '0xabcd'], [false, '0x']]]);
    const fora = decodificarAggregate3(bruto);
    assert.deepEqual(fora, [
        { ok: true, dados: '0xabcd' },
        { ok: false, dados: '0x' },
    ]);
});

test('a ordem da resposta é a ordem do pedido', () => {
    // O vigia casa resposta com endereço pela POSIÇÃO. Se a ordem embaralhasse,
    // ele atribuiria a saúde de um devedor a outro — e o erro não apareceria
    // como erro, apareceria como uma lista de borda errada.
    const n = 20;
    const bruto = coder.encode(
        ['tuple(bool,bytes)[]'],
        [Array.from({ length: n }, (_, i) => [true, `0x${i.toString(16).padStart(4, '0')}`])],
    );
    const fora = decodificarAggregate3(bruto);
    assert.equal(fora.length, n);
    fora.forEach((r, i) => assert.equal(r.dados, `0x${i.toString(16).padStart(4, '0')}`));
});

test('lista vazia não quebra', () => {
    const c = codificarAggregate3([]);
    assert.ok(c.startsWith(SELETOR_AGGREGATE3));
    assert.deepEqual(decodificarAggregate3(coder.encode(['tuple(bool,bytes)[]'], [[]])), []);
});

test('partir em pedaços não perde nem duplica ninguém', () => {
    const itens = Array.from({ length: 8243 }, (_, i) => i);
    const pedacos = partirEmPedacos(itens, CHAMADAS_POR_MULTICALL);
    assert.equal(pedacos.length, 17);
    assert.deepEqual(pedacos.flat(), itens);
    assert.equal(pedacos[pedacos.length - 1].length, 8243 % 500);
});

test('pedaço de tamanho zero é erro, não laço infinito', () => {
    assert.throws(() => partirEmPedacos([1, 2, 3], 0), /pelo menos 1/);
});
