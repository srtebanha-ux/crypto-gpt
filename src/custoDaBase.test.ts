import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Interface, Transaction, Wallet} from 'ethers';
import {codificarGetL1Fee} from './custoDaBase';

const oracle = new Interface(['function getL1Fee(bytes) view returns (uint256)']);
const pedido = {
    type: 2, chainId: 8453, nonce: 7,
    to: '0x1111111111111111111111111111111111111111',
    data: '0x12345678', value: 0n, gasLimit: 300000n,
    maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 20000000n,
};

test('estimativa L1 recebe envelope completo não assinado, incluindo taxas e nonce', () => {
    const unsigned = Transaction.from(pedido).unsignedSerialized;
    const [bytes] = oracle.decodeFunctionData('getL1Fee', codificarGetL1Fee(unsigned));
    assert.equal(bytes, unsigned);
    const decoded = Transaction.from(bytes);
    assert.equal(decoded.nonce, 7);
    assert.equal(decoded.chainId, 8453n);
    assert.equal(decoded.gasLimit, 300000n);
    assert.equal(decoded.data, '0x12345678');
    assert.equal(decoded.signature, null);
    assert.notEqual(bytes, pedido.data);
});

test('estimativa L1 rejeita envelope assinado para não contar assinatura duas vezes', async () => {
    // Chave determinística de teste, sem qualquer conexão a RPC.
    const wallet = new Wallet('0x' + '01'.padStart(64, '0'));
    const signed = await wallet.signTransaction(pedido);
    assert.throws(() => codificarGetL1Fee(signed), /sem assinatura/);
});

test('calldata e bytes fictícios não passam por transação serializada', () => {
    for (const invalid of ['0x', pedido.data, '0x' + '02'.repeat(200), '0xzz']) {
        assert.throws(() => codificarGetL1Fee(invalid));
    }
});
