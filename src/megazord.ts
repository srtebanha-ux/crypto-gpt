/** Combined scanners with optional shared financial executor. */
import {auditarContratosMegazord} from './megazordContratosPreflight';
import {createLogger} from './logger';
import {instalarExecutorMegazord,conferirIdentidadeMegazord,conferirOrcamentoMegazord} from './megazordExecutor';
import {normalizarCredenciaisMegazord} from './megazordCredenciais';
import {auditarPersistenciaMegazord} from './megazordAuditoriaPersistencia';
import {selecionarParRpcMegazord} from './megazordRpcFailover';
import {prepararMorphoMegazord} from './megazordMorphoBoot';
import {prepararAaveMultiHopMegazord,habilitarAaveMultiHopMegazord} from './megazordAaveMultiBoot';
import {atualizarPisoUsdMegazord,iniciarAtualizacaoPisoUsd} from './megazordEthUsd';
import {JsonRpcProvider} from 'ethers';
import {MORPHO_FLASH_BASE} from './titanPonteMultiHop';
type RedeVerificada=Awaited<ReturnType<typeof import('./megazordPreflight').conferirRedeMegazord>>;
export type DependenciasBootMegazord={
 identidades:(env:NodeJS.ProcessEnv)=>Promise<void>;
 rede:(env:NodeJS.ProcessEnv)=>Promise<RedeVerificada>;
 preco:(env:NodeJS.ProcessEnv)=>Promise<{ethUsd:string;minimoWei:string}>;
 morpho:typeof prepararMorphoMegazord;
 aave:typeof prepararAaveMultiHopMegazord;
 atualizar:typeof iniciarAtualizacaoPisoUsd;
};
const boot:DependenciasBootMegazord={
 identidades:async env=>{
   // Pools are candidate-specific and audited again by the atomic CPAMM proof.
   await auditarContratosMegazord({...env,TITAN_CPAMM_ATOMICO:'0'});
 },
 rede:async env=>await selecionarParRpcMegazord(env) as RedeVerificada,
 preco:async env=>{
   const p=new JsonRpcProvider(env.MEGAZORD_RPC_URL!,8453,{staticNetwork:true});
   try{return await atualizarPisoUsdMegazord(env,p);}finally{p.destroy();}
 },
 morpho:prepararMorphoMegazord,aave:prepararAaveMultiHopMegazord,
 atualizar:iniciarAtualizacaoPisoUsd,
};
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

/** Match the CACA per-window cap to the shared daily cap only for an
 * explicitly authorized Megazord. The scanner reads it at module import.
 * A smaller operator-set quota is always preserved.
 */
export function alinharMaxEnviosMegazord(env:NodeJS.ProcessEnv):void{
 if(env.MEGAZORD_MODO!=='execucao')return;
 const max=Number(env.MEGAZORD_MAX_TX_DIA);
 if(!Number.isSafeInteger(max)||max<1||max>250)
   throw Error('Megazord exige MEGAZORD_MAX_TX_DIA entre 1 e 250');
 if(env.CACA_MAX_ENVIOS===undefined||env.CACA_MAX_ENVIOS===''){
   env.CACA_MAX_ENVIOS=String(max);
 }else{
   const configured=Number(env.CACA_MAX_ENVIOS);
   if(!Number.isSafeInteger(configured)||configured<1||configured>max)
     throw Error('CACA_MAX_ENVIOS deve estar entre 1 e MEGAZORD_MAX_TX_DIA');
 }
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
 deps:DependenciasBootMegazord=boot,
):Promise<never>{
 conferirModoMegazord(env);
 if(env.MEGAZORD_MODO==='execucao'){
   // Network-only readiness must pass before any signer or scanner is loaded.
   // Fails closed if the contract is not deployed, RPCs disagree, wallet differs,
   // gas balance is zero or a non-durable journal was configured.
   conferirIdentidadeMegazord(env);
   // No signer loaded or transaction sent here. Read-only evidence survives
   // even when all public RPC gateways reject the subsequent readiness gate.
   log.info('[TITAN/AUDITORIA-PERSISTENCIA-READONLY]',auditarPersistenciaMegazord(env));
   normalizarCredenciaisMegazord(env);
   // Align BEFORE loading the CACA module, which snapshots its env on import.
   // Invalid quotas abort before deploying contracts or loading signers.
   alinharMaxEnviosMegazord(env);
   conferirOrcamentoMegazord(env);
   // Check network/nonce/gas and the public price reference BEFORE any paid
   // deploy. The canonical Morpho address is only a readiness witness here,
   // never added to the financial executor's destination allowlist.
   const preliminar:NodeJS.ProcessEnv={...env,MEGAZORD_CONTRATOS:MORPHO_FLASH_BASE};
   try{await deps.rede(preliminar);}catch(e){
     throw Error('fase=rede_pre_contratos: '+(e instanceof Error?e.message:'falha'));
   }
   // The selected PRIMARY must be retained for all later price and signer RPCs.
   env.MEGAZORD_RPC_URL=preliminar.MEGAZORD_RPC_URL;
   env.MEGAZORD_RPC_SECUNDARIO=preliminar.MEGAZORD_RPC_SECUNDARIO;
   await deps.preco(env);
   // Deploy is strictly opt-in with a per-contract gas cap. An unresolved
   // marker, unknown nonce or mismatching immutable fails the WHOLE boot.
   const contratos=await deps.morpho(env);
   // Only an Aave executor verified against ALL onchain immutables may be
   // whitelisted. The complete readiness check still follows before arming.
   const multi=await deps.aave(env);
   if(multi)env.MEGAZORD_CONTRATOS=[env.MEGAZORD_CONTRATOS,multi].filter(Boolean).join(',');
   const rede=await deps.rede(env).catch(e=>{
     throw Error('fase=rede_pos_contratos: '+(e instanceof Error?e.message:'falha'));
   });
   await deps.identidades(env); // pinned bytecode and invariants on both RPCs before arming
   // Deploy confirmation can take time: do not arm from the pre-deploy quote.
   const lucroUsd=await deps.preco(env);
   log.info('Preflight de execucao aprovado (somente leitura).',{
     endereco:rede.address,
     rpcs:rede.checks.length,
     escopo:rede.scope,
     executoresMorphoConferidos:[contratos.v3,contratos.aero].filter(Boolean).length,
     implantesNestaInicializacao:contratos.novos,
     lucroMinimoWethWei:lucroUsd.minimoWei,
     precoReferenciaEthUsd:lucroUsd.ethUsd,
   });
   // Automatic Morpho LIVE only when the service was expressly configured
   // for MEGAZORD_MODO=execucao and every onchain + wallet gate passed.
   // Strategies still execute full eth_call/gas/profit gates per candidate.
   for(const kind of ['V3','AERO'] as const){
     if(!contratos[kind==='V3'?'v3':'aero']){
       env['CACA_MORPHO_'+kind+'_AVALIAR']='0';
       env['CACA_MORPHO_'+kind+'_ENVIAR']='0';
       continue;
     }
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
   deps.atualizar(env,env.MEGAZORD_RPC_URL!,
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
