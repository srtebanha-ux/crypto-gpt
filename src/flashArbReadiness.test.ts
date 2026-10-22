import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticarFlashArb} from './flashArbReadiness';

const contrato='0x1111111111111111111111111111111111111111';
const segredo='EXAMPLE_SECRET_NEVER_PRINT';
const armado={
  FLASH_ARB_CONTRACT:contrato,
  FLASH_ARB_LIVE:'true',
  FLASH_ARB_CONFIRM:'I_UNDERSTAND_THE_RISK',
  FLASH_ARB_PRIVATE_KEY:segredo,
};

test('a scanner without contract never pretends to have a transaction path',()=>{
  const d=diagnosticarFlashArb({});
  assert.equal(d.modo,'scanner-sem-executor');
  assert.equal(d.preflightDisponivel,false);
  assert.equal(d.envioAutorizado,false);
  assert.match(d.bloqueios.join(' '),/FLASH_ARB_CONTRACT/);
});

test('deployed contract alone can only preflight, never broadcast',()=>{
  const d=diagnosticarFlashArb({FLASH_ARB_CONTRACT:contrato});
  assert.equal(d.modo,'ensaio-onchain');
  assert.equal(d.preflightDisponivel,true);
  assert.equal(d.envioAutorizado,false);
  assert.match(d.bloqueios.join(' '),/FLASH_ARB_LIVE/);
});

test('all four guards must be present for real execution',()=>{
  const d=diagnosticarFlashArb(armado);
  assert.equal(d.modo,'envio-real');
  assert.equal(d.envioAutorizado,true);
  assert.deepEqual(d.bloqueios,[]);
  for(const absent of ['FLASH_ARB_CONTRACT','FLASH_ARB_LIVE','FLASH_ARB_CONFIRM','FLASH_ARB_PRIVATE_KEY'] as const){
    const bad={...armado};
    delete bad[absent];
    const got=diagnosticarFlashArb(bad);
    assert.equal(got.envioAutorizado,false,absent);
    assert.ok(got.bloqueios.length>0,absent);
  }
});

test('diagnostic contains no private key, wallet address or confirmation values',()=>{
  const {FLASH_ARB_PRIVATE_KEY,...masked}=armado;
  const bad=diagnosticarFlashArb({...masked,FLASH_ARB_LIVE:'true',FLASH_ARB_PRIVATE_KEY:segredo});
  assert.equal(JSON.stringify(bad).includes(segredo),false);
  assert.equal(JSON.stringify(bad).includes(contrato),false);
});

test('live request with missing signing confirmation is explicitly blocked',()=>{
  const d=diagnosticarFlashArb({...armado,FLASH_ARB_CONFIRM:'no'});
  assert.equal(d.modo,'configuracao-bloqueada');
  assert.equal(d.envioAutorizado,false);
  assert.match(d.bloqueios.join(' '),/FLASH_ARB_CONFIRM/);
});
