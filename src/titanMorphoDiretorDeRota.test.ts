import test from 'node:test';
import assert from 'node:assert/strict';
import {deveTentarSaidaAero} from './titanMorphoDiretorDeRota';

const aero={CACA_MORPHO_AERO_CONTRATO:'0x1111111111111111111111111111111111111111'};
const motivo='executor V3, carteira ou identificacao publica indisponivel';

test('Aerodrome-only deployment is not starved by absent V3 executor',()=>{
  assert.equal(deveTentarSaidaAero({status:'descartada',motivo},aero),true);
});

test('no fallback without Aerodrome executor or for unrelated V3 skips',()=>{
  assert.equal(deveTentarSaidaAero({status:'descartada',motivo},{}),false);
  assert.equal(deveTentarSaidaAero({status:'descartada',motivo:'cooldown de posicao ja analisada'},aero),false);
  assert.equal(deveTentarSaidaAero({status:'descartada',motivo},{...aero,CACA_MORPHO_V3_CONTRATO:'0x2222222222222222222222222222222222222222'}),false);
});

test('V3 no-send failure may fall back to Aerodrome; sent/unknown never do',()=>{
  assert.equal(deveTentarSaidaAero({status:'inviavel',motivo:'sem pool V3 comprovada'},aero),true);
  for(const status of ['enviada','confirmada','desconhecida','revertida','aprovada-simulada'] as const)
    assert.equal(deveTentarSaidaAero({status,motivo},aero),false);
});
