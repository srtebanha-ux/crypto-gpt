/** Fail-safe, read-only report of runtime persistence. Never print file bodies, private
 * keys, provider URLs, lock tokens or arbitrary journal fields. Does not reconcile
 * onchain receipts: a well-formed journal is NOT a license to spend gas.
 */
import fs from 'node:fs';
import path from 'node:path';
type Tipo='diario'|'marker'|'tx'|'contratos'|'lock';
type Resumo={tipo:Tipo;estado:'ausente'|'presente'|'legivel'|'invalido';
  versao?:number;status?:string;pendente?:boolean;hashPendente?:string;
  noncePendente?:number;recibos?:number;dias?:number;marcadorConfirmado?:boolean};
const hashValido=(v:unknown):v is string=>
  typeof v==='string'&&/^0x[0-9a-fA-F]{64}$/.test(v);
export function lerResumoPersistente(file:string,tipo:Tipo):Resumo{
 const out:Resumo={tipo,estado:'ausente'};
 try{
   const stat=fs.statSync(file);
   if(!stat.isFile()){out.estado='invalido';return out;}
   if(tipo==='lock'){out.estado='presente';return out;}
   const d:unknown=JSON.parse(fs.readFileSync(file,'utf8'));
   if(!d||typeof d!=='object'||Array.isArray(d)){out.estado='invalido';return out;}
   const data=d as Record<string,unknown>;
   out.estado='legivel';
   if(Number.isSafeInteger(data.version))out.versao=data.version as number;
   if(typeof data.status==='string'&&['reserved','confirmed','pendente','reservado'].includes(data.status))
     out.status=data.status;
   if(tipo==='diario'){
     if(data.version!==1||!Array.isArray(data.receipts)||
       !data.days||typeof data.days!=='object'||Array.isArray(data.days)){
       out.estado='invalido';return out;
     }
     out.recibos=data.receipts.length;
     out.dias=Object.keys(data.days).length;
   }
   if(tipo==='marker')out.marcadorConfirmado=data.status==='confirmed'
     &&typeof data.contract==='string'&&/^0x[0-9a-fA-F]{40}$/.test(data.contract);
   const pending=tipo==='tx'?data:data.pending;
   out.pendente=!!pending;
   if(pending&&typeof pending==='object'&&!Array.isArray(pending)){
     const p=pending as Record<string,unknown>;
     if(hashValido(p.hash))out.hashPendente=p.hash;
     if(typeof p.nonce==='number'&&Number.isSafeInteger(p.nonce)&&p.nonce>=0)
       out.noncePendente=p.nonce;
   }
   if(out.pendente&&(!out.hashPendente||out.noncePendente===undefined))
     out.estado='invalido';
 }catch{out.estado='ausente';try{if(fs.existsSync(file))out.estado='invalido';}catch{}}
 return out;
}
export function auditarPersistenciaMegazord(env:NodeJS.ProcessEnv):{
 somenteLeitura:true;volumeDetectado:boolean;arquivos:Record<string,Resumo>;
 aviso:string;
}{
 const root='/app/data/';
 const diary=env.MEGAZORD_DIARIO;
 const valido=!!diary&&diary.startsWith(root)&&!diary.includes('..')
   &&path.isAbsolute(diary)&&diary.endsWith('.json');
 let mounted=false;
 try{
   mounted=fs.readFileSync('/proc/self/mountinfo','utf8')
     .split('\n').some(line=>line.split(' ')[4]==='/app/data');
 }catch{}
 const arquivos:Record<string,Resumo>={
   diario:valido?lerResumoPersistente(diary!,'diario'):{tipo:'diario',estado:'invalido'},
   lock:valido?lerResumoPersistente(diary!+'.lock','lock'):{tipo:'lock',estado:'invalido'},
   cacheContratos:valido?lerResumoPersistente(diary!+'.contratos.json','contratos'):{tipo:'contratos',estado:'invalido'},
   marcadorV3:lerResumoPersistente(root+'titanMorphoV3Deploy.json','marker'),
   marcadorAero:lerResumoPersistente(root+'titanMorphoAeroDeploy.json','marker'),
   transacaoV3:lerResumoPersistente(root+'titanMorphoV3Tx.json','tx'),
 };
 return {somenteLeitura:true,volumeDetectado:mounted,arquivos,
   aviso:'Integridade estrutural nao comprova recibo, nonce reconciliado, identidade do executor nem lucro'};
}
