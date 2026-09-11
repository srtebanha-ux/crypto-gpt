// Arquivo: src/ativacao.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDeAtivacao, estaAtivado } from './ativacao';

test('a chave é derivada do nome, em maiúsculas', () => {
    assert.equal(chaveDeAtivacao('live'), 'ATIVAR_LIVE');
    assert.equal(chaveDeAtivacao('smokeTestOrder'), 'ATIVAR_SMOKETESTORDER');
});

test('caracteres fora de A-Z0-9 viram sublinhado — nome de variável válido', () => {
    assert.equal(chaveDeAtivacao('dex-arb.sniffer'), 'ATIVAR_DEX_ARB_SNIFFER');
});

test('só o valor exato "1" liga', () => {
    assert.equal(estaAtivado('live', { ATIVAR_LIVE: '1' }), true);
    // "true", "sim" e "0" NÃO ligam: um ponto de entrada que manda ordem não
    // deve depender de adivinhar o que alguém quis dizer.
    assert.equal(estaAtivado('live', { ATIVAR_LIVE: 'true' }), false);
    assert.equal(estaAtivado('live', { ATIVAR_LIVE: 'sim' }), false);
    assert.equal(estaAtivado('live', { ATIVAR_LIVE: '0' }), false);
});

test('ausente é desligado — o padrão é não rodar', () => {
    assert.equal(estaAtivado('live', {}), false);
});
