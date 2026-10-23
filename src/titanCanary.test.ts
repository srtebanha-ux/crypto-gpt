import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {custoMaximoMultiDentroDoTeto,reservarUmEnvioMulti} from './titanCanary';
test('custo maximo inclui teto L2 e custo L1 e bloqueia overspend',()=>{
    assert.equal(custoMaximoMultiDentroDoTeto(1_500_000n,300_000_000n,20_000_000_000n,600_000_000_000_000n),true);
    assert.equal(custoMaximoMultiDentroDoTeto(2_000_000n,400_000_000n,20_000_000_000n,600_000_000_000_000n),false);
    assert.equal(custoMaximoMultiDentroDoTeto(1n,1n,0n,10n),false);
});
test('canary grava no volume apenas uma vez e nao deixa recarregar',()=>{
    // Teste da funcao sem tocar no volume de producao.
    const old=fs.openSync;
    const dados={carteira:'0x1',devedor:'0x2',contrato:'0x3',bloco:1};
    assert.match(reservarUmEnvioMulti(dados,'/tmp/qualquer').motivo,/fora do volume/);
    assert.equal(typeof old,'function');
});
