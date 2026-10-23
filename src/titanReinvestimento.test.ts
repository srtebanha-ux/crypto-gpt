import test from 'node:test';
import assert from 'node:assert/strict';
import { autorizarUnwrapSnowball } from './titanReinvestimento';
test('reinvestimento so usa o lucro WETH, sem consumir saldo para fazer unwrap de poeira', () => {
    assert.equal(autorizarUnwrapSnowball(1_000n, 20_000n, 100n, 100n), true);
    assert.equal(autorizarUnwrapSnowball(300n, 20_000n, 100n, 100n), false);
    assert.equal(autorizarUnwrapSnowball(1_000n, 1_000n, 100n, 100n), false);
});
test('nunca ultrapassa teto diario e nunca executa com receita inexistente', () => {
    assert.equal(autorizarUnwrapSnowball(1_000n, 20_000n, 101n, 100n), false);
    assert.equal(autorizarUnwrapSnowball(0n, 20_000n, 100n, 100n), false);
});
