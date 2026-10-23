import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarTransporteRpc } from './cacarArbitragem';

test('limite de RPS e hora sequencia chamadas concorrentes sem tocar na rede', async () => {
    let ms = 1_000;
    const inicios: number[] = [];
    const sleeps: number[] = [];
    const t = montarTransporteRpc({
        rpc: 'https://exemplo.invalid',
        fetchar: async () => {
            inicios.push(ms);
            return { status: 200, text: async () => JSON.stringify({
                jsonrpc: '2.0', id: 1, result: '0x01',
            }) };
        },
        agora: () => ms,
        esperar: async (delay: number) => { sleeps.push(delay); ms += delay; },
        requisicoesPorSegundo: 2,
        requisicoesPorHora: 2,
        tentativas: 1,
    });
    const r = await Promise.all([
        t.chamar('eth_blockNumber', []),
        t.chamar('eth_blockNumber', []),
        t.chamar('eth_blockNumber', []),
    ]);
    assert.deepEqual(r, ['0x01', '0x01', '0x01']);
    assert.equal(inicios.length, 3);
    assert.ok(inicios[1]! - inicios[0]! >= 500);
    assert.ok(inicios[2]! - inicios[0]! >= 3_600_000);
    assert.ok(sleeps.some((x) => x > 3_500_000));
    assert.equal(t.contabilidade().requisicoes, 3);
});

test('teto HTTP por processo continua proibindo excedente', async () => {
    let total = 0;
    const t = montarTransporteRpc({
        rpc: 'https://exemplo.invalid',
        tetoDeRequisicoes: 1,
        tentativas: 1,
        fetchar: async () => {
            total += 1;
            return { status: 200, text: async () => JSON.stringify({
                jsonrpc: '2.0', id: 1, result: '0x01',
            }) };
        },
    });
    assert.equal(await t.chamar('eth_chainId', []), '0x01');
    await assert.rejects(t.chamar('eth_chainId', []), /teto de 1/);
    assert.equal(total, 1);
});
