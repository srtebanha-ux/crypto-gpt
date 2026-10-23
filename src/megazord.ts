/** Combined scanners with optional shared financial executor. */
import {createLogger} from './logger';
import {instalarExecutorMegazord,conferirIdentidadeMegazord} from './megazordExecutor';
import {selecionarRpcSecundarioMegazord} from './megazordRpcFailover';
import {prepararMorphoMegazord} from './megazordMorphoBoot';
import {prepararAaveMultiHopMegazord,habilitarAaveMultiHopMegazord} from './megazordAaveMultiBoot';
import {atualizarPisoUsdMegazord,iniciarAtualizacaoPisoUsd} from './megazordEthUsd';
import {JsonRpcProvider} from 'ethers';
const log=createLogger('megazord');
export type MotoresMegazord={
 liquidacoes:()=>Promise<'parar'|void>;
 arbitragem:()=>Promise<void>;
};

export function conferirModoMegazord(env:NodeJS.ProcessEnv):void{
 if(env.MEGAZORD_MODO!=='observacao'&&env.MEGAZORD_MODO!=='execucao')
   throw Error('MEGAZORD_MODO deve ser observacao ou execucao');
 if(env.MEGAZORD_MODO==='execucao'){
   if(env.MEGAZORD_CONFIRMAR!=='OPERAR_BASE_REAL'||env.MEGAZORD_EXCLUSIVO!=='1')
     throw Error('execucao exige confirmacao e exclusividade da carteira');
   return;
 }
 // Fail closed rather than silently turning off an existing live service.
 // Run in an isolated service; never change the existing services' flags.
 const armed=Object.entries(env).filter(([k,v])=>k.endsWith('_ENVIAR')&&v==='1').map(([k])=>k);
 if(armed.length)throw Error('Megazord de observacao recusa envio habilitado: '+armed.join(', '));
}

/** Preserve the liquidator's standalone retry lifecycle inside the combined process. */
export async function manterLiquidanteMegazord(
 iniciar:()=>Promise<'parar'|void>,
 esperar:()=>Promise<void>=()=>new Promise(r=>setTimeout(r,1000)),
):Promise<'parar'>{
 for(;;){
   try{if(await iniciar()==='parar')return 'parar';}
   catch(e){log.warn('Liquidante vai tentar novamente.',{
     motivo:e instanceof Error?e.message:'falha de inicializacao',
   });}
   await esperar();
 }
}

export async function iniciarMegazord(
 env:NodeJS.ProcessEnv,
 carregar:()=>Promise<MotoresMegazord>,
):Promise<never>{
 conferirModoMegazord(env);
 if(env.MEGAZORD_MODO==='execucao'){
   // Network-only readiness must pass before any signer or scanner is loaded.
   // Fails closed if the contract is not deployed, RPCs disagree, wallet differs,
   // gas balance is zero or a non-durable journal was configured.
   conferirIdentidadeMegazord(env);
   // Deploy is strictly opt-in with a per-contract gas cap. An unresolved
   // marker, unknown nonce or mismatching immutable fails the WHOLE boot.
   const contratos=await prepararMorphoMegazord(env);
   // Only an Aave executor verified against ALL onchain immutables may be
   // whitelisted. The complete readiness check still follows before arming.
   const multi=await prepararAaveMultiHopMegazord(env);
   if(multi)env.MEGAZORD_CONTRATOS=[env.MEGAZORD_CONTRATOS,multi].filter(Boolean).join(',');
   const rede=await selecionarRpcSecundarioMegazord(env) as Awaited<ReturnType<typeof import('./megazordPreflight').conferirRedeMegazord>>;
   const leitorPreco=new JsonRpcProvider(env.MEGAZORD_RPC_URL!,8453,{staticNetwork:true});
   let lucroUsd:{ethUsd:string;minimoWei:string};
   try{lucroUsd=await atualizarPisoUsdMegazord(env,leitorPreco);}
   finally{leitorPreco.destroy();}
   log.info('Preflight de execucao aprovado (somente leitura).',{
     endereco:rede.address,
     rpcs:rede.checks.length,
     escopo:rede.scope,
     executoresMorphoConferidos:2,
     implantesNestaInicializacao:contratos.novos,
     lucroMinimoWethWei:lucroUsd.minimoWei,
     precoReferenciaEthUsd:lucroUsd.ethUsd,
   });
   // Automatic Morpho LIVE only when the service was expressly configured
   // for MEGAZORD_MODO=execucao and every onchain + wallet gate passed.
   // Strategies still execute full eth_call/gas/profit gates per candidate.
   for(const kind of ['V3','AERO']){
     env['CACA_MORPHO_'+kind+'_AVALIAR']='1';
     env['CACA_MORPHO_'+kind+'_ENVIAR']='1';
     env['CACA_MORPHO_'+kind+'_CONFIRMAR']='OPERAR_MORPHO_BASE';
     env['CACA_MORPHO_'+kind+'_NONCE_EXCLUSIVO']='1';
   }
   if(multi)habilitarAaveMultiHopMegazord(env,multi);
   else{
     // No compatible Aave multi-hop contract: keep legacy V1/V2 disarmed,
     // while Morpho V3/Aero can still prove and submit atomically.
     env.CACA_ENVIAR='0';
     env.CACA_MULTIHOP_ENVIAR='0';
   }
   iniciarAtualizacaoPisoUsd(env,env.MEGAZORD_RPC_URL!,
     message=>log.warn(message));
 }
 // Import engines only after policy validation. No scanner boot on import.
 const motores=await carregar();
 const rodar=async(nome:keyof MotoresMegazord)=>{
   const resultado=await motores[nome]();
   throw Error('Motor '+nome+' encerrou'+(resultado==='parar'?': configuracao invalida':''));
 };
 // One failure must terminate this process, not leave a half-working robot.
 await Promise.all([rodar('liquidacoes'),rodar('arbitragem')]);
 throw Error('Megazord encerrou inesperadamente');
}

if(require.main===module){
 void iniciarMegazord(process.env,async()=>{
   if(process.env.MEGAZORD_MODO==='execucao'){
     instalarExecutorMegazord(process.env);
     for(const k of ['CACA_CHAVE_PRIVADA','TITAN_CHAVE_PRIVADA']){
       // Existing aliases remain checked against the single owner's address.
       if(!process.env[k])process.env[k]=process.env.MEGAZORD_CHAVE_PRIVADA;
     }
   }
   const [caca,arb]=await Promise.all([import('./cacarAoVivo'),import('./cacarArbitragem')]);
   log.info('Motores unidos no mesmo processo.',{
     motores:['Aave/Morpho','arbitragem Base'],modo:process.env.MEGAZORD_MODO,
     executorFinanceiroUnificado:process.env.MEGAZORD_MODO==='execucao',
   });
   return {liquidacoes:()=>manterLiquidanteMegazord(caca.iniciarLiquidante),arbitragem:arb.iniciarArbitragem};
 }).catch(e=>{
   log.error('Megazord interrompido.',{motivo:e instanceof Error?e.message:'falha'});
   // Stop both engines and their timers after failure; do not run degraded.
   process.exit(1);
 });
}
