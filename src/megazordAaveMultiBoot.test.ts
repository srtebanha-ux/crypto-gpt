import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,Wallet} from 'ethers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {confirmarMultiHopAave,habilitarAaveMultiHopMegazord,prepararAaveMultiHopMegazord,
 type MultiBootLeitor} from './megazordAaveMultiBoot';
import {ABI_MULTI,FABRICA_V3_BASE,MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {COFRE_ESPERADO} from './caca';
import {REDES} from './liquidacoes';
const owner='0x'+'11'.repeat(20),contract='0x'+'22'.repeat(20);
function fixture(override:Record<string,string>={}):MultiBootLeitor{
 const data:Record<string,string>={
   dono:owner,cofre:COFRE_ESPERADO,aave:REDES.base.pool,
   morpho:MORPHO_FLASH_BASE,fabricaV3:FABRICA_V3_BASE,...override,
 };
 return {
  getNetwork:async()=>({chainId:8453n}),
  getCode:async()=>('0x6000'),
  call:async(req)=>{
    const method=ABI_MULTI.parseTransaction({data:req.data})!.name;
    return ABI_MULTI.encodeFunctionResult(method,[data[method]]);
  },
 };
}
test('Aave multi-hop only authorized after immutable owner+protocol verification',async()=>{
 const e:NodeJS.ProcessEnv={CACA_MULTIHOP_AVALIAR:'1',CACA_MULTIHOP_CONTRATO:contract,
  MEGAZORD_RPC_URL:'rpc-fixture',MEGAZORD_ENDERECO_PUBLICO:owner};
 assert.equal(await confirmarMultiHopAave(e,()=>fixture()),contract);
 assert.equal(e.CACA_ENVIAR,undefined);
 const live:NodeJS.ProcessEnv={...e,MEGAZORD_MODO:'execucao',
   MEGAZORD_CONFIRMAR:'OPERAR_BASE_REAL',MEGAZORD_EXCLUSIVO:'1'};
 habilitarAaveMultiHopMegazord(live,contract);
 assert.equal(live.CACA_ENVIAR,'1');
 assert.equal(live.CACA_SOMENTE_MULTIHOP,'1');
 assert.equal(live.CACA_MULTIHOP_ENVIAR,'1');
 assert.equal(live.CACA_MULTIHOP_CANARY_UM_TIRO,'1');
});
test('missing Aave executor leaves route disarmed and wrong immutable aborts',async()=>{
 const env={CACA_MULTIHOP_AVALIAR:'1',MEGAZORD_RPC_URL:'rpc-fixture',
  MEGAZORD_ENDERECO_PUBLICO:owner};
 assert.equal(await confirmarMultiHopAave(env,()=>fixture()),null);
 await assert.rejects(confirmarMultiHopAave({...env,CACA_MULTIHOP_CONTRATO:contract},
   ()=>fixture({dono:'0x'+'33'.repeat(20)})),/dono divergente/);
 assert.throws(()=>habilitarAaveMultiHopMegazord(env,contract),/sem preflight/);
});

test('Aave boot installs once and reuses the durable contract cache after restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-boot-test-'));
 const key='0x'+'11'.repeat(32),wallet=new Wallet(key).address;
 let paid=0;
 const deps={
   verificar:async(e:NodeJS.ProcessEnv)=>e.CACA_MULTIHOP_CONTRATO??null,
   implantar:async(e:NodeJS.ProcessEnv)=>{
     paid++;
     assert.equal(e.CACA_CHAVE_PRIVADA,key);
     assert.equal(e.TITAN_MULTI_DEPLOY_TETO_WEI,'100000000000000');
     return contract;
   },
 };
 const original:NodeJS.ProcessEnv={
   MEGAZORD_CHAVE_PRIVADA:key,MEGAZORD_ENDERECO_PUBLICO:wallet,
   MEGAZORD_DIARIO:path.join(dir,'megazord.json'),
   MEGAZORD_RPC_URL:'https://rpc.invalid',MEGAZORD_EXCLUSIVO:'1',
   MEGAZORD_AUTO_DEPLOY:'1',TITAN_MULTI_DEPLOY_TETO_WEI:'100000000000000',
   CACA_MULTIHOP_AVALIAR:'1',
 };
 try {
   assert.equal(await prepararAaveMultiHopMegazord(original,deps),contract);
   assert.equal(paid,1);
   assert.equal(fs.existsSync(original.MEGAZORD_DIARIO+'.aave-multihop.json'),true);
   const restart:NodeJS.ProcessEnv={...original,
     CACA_MULTIHOP_CONTRATO:undefined,MEGAZORD_AUTO_DEPLOY:undefined};
   assert.equal(await prepararAaveMultiHopMegazord(restart,deps),contract);
   assert.equal(paid,1,'paid deploy must not repeat');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Aave pending deployment marker blocks automatic repeat even without cache',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-pending-'));
 const key='0x'+'11'.repeat(32),wallet=new Wallet(key).address;
 const marker=path.join(dir,'pending.json');
 try{
   fs.writeFileSync(marker,JSON.stringify({estado:'enviado',
     hash:'0x'+'aa'.repeat(32)}));
   let sends=0;
   await assert.rejects(prepararAaveMultiHopMegazord({
     MEGAZORD_CHAVE_PRIVADA:key,MEGAZORD_ENDERECO_PUBLICO:wallet,
     MEGAZORD_DIARIO:path.join(dir,'nonce.json'),
     MEGAZORD_RPC_URL:'https://rpc.invalid',MEGAZORD_EXCLUSIVO:'1',
     CACA_MULTIHOP_AVALIAR:'1',MEGAZORD_AUTO_DEPLOY:'1',
     TITAN_MULTI_DEPLOY_MARCADOR:marker,TITAN_MULTI_DEPLOY_TETO_WEI:'100000000000000',
   },{
     verificar:async()=>contract,
     implantar:async()=>{sends++;return contract;},
   }),/deploy anterior incerto/);
   assert.equal(sends,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Aave missing deployment cap fails closed without paid broadcasts',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-no-cap-'));
 const key='0x'+'11'.repeat(32),wallet=new Wallet(key).address;
 try{
   await assert.rejects(prepararAaveMultiHopMegazord({
     MEGAZORD_CHAVE_PRIVADA:key,MEGAZORD_ENDERECO_PUBLICO:wallet,
     MEGAZORD_DIARIO:path.join(dir,'nonce.json'),MEGAZORD_RPC_URL:'rpc',
     MEGAZORD_EXCLUSIVO:'1',MEGAZORD_AUTO_DEPLOY:'1',CACA_MULTIHOP_AVALIAR:'1',
   },{implantar:async()=>{throw Error('NEVER SEND');},
      verificar:async()=>contract}),/teto dedicado/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
