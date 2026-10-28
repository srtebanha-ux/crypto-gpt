/** One candidate through the existing executor. No discovery loop or signing. */
import {getAddress} from 'ethers';
import {ProviderMorphoRpc} from './morphoProvider';
import {codificarIdToMarketParams,lerIdToMarketParams,type MercadoDaApi} from './morphoApi';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
import {avaliarELiquidarMorphoV3} from './titanMorphoV3Tiro';
import {bloqueioRotaMorphoV3} from './titanMorphoDiretorDeRota';

export function ambientePreflightMorpho(original:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 const env={...original};
 for(const k of Object.keys(env)){
   if(/CHAVE_PRIVADA|PRIVATE_KEY/.test(k))delete env[k];
   if(k.endsWith('_ENVIAR')||k.endsWith('_DEPLOY'))env[k]='0';
 }
 env.MEGAZORD_MODO='observacao';
 env.CACA_ENDERECO_PUBLICO=env.MEGAZORD_ENDERECO_PUBLICO??env.CACA_ENDERECO_PUBLICO;
 const blocked=bloqueioRotaMorphoV3(env);
 if(blocked)throw Error(blocked);
 if(!env.CACA_ENDERECO_PUBLICO)throw Error('endereco PUBLICO do owner ausente');
 getAddress(env.CACA_ENDERECO_PUBLICO);getAddress(env.CACA_MORPHO_V3_CONTRATO!);
 if(!/^0x[0-9a-f]{64}$/i.test(env.CACA_MORPHO_V3_CODEHASH??''))
   throw Error('CACA_MORPHO_V3_CODEHASH auditado ausente');
 if(!/^0x[0-9a-f]{64}$/i.test(env.TITAN_PREFLIGHT_MERCADO??''))
   throw Error('TITAN_PREFLIGHT_MERCADO deve ser o id real do mercado');
 getAddress(env.TITAN_PREFLIGHT_USUARIO??'');
 if(!env.MEGAZORD_RPC_URL)throw Error('MEGAZORD_RPC_URL ausente');
 return env;
}

export async function preflightMorpho(original:NodeJS.ProcessEnv){
 const env=ambientePreflightMorpho(original);
 const p=new ProviderMorphoRpc(env.MEGAZORD_RPC_URL!);
 try{
   if(BigInt(await p.send('eth_chainId',[]))!==8453n)throw Error('rede diferente da Base');
   const id=env.TITAN_PREFLIGHT_MERCADO!;
   const params=lerIdToMarketParams(await p.call({to:MORPHO_FLASH_BASE,data:codificarIdToMarketParams(id)}));
   if(!params)throw Error('mercado inexistente ou parametros invalidos');
   const mercado:MercadoDaApi={...params,id,bonusPct:null,blocoDaCriacao:0,
     blocoIndexado:null,confirmadoNaCorrente:true,chainId:8453};
   const resultado=await avaliarELiquidarMorphoV3({mercado,usuario:env.TITAN_PREFLIGHT_USUARIO!,
     rpcUrl:env.MEGAZORD_RPC_URL!,signal:AbortSignal.timeout(120000)},env);
   return {somenteLeitura:true,mercado:id,usuario:env.TITAN_PREFLIGHT_USUARIO,
     resultado,pronto:resultado.status==='aprovada-simulada'&&!!resultado.transacaoPreparada};
 }finally{p.destroy();}
}
if(require.main===module){
 void preflightMorpho(process.env).then(r=>{
   console.log(JSON.stringify(r));if(!r.pronto)process.exitCode=1;
 }).catch(()=>{
   console.error('Preflight Morpho incompleto: verificar configuracao publica, codehash, candidato e RPC. Nenhum envio realizado.');
   process.exitCode=1;
 });
}
