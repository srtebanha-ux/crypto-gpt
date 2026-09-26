import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder } from 'ethers';
import {
    CHAMADAS_POR_MULTICALL,
    MULTICALL3,
    SELETOR_AGGREGATE3,
    codificarAggregate3,
    decodificarAggregate3,
    decodificarAggregate3Rapido,
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
    // Os números vêm da constante, não escritos à mão. A primeira versão
    // tinha "17" e "8243 % 500" fixos, e quebrou assim que o tamanho do
    // pedaço mudou de 500 para 250 — um teste que testava a constante em vez
    // do comportamento.
    const itens = Array.from({ length: 8243 }, (_, i) => i);
    const pedacos = partirEmPedacos(itens, CHAMADAS_POR_MULTICALL);
    assert.equal(pedacos.length, Math.ceil(8243 / CHAMADAS_POR_MULTICALL));
    assert.deepEqual(pedacos.flat(), itens);
    assert.equal(pedacos[pedacos.length - 1].length, 8243 % CHAMADAS_POR_MULTICALL);
    for (const p of pedacos.slice(0, -1)) assert.equal(p.length, CHAMADAS_POR_MULTICALL);
});

test('pedaço de tamanho zero é erro, não laço infinito', () => {
    assert.throws(() => partirEmPedacos([1, 2, 3], 0), /pelo menos 1/);
});

test('o pedaço padrão caiu de 500 para 250, e a conta continua fechando', () => {
    // 500 fazia o provedor da Base recusar por excesso, e 742 de 8.242
    // endereços ficavam sem olhar a cada ronda — 9%, logo abaixo do alarme de
    // 10%, com o vigia calado.
    assert.ok(CHAMADAS_POR_MULTICALL <= 250, `pedaço grande demais: ${CHAMADAS_POR_MULTICALL}`);
    const pedacos = partirEmPedacos(Array.from({ length: 8242 }, (_, i) => i));
    assert.equal(pedacos.flat().length, 8242, 'ninguém pode se perder na divisão');
    // Ainda rápido: dezenas de chamadas, não milhares.
    assert.ok(pedacos.length < 50, `${pedacos.length} chamadas é demais`);
});

test('o decodificador rápido concorda com o do ethers, item a item', () => {
    // Um decodificador rápido que discorda do lento não é rápido, é errado —
    // e erraria em silêncio, devolvendo a saúde de uma pessoa no lugar da de
    // outra. Este teste é a única coisa que autoriza usar o rápido.
    const casos: Array<Array<{ ok: boolean; dados: string }>> = [
        [],
        [{ ok: true, dados: '0x' }],
        [{ ok: false, dados: '0xdeadbeef' }],
        [
            { ok: true, dados: '0x' + '11'.repeat(32) },
            { ok: false, dados: '0x' },
            { ok: true, dados: '0x' + 'ab'.repeat(96) },
            { ok: true, dados: '0x' + 'cd'.repeat(7) },
        ],
    ];
    for (const caso of casos) {
        const bruto = AbiCoder.defaultAbiCoder().encode(
            ['tuple(bool,bytes)[]'],
            [caso.map((c) => [c.ok, c.dados])],
        );
        assert.deepEqual(decodificarAggregate3Rapido(bruto), decodificarAggregate3(bruto));
        assert.deepEqual(decodificarAggregate3Rapido(bruto), caso);
    }
});

test('o rápido aguenta uma resposta do tamanho que a varredura usa', () => {
    const muitos = Array.from({ length: 250 }, (_, i) => ({
        ok: i % 7 !== 0,
        dados: '0x' + i.toString(16).padStart(64, '0'),
    }));
    const bruto = AbiCoder.defaultAbiCoder().encode(
        ['tuple(bool,bytes)[]'],
        [muitos.map((c) => [c.ok, c.dados])],
    );
    assert.deepEqual(decodificarAggregate3Rapido(bruto), muitos);
});
