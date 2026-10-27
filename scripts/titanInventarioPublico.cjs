// Run once INSIDE each existing Railway service. No network calls or file writes.
// Output is deliberately limited to public configuration; never export the env.
const fs=require('node:fs');
const {Wallet}=require('ethers');
const names=['RAILWAY_SERVICE_ID','RAILWAY_SERVICE_NAME','RAILWAY_DEPLOYMENT_ID',
 'RAILWAY_VOLUME_ID','RAILWAY_VOLUME_MOUNT_PATH','APP_ENTRY','MEGAZORD_MODO',
 'MEGAZORD_ENDERECO_PUBLICO','CACA_ENDERECO_PUBLICO','TITAN_ENDERECO_PUBLICO',
 'CACA_MORPHO_V3_CONTRATO','CACA_MORPHO_V3_CODEHASH','CACA_MORPHO_V3_AVALIAR',
 'CACA_MORPHO_AERO_CONTRATO','CACA_MORPHO_AERO_CODEHASH','MEGAZORD_MORPHO_ROTAS',
 'TITAN_V2_CONTRATO','FLASH_ARB_CODEHASH','MEGAZORD_CONTRATOS','MEGAZORD_DIARIO',
 'MEGAZORD_MAX_TX_DIA','MEGAZORD_GAS_MAX_DIA_WEI','MEGAZORD_GAS_MAX_TX_WEI',
 'MEGAZORD_CANARIO_ATE_UTC','MEGAZORD_AUTO_DEPLOY','MEGAZORD_EXCLUSIVO',
 'CACA_ENVIAR','CACA_MORPHO_V3_ENVIAR','CACA_MORPHO_AERO_ENVIAR','TITAN_ENVIAR','TITAN_V2_ENVIAR'];
const config=Object.fromEntries(names.map(k=>[k,process.env[k]??null]));
const identities={};
for(const name of ['MEGAZORD_CHAVE_PRIVADA','CACA_CHAVE_PRIVADA','TITAN_CHAVE_PRIVADA']){
 const key=process.env[name];if(!key)continue;
 try{identities[name]=new Wallet('0x'+key.trim().replace(/^0x/i,'')).address;}
 catch{identities[name]='credencial invalida';}
}
const rpcs={};
for(const name of ['MEGAZORD_RPC_URL','MEGAZORD_RPC_SECUNDARIO','CACA_RPC_URL','ARB_RPC_URL','TITAN_EXECUTOR_RPC_URL']){
 try{rpcs[name]=process.env[name]?{configurado:true,host:new URL(process.env[name]).hostname}:null;}
 catch{rpcs[name]={configurado:true,urlInvalida:true};}
}
function publicJson(file){
 try{
  const j=JSON.parse(fs.readFileSync(file,'utf8'));
  return {file,status:j.status??null,contract:j.contract??null,hash:j.hash??null,nonce:j.nonce??null,
   owner:j.owner??j.address??null,v3:j.v3??null,aero:j.aero??null,
   pending:j.pending?{hash:j.pending.hash,nonce:j.pending.nonce}:null,
   attempts:j.days?Object.values(j.days).reduce((n,d)=>n+Number(d.attempts??0),0):null};
 }catch(e){return {file,estado:e.code==='ENOENT'?'arquivo ausente':'ilegivel'};}
}
const files=['/app/data/titanMorphoV3Deploy.json','/app/data/titanMorphoAeroDeploy.json'];
const diary=process.env.MEGAZORD_DIARIO;
if(diary?.startsWith('/app/data/')&&!diary.includes('..')&&diary.endsWith('.json'))
 files.push(diary,diary+'.contratos.json');
let mounted=false;
try{mounted=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').some(l=>l.split(' ')[4]==='/app/data');}catch{}
console.log(JSON.stringify({somenteLeitura:true,config,identidadesPublicasDerivadas:identities,
 rpcs,volumeMontadoEmAppData:mounted,arquivos:files.map(publicJson),
 limite:'Inventario deste processo; repetir em todos os servicos. Ausencia de marcador nao prova ausencia onchain.'},null,2));
