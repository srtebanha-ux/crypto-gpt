import test from 'node:test';
import assert from 'node:assert/strict';
import {Wallet} from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepararMorphoMegazord,type DependenciasMorphoBoot} from './megazordMorphoBoot';
import {checarBytecodeAero} from './megazordAeroRuntimeAudit';

const key='0x'+'11'.repeat(32);
const owner=new Wallet(key).address;
const v3='0x'+'22'.repeat(20);
const aero='0x'+'33'.repeat(20);
function env():NodeJS.ProcessEnv{
 return {MEGAZORD_CHAVE_PRIVADA:key,MEGAZORD_ENDERECO_PUBLICO:owner,
   MEGAZORD_RPC_URL:'https://rpc.invalid',
   MEGAZORD_EXCLUSIVO:'1',MEGAZORD_MORPHO_ROTAS:'v3,aero',MEGAZORD_CONTRATOS:'0x'+'44'.repeat(20)};
}
function mocked(seen:string[]):DependenciasMorphoBoot{
 return {
   verificar:async(tipo,at,who,rpc)=>{seen.push('check:'+tipo);
     assert.equal(who,owner);assert.equal(rpc,'https://rpc.invalid');
     assert.equal(at.toLowerCase(),(tipo==='v3'?v3:aero).toLowerCase());},
   implantar:async(tipo,config)=>{seen.push('deploy:'+tipo);
     assert.equal(config.TITAN_CHAVE_PRIVADA,key);
     assert.equal(config.TITAN_NONCE_EXCLUSIVO,'1');
     return tipo==='v3'?v3:aero;},
   recuperar:()=>undefined,
 };
}
test('existing deployed contract addresses validated and whitelisted without paid deploy',async()=>{
 const e:NodeJS.ProcessEnv={...env(),CACA_MORPHO_V3_CONTRATO:v3,CACA_MORPHO_AERO_CONTRATO:aero};
 const seen:string[]=[];
 const result=await prepararMorphoMegazord(e,mocked(seen));
 assert.deepEqual(seen,['check:v3','check:aero']);
 assert.equal(result.novos,0);
 assert.ok(e.MEGAZORD_CONTRATOS?.includes(v3));
 assert.ok(e.MEGAZORD_CONTRATOS?.includes(aero));
});
test('missing executors without explicit deployment authorization fail closed',async()=>{
 const e=env();const seen:string[]=[];
 await assert.rejects(prepararMorphoMegazord(e,mocked(seen)),/auto-deploy nao autorizado/);
 assert.deepEqual(seen,[]);assert.equal(e.CACA_MORPHO_V3_CONTRATO,undefined);
});
test('invalid second deployment cap cannot spend on the first contract',async()=>{
 const e={...env(),MEGAZORD_AUTO_DEPLOY:'1',TITAN_MORPHO_V3_DEPLOY_WEI:'1000',
   TITAN_MORPHO_AERO_DEPLOY_WEI:'0'};
 const seen:string[]=[];
 await assert.rejects(prepararMorphoMegazord(e,mocked(seen)),/limite de gas.*aero/);
 assert.deepEqual(seen,[]);
});
test('incompatible existing second executor is rejected before deploying the missing first',async()=>{
 const e={...env(),MEGAZORD_AUTO_DEPLOY:'1',TITAN_MORPHO_V3_DEPLOY_WEI:'1000',
   CACA_MORPHO_AERO_CONTRATO:aero};
 const seen:string[]=[];const deps=mocked(seen);
 deps.verificar=async()=>{seen.push('check:aero');throw Error('old executor version');};
 await assert.rejects(prepararMorphoMegazord(e,deps),/old executor version/);
 assert.deepEqual(seen,['check:aero']);
});
test('authorized one-time deploys require an independent positive gas cap per contract',async()=>{
 const e:NodeJS.ProcessEnv={...env(),MEGAZORD_AUTO_DEPLOY:'1',
  TITAN_MORPHO_V3_DEPLOY_WEI:'100000000000000',
  TITAN_MORPHO_AERO_DEPLOY_WEI:'100000000000000'};
 const seen:string[]=[];
 const result=await prepararMorphoMegazord(e,mocked(seen));
 assert.equal(result.novos,2);
 assert.deepEqual(seen,['deploy:v3','check:v3','deploy:aero','check:aero']);
 assert.equal(e.CACA_MORPHO_V3_CONTRATO,v3);
 assert.equal(e.CACA_MORPHO_AERO_CONTRATO,aero);
});
test('never auto-deploy when a second signer is declared active',async()=>{
 const e:NodeJS.ProcessEnv={...env(),MEGAZORD_AUTO_DEPLOY:'1',CACA_ENVIAR:'1'};
 await assert.rejects(prepararMorphoMegazord(e,mocked([])),/CACA_ENVIAR/);
});
test('invalid cap or failed immutable validation does not enable partial runtime state',async()=>{
 const e={...env(),MEGAZORD_AUTO_DEPLOY:'1',
  TITAN_MORPHO_V3_DEPLOY_WEI:'2500000000000000'};
 await assert.rejects(prepararMorphoMegazord(e,mocked([])),/limite de gas/);
 const e2:NodeJS.ProcessEnv={...env(),CACA_MORPHO_V3_CONTRATO:v3,CACA_MORPHO_AERO_CONTRATO:aero};
 const deps=mocked([]);
 deps.verificar=async tipo=>{if(tipo==='aero')throw Error('immutable mismatch');};
 await assert.rejects(prepararMorphoMegazord(e2,deps),/immutable mismatch/);
 assert.equal(e2.MEGAZORD_CONTRATOS,env().MEGAZORD_CONTRATOS);
});
test('cannot silently switch to a different private wallet',async()=>{
 const e={...env(),MEGAZORD_ENDERECO_PUBLICO:'0x'+'55'.repeat(20)};
 await assert.rejects(prepararMorphoMegazord(e,mocked([])),/carteira diverge/);
});

