import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {codigoFlashArbComDono,correspondeFlashArb,pisoConservadorV2,WETH_BASE} from './titanV2Prova';
const owner='0x1111111111111111111111111111111111111111';
test('FlashArb immutable owner is patched by exact 32-byte solc metadata',()=>{
 const runtime='0x'+'00'.repeat(150);
 const patched=codigoFlashArbComDono({runtime,creation:'0x',
   ownerReferences:[{start:40,length:32}]},owner);
 assert.equal(patched.length,runtime.length);
 assert.equal(patched.slice(2+40*2,2+72*2),
   '000000000000000000000000'+owner.slice(2));
 assert.throws(()=>codigoFlashArbComDono({runtime,creation:'0x',
   ownerReferences:[{start:140,length:32}]},owner),/invalido/);
});
test('FlashArb preflight includes L2 max fee, L1 doubled and margin',()=>{
 const x=pisoConservadorV2(250000n,650000n,30000000n,20000000n,
  100000000000n,650000000000000n,{TITAN_LUCRO_GAS_BPS:'500'});
 assert.equal(x.gasLimite,300000n);
 assert.equal(x.custo,24200000000000n);
 assert.equal(x.piso,25410000000000n);
 assert.throws(()=>pisoConservadorV2(600000n,650000n,30000000n,
  20000000n,100000000000n,650000000000000n,
  {TITAN_LUCRO_GAS_BPS:'500'}),/teto/);
 assert.equal(WETH_BASE,'0x4200000000000000000000000000000000000006');
});
test('build artifact FlashArb has full EVM runtime and owner immutable offsets',()=>{
 const artifact='.tmp/artifacts/FlashArbProva.json';
 if(!fs.existsSync(artifact))return;
 const x=JSON.parse(fs.readFileSync(artifact,'utf8'));
 assert.ok(x.runtime.startsWith('0x'));
 assert.ok(x.creation.startsWith('0x'));
 assert.ok(x.ownerReferences.length>0);
 const c=codigoFlashArbComDono(x,owner);
 assert.equal(c.length,x.runtime.length);
});

test('accept known FlashArb executable code with different Solidity CBOR metadata',()=>{
 const executable='00'.repeat(150);
 const metadataA='a164736f6c634300081a';
 const metadataB='a164736f6c634300081b';
 const a={runtime:'0x'+executable+metadataA+'000a',
   creation:'0x',ownerReferences:[{start:40,length:32}]};
 const onchain=codigoFlashArbComDono(a,owner).slice(0,-metadataA.length-4)
   +metadataB+'000a';
 assert.equal(correspondeFlashArb(onchain,a,owner),true);
 const changed='0x01'+onchain.slice(4);
 assert.equal(correspondeFlashArb(changed,a,owner),false);
});
test('multiple known optimizer variants are accepted without weakening opcode match',()=>{
 const x={runtime:'0x'+'00'.repeat(150),creation:'0x',
   ownerReferences:[{start:40,length:32}]};
 const y={runtime:'0x'+'01'.repeat(150),creation:'0x',
   ownerReferences:[{start:40,length:32}]};
 const onchain=codigoFlashArbComDono(y,owner);
 assert.equal(correspondeFlashArb(onchain,{...x,variantes:[y]},owner),true);
 assert.equal(correspondeFlashArb(onchain,x,owner),false);
});
