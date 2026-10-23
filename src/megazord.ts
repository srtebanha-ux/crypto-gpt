/** Combined scanners with optional shared financial executor. */
import {createLogger} from './logger';
import {instalarExecutorMegazord,conferirIdentidadeMegazord} from './megazordExecutor';
import {conferirRedeMegazord} from './megazordPreflight';
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
   const rede=await conferirRedeMegazord(env);
   log.info('Preflight de execucao aprovado (somente leitura).',{
     endereco:rede.address,
     rpcs:rede.checks.length,
     escopo:rede.scope,
   });
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
