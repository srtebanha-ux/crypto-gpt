import test from 'node:test';
import assert from 'node:assert/strict';
import { decidirGasSnowball } from './titanGasSnowball';

const base = {
    saldoWei: 3_300_000_000_000_000n,
    gasLimit: 300_000n,
    baseFeeWei: 10_000_000n,
    prioridadeDesejadaWei: 1_000_000_000n,
    feeL1Wei: 2_000_000_000_000n,
    lucroBrutoWei: 1_000_000_000_000_000n,
    tetoPorTransacaoWei: 3_300_000_000_000_000n,
};
test('TITAN nao aceita gas com saldo zero', () => {
    assert.equal(decidirGasSnowball({ ...base, saldoWei: 0n }).aprovado, false);
});
test('TITAN preserva 30% do saldo e arrisca no maximo 20% por tentativa', () => {
    const d = decidirGasSnowball(base);
    assert.equal(d.aprovado, true);
    if (d.aprovado) {
        assert.equal(d.reservaWei, base.saldoWei * 3n / 10n);
        assert.ok(d.custoMaximoWei <= base.saldoWei / 5n);
        assert.ok(d.prioridadeWei <= base.prioridadeDesejadaWei);
    }
});
test('crescimento da carteira desbloqueia um teto de gas maior sem aporte', () => {
    const pequeno = decidirGasSnowball({ ...base, lucroBrutoWei: 100n * base.lucroBrutoWei });
    const grande = decidirGasSnowball({
        ...base, saldoWei: base.saldoWei * 10n,
        lucroBrutoWei: 100n * base.lucroBrutoWei,
    });
    assert.equal(pequeno.aprovado, true);
    assert.equal(grande.aprovado, true);
    if (pequeno.aprovado && grande.aprovado) {
        assert.ok(grande.tetoRiscoWei > pequeno.tetoRiscoWei);
    }
});
test('nem um premio gigante autoriza consumir toda a carteira', () => {
    const d = decidirGasSnowball({ ...base, lucroBrutoWei: 1_000_000n * base.lucroBrutoWei,
        prioridadeDesejadaWei: 100_000_000_000n });
    assert.equal(d.aprovado, true);
    if (d.aprovado) assert.ok(d.custoMaximoWei <= base.saldoWei / 5n);
});
test('lucro bruto abaixo do custo base nunca vira uma aposta', () => {
    const d = decidirGasSnowball({ ...base, lucroBrutoWei: 1n });
    assert.equal(d.aprovado, false);
});
test('sem margem para gorjeta, recusa em vez de enviar com prioridade negativa', () => {
    const d = decidirGasSnowball({ ...base, tetoPorTransacaoWei: 10_000n });
    assert.equal(d.aprovado, false);
});
test('parametros de risco invalidos falham fechados', () => {
    assert.throws(() => decidirGasSnowball({ ...base, reservaBps: 10_001n }));
    assert.throws(() => decidirGasSnowball({ ...base, riscoPorTentativaBps: -1n }));
});
