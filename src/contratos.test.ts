import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { CACADORES, POOLS, cacadorDaRede, AVISO_ENDERECO_REPETIDO_NA_ARBITRUM } from './contratos';

test('todo endereco guardado e um endereco valido de verdade', () => {
    // getAddress reprova checksum errado, que e como um caractere trocado numa
    // copia manual aparece. Endereco invalido aqui viraria dinheiro perdido no
    // dia da cacada, e nao erro no dia de escrever.
    for (const c of CACADORES) {
        for (const campo of ['endereco', 'cofre', 'dono'] as const) {
            assert.equal(getAddress(c[campo]), c[campo], `${c.endereco}.${campo} com checksum errado`);
        }
    }
});

test('o cofre e o MESMO nos dois contratos — e nao e a conta_bot', () => {
    // O cofre e imutavel. Se um dos deploys tivesse recebido a conta_bot no
    // lugar, o lucro iria parar exatamente onde a chave mora — que e a unica
    // coisa que este desenho existe para impedir.
    const cofres = new Set(CACADORES.map((c) => c.cofre));
    assert.equal(cofres.size, 1);
    for (const c of CACADORES) assert.notEqual(c.cofre.toLowerCase(), c.dono.toLowerCase());
});

test('o cacador escolhido para caçar sabe vender em Aerodrome', () => {
    const c = cacadorDaRede('base');
    assert.ok(c);
    assert.equal(c.vendeEm, 'v2+solidly');
    assert.equal(c.endereco, '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78');
});

test('o contrato mais velho continua acessivel — nao foi apagado', () => {
    const soV2 = CACADORES.find((c) => c.vendeEm === 'v2');
    assert.ok(soV2, 'o caçador antigo tem de continuar guardado como saida');
    assert.equal(soV2.endereco, '0xb71249b14bdAEC2669341ed331cF1849c72F12d4');
});

test('rede sem cacador devolve null, nao o da Base por engano', () => {
    assert.equal(cacadorDaRede('ethereum'), null);
});

test('o aviso da Arbitrum aponta para o endereco que de fato se repete', () => {
    assert.equal(AVISO_ENDERECO_REPETIDO_NA_ARBITRUM, cacadorDaRede('base')!.endereco);
});

test('o pool da Aerodrome e mesmo o mais fundo — e por muito', () => {
    const vezes = POOLS.aerodrome.profundidadeUsd.dividedBy(POOLS.uniswapV2.profundidadeUsd);
    assert.ok(vezes.greaterThan(6), `esperava mais de 6x, deu ${vezes.toFixed(1)}x`);
    assert.equal(POOLS.aerodrome.familia, 'solidly');
});
