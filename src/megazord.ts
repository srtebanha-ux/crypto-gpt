/** Combined observation entrypoint. Financial adapters are not unified yet. */
import {createLogger} from './logger';
const log=createLogger('megazord');
export type MotoresMegazord={
 liquidacoes:()=>Promise<'parar'|void>;
 arbitragem:()=>Promise<void>;
};

export function conferirModoMegazord(env:NodeJS.ProcessEnv):void{
 if(env.MEGAZORD_MODO!=='observacao')
   throw Error('MEGAZORD_MODO deve ser observacao; executor financeiro conjunto ainda indisponivel');
 // Fail closed rather than silently turning off an existing live service.
 // Run in an isolated service; never change the existing services' flags.
 const armed=Object.entries(env).filter(([k,v])=>k.endsWith('_ENVIAR')&&v==='1').map(([k])=>k);
 if(armed.length)throw Error('Megazord de observacao recusa envio habilitado: '+armed.join(', '));
}

export async function iniciarMegazord(
 env:NodeJS.ProcessEnv,
 carregar:()=>Promise<MotoresMegazord>,
):Promise<never>{
 conferirModoMegazord(env);
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
   const [caca,arb]=await Promise.all([import('./cacarAoVivo'),import('./cacarArbitragem')]);
   log.info('Motores unidos no mesmo processo; somente observacao e simulacao.',{
     motores:['Aave/Morpho','arbitragem Base'],envio:false,
     executorFinanceiroUnificado:'ainda nao implementado',
   });
   return {liquidacoes:caca.iniciarLiquidante,arbitragem:arb.iniciarArbitragem};
 }).catch(e=>{
   log.error('Megazord interrompido.',{motivo:e instanceof Error?e.message:'falha'});
   // Stop both engines and their timers after failure; do not run degraded.
   process.exit(1);
 });
}
