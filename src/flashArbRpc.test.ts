import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ensaiarExecucao, lerSaldoDoContrato, lerDonoDoContrato, enviarExecucao } from './flashArbExecutor';

const contrato = '0x1111111111111111111111111111111111111111';
const dono = '0x2222222222222222222222222222222222222222';
const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

function rpc(t: TestContext, respostas: unknown[]) {
    const chamadas: { method: string; params: any[] }[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        chamadas.push(JSON.parse(String(init.body)));
        assert.ok(respostas.length, 'RPC inesperado');
        return new Response(JSON.stringify(respostas.shift()), { status: 200 });
    });
    return chamadas;
}

test('saldo desconhecido nunca vira zero; zero ABI e saldo existente são preservados', async t => {
    for (const resposta of [{ error: { message: 'unavailable' } }, {}, { result: '0x' }, { result: '0x01' }, { result: null }]) {
        rpc(t, [resposta]);
        await assert.rejects(lerSaldoDoContrato('https://rpc.invalid', dono, contrato), /Saldo.*não verificado/);
        t.mock.restoreAll();
    }
    rpc(t, [{ result: word(0n) }, { result: word(123456n) }]);
    assert.equal(await lerSaldoDoContrato('https://rpc.invalid', dono, contrato), 0n);
    assert.equal(await lerSaldoDoContrato('https://rpc.invalid', dono, contrato), 123456n);
});

test('owner é lido e usado como remetente do ensaio, não o contrato', async t => {
    const chamadas = rpc(t, [{ result: word(BigInt(dono)) }, { result: '0x6000' }, { result: '0x' }]);
    const owner = await lerDonoDoContrato('https://rpc.invalid', contrato);
    assert.equal(owner, dono);
    assert.deepEqual(await ensaiarExecucao('https://rpc.invalid', contrato, owner, '0xa7e42d50'), { ok: true });
    assert.equal(chamadas[2].params[0].from, dono);
    assert.equal(chamadas[2].params[0].to, contrato);
});

test('owner ausente, zero ou ABI inválida bloqueia a operação', async t => {
    for (const result of [undefined, '0x', word(0n), '0x' + 'f'.repeat(64)]) {
        rpc(t, [{ result }]);
        await assert.rejects(lerDonoDoContrato('https://rpc.invalid', contrato), /owner/);
        t.mock.restoreAll();
    }
});

test('endereço sem código não aprova eth_call vazio de EOA', async t => {
    const chamadas = rpc(t, [{ result: '0x' }]);
    assert.equal((await ensaiarExecucao('https://rpc.invalid', contrato, dono, '0x')).ok, false);
    assert.equal(chamadas.length, 1);
});

test('ensaio rejeita resposta ausente, inválida e revertida', async t => {
    for (const resposta of [{}, { result: null }, { result: '0x00' }, { error: { message: 'revert', data: '0xe7eb56ec' } }]) {
        rpc(t, [{ result: '0x6000' }, resposta]);
        assert.equal((await ensaiarExecucao('https://rpc.invalid', contrato, dono, '0x')).ok, false);
        t.mock.restoreAll();
    }
});

test('envio recusa carteira diferente do owner antes de broadcast', async t => {
    const chamadas = rpc(t, [{ result: word(BigInt(dono)) }]);
    await assert.rejects(enviarExecucao({
        rpcUrl: 'https://rpc.invalid', contrato, calldata: '0x',
        // Chave pública de teste determinística, sem fundos; nunca usada em rede.
        chavePrivada: '0x' + '01'.padStart(64, '0'),
    }), /não corresponde/);
    assert.equal(chamadas.length, 1);
    assert.ok(chamadas.every(c => c.method === 'eth_call'));
});

test('envio repete o ensaio e interrompe antes de transmitir quando ele reverte', async t => {
    const { Wallet } = await import('ethers');
    const chavePrivada = '0x' + '01'.padStart(64, '0');
    const carteira = new Wallet(chavePrivada);
    const chamadas = rpc(t, [
        { result: word(BigInt(carteira.address)) },
        { result: '0x6000' },
        { error: { message: 'reverted', data: '0x9612b7e0' + '0'.repeat(128) } },
    ]);
    const enviar = t.mock.method(Wallet.prototype, 'sendTransaction', async () => {
        assert.fail('broadcast não pode acontecer após ensaio reprovado');
    });
    await assert.rejects(enviarExecucao({ rpcUrl: 'https://rpc.invalid', contrato, calldata: '0xa7e42d50', chavePrivada }), /Envio recusado/);
    assert.equal(enviar.mock.callCount(), 0);
    assert.equal(chamadas[2].params[0].from, carteira.address);
});
