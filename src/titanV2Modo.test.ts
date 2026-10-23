import test from 'node:test';
import assert from 'node:assert/strict';
import { politicaDeSondaV2 } from './titanV2Modo';

test('V2 nao prova nem envia por padrao', () => {
    assert.deepEqual(politicaDeSondaV2({}), {
        habilitada: false, ativadaPorEnvio: false, envioSolicitado: false,
    });
});
test('V2 sonda explicita e somente leitura', () => {
    assert.deepEqual(politicaDeSondaV2({TITAN_V2_SONDA:'1'}), {
        habilitada: true, ativadaPorEnvio: false, envioSolicitado: false,
    });
});
test('pedido de envio nunca pula a sonda atomica', () => {
    assert.deepEqual(politicaDeSondaV2({TITAN_V2_ENVIAR:'1',TITAN_V2_SONDA:'0'}), {
        habilitada: true, ativadaPorEnvio: true, envioSolicitado: true,
    });
});
test('V2 envio e sonda habilitados nao exigem segunda prova', () => {
    assert.deepEqual(politicaDeSondaV2({TITAN_V2_ENVIAR:'1',TITAN_V2_SONDA:'1'}), {
        habilitada: true, ativadaPorEnvio: false, envioSolicitado: true,
    });
});