test('restart reads addresses atomically from diary cache without a second paid deployment',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'megazord-contracts-'));
 try{
  const journal=path.join(dir,'megazord.json');
  const first:NodeJS.ProcessEnv={...env(),MEGAZORD_DIARIO:journal,
    MEGAZORD_AUTO_DEPLOY:'1',
    TITAN_MORPHO_V3_DEPLOY_WEI:'100000000000000',
    TITAN_MORPHO_AERO_DEPLOY_WEI:'100000000000000'};
  const calls1:string[]=[];
  await prepararMorphoMegazord(first,mocked(calls1));
  assert.deepEqual(calls1,['deploy:v3','check:v3','deploy:aero','check:aero']);
  assert.equal(fs.existsSync(journal+'.contratos.json'),true);
  const second:NodeJS.ProcessEnv={...env(),MEGAZORD_DIARIO:journal};
  const calls2:string[]=[];
  const resumed=await prepararMorphoMegazord(second,mocked(calls2));
  assert.equal(resumed.novos,0);
  assert.deepEqual(calls2,['check:v3','check:aero']);
  assert.equal(second.CACA_MORPHO_V3_CONTRATO,v3);
  assert.equal(second.CACA_MORPHO_AERO_CONTRATO,aero);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('V3 selecionado nao exige nem implanta Aero ausente',async()=>{
 const e={...env(),MEGAZORD_MORPHO_ROTAS:'v3',CACA_MORPHO_V3_CONTRATO:v3};
 const seen:string[]=[];const r=await prepararMorphoMegazord(e,mocked(seen));
 assert.deepEqual(seen,['check:v3']);assert.equal(r.v3,v3);assert.equal(r.aero,'');
 assert.equal(r.novos,0);
 await assert.rejects(prepararMorphoMegazord({...e,MEGAZORD_MORPHO_ROTAS:'typo'},mocked([])),/ROTAS/);
});

test('explicit CPAMM-only boot needs verified V2, never deploys or arms Morpho',async()=>{
 const e:NodeJS.ProcessEnv={...env(),
  MEGAZORD_MORPHO_ROTAS:'none',TITAN_CPAMM_ATOMICO:'1',
  TITAN_V2_CONTRATO:'0x'+'44'.repeat(20),
  FLASH_ARB_CODEHASH:'0x'+'66'.repeat(32),FLASH_ARB_CPAMM_FACTORIES:'[]',
  CACA_MORPHO_V3_CONTRATO:v3,CACA_MORPHO_AERO_CONTRATO:aero};
 const called:string[]=[];
 const result=await prepararMorphoMegazord(e,mocked(called));
 assert.deepEqual(called,[]);
 assert.deepEqual(result,{v3:'',aero:'',novos:0});
 assert.equal(e.CACA_MORPHO_V3_CONTRATO,'');
 assert.equal(e.CACA_MORPHO_AERO_CONTRATO,'');
 assert.equal(e.MEGAZORD_CONTRATOS,'0x'+'44'.repeat(20));
});

test('CPAMM-only cannot bypass empty allowlist, V2 identity, or paid deploy restriction',async()=>{
 const base:NodeJS.ProcessEnv={...env(),MEGAZORD_MORPHO_ROTAS:'none',TITAN_CPAMM_ATOMICO:'1',
  TITAN_V2_CONTRATO:'0x'+'44'.repeat(20),FLASH_ARB_CODEHASH:'0x'+'66'.repeat(32),
  FLASH_ARB_CPAMM_FACTORIES:'[]'};
 const variants=[
  {...base,TITAN_CPAMM_ATOMICO:'0'},
  {...base,TITAN_V2_CONTRATO:undefined},
  {...base,MEGAZORD_CONTRATOS:''},
  {...base,FLASH_ARB_CODEHASH:undefined},
  {...base,FLASH_ARB_CPAMM_FACTORIES:undefined},
  {...base,MEGAZORD_AUTO_DEPLOY:'1'},
 ];
 for(const e of variants)
  await assert.rejects(prepararMorphoMegazord(e,mocked([])),/Morpho none exige CPAMM atomico/);
 await assert.rejects(prepararMorphoMegazord({...base,MEGAZORD_MORPHO_ROTAS:'none,v3'},mocked([])),/ROTAS/);
});

test('default liquidation boot selects only Morpho V3 without requiring Aerodrome',async()=>{
 const e:NodeJS.ProcessEnv={...env(),MEGAZORD_MORPHO_ROTAS:undefined,
  CACA_MORPHO_V3_CONTRATO:v3};
 const seen:string[]=[];
 const prepared=await prepararMorphoMegazord(e,mocked(seen));
 assert.deepEqual(seen,['check:v3']);
 assert.deepEqual(prepared,{v3,aero:'',novos:0});
 assert.equal(e.CACA_MORPHO_V3_CONTRATO,v3);
 assert.equal(e.CACA_MORPHO_AERO_CONTRATO,'');
 assert.ok(e.MEGAZORD_CONTRATOS?.includes(v3));
});
test('default V3 still fails closed if onchain V3 executor is missing',async()=>{
 const e={...env(),MEGAZORD_MORPHO_ROTAS:undefined};
 const seen:string[]=[];
 await assert.rejects(prepararMorphoMegazord(e,mocked(seen)),/executor Morpho v3 ausente/);
 assert.deepEqual(seen,[]);
});

test('Aero runtime manifest accepts only compiler-declared immutable address slots',()=>{
 const owner='0x'+'11'.repeat(20);
 const vault='0x'+'22'.repeat(20);
 const morpho='0x'+'33'.repeat(20);
 const router='0x'+'44'.repeat(20);
 const factory='0x'+'55'.repeat(20);
 const expected=[owner,vault,morpho,router,factory];
 const offsets=[8,44,80,116,152];
 const bytes=Buffer.alloc(204,0x65);
 for(const offset of offsets)bytes.fill(0,offset,offset+32);
 const live=Buffer.from(bytes);
 offsets.forEach((offset,i)=>{
   Buffer.from(expected[i]!.slice(2).padStart(64,'0'),'hex').copy(live,offset);
 });
 const manifest={version:'0.8.26',runtime:'0x'+bytes.toString('hex'),
   immutableReferences:Object.fromEntries(offsets.map((offset,i)=>[
     String(i),[{start:offset,length:32}]]))};
 assert.equal(checarBytecodeAero('0x'+live.toString('hex'),manifest,expected).ok,true);
 live[7]=0x44; // unauthorized non-immutable opcode difference
 assert.equal(checarBytecodeAero('0x'+live.toString('hex'),manifest,expected).ok,false);
 live[7]=0x65;
 live[39]=0x44; // unauthorized immutable value
 assert.equal(checarBytecodeAero('0x'+live.toString('hex'),manifest,expected).ok,false);
 assert.equal(checarBytecodeAero('0x'+bytes.toString('hex'),
   {...manifest,version:'0.8.25'},expected).ok,false);
});
