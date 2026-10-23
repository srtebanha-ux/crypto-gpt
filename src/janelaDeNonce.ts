import {executorMegazordInstalado} from './megazordExecutor';
/**
 * Arbitragem TITAN e CACA partilham a MESMA carteira.
 * Exclusividade temporal cruzada com prova Base em DOIS RPCs independentes.
 * Um horario incerto, nonce pendente, cabeca antiga ou discordancia desliga envio.
 *
 * CACA: minuto UTC 02..26; TITAN: 32..56 (25 min por hora);
 * 5 min de guarda em cada passagem e 5 min na virada de hora.
 */
import { JsonRpcProvider } from 'ethers';
export type PapelDoEnvio='CACA'|'TITAN';
export type RespostaDaJanela={pode:boolean;motivo:string;bloco?:number;nonce?:number};

export function papelDaJanela(timestampSec:number):PapelDoEnvio|null{
    if(!Number.isSafeInteger(timestampSec)||timestampSec<0)return null;
    const minuto=Math.floor(timestampSec/60)%60;
    if(minuto>=2&&minuto<=26)return 'CACA';
    if(minuto>=32&&minuto<=56)return 'TITAN';
    return null;
}
type Leitor=Pick<JsonRpcProvider,'getNetwork'|'getBlock'|'getTransactionCount'>;
export async function conferirJanelaDeNonce(
    principal:Leitor,carteira:string,papel:PapelDoEnvio|'TITAN_SOLO',
    opcoes:{segundo?:Leitor;agoraMs?:number}={},
):Promise<RespostaDaJanela>{
    const own=opcoes.segundo===undefined;
    const sec=opcoes.segundo??new JsonRpcProvider('https://mainnet.base.org',8453,{staticNetwork:true});
    try{
        const agoraMs=opcoes.agoraMs??Date.now();
        if(!/^0x[\da-fA-F]{40}$/.test(carteira))
            return{pode:false,motivo:'carteira invalida'};
        const um=async(p:Leitor)=>{
            const net=await p.getNetwork();
            if(net.chainId!==8453n)throw Error('cadeia fora da Base');
            const [bloco,confirmado,pendente]=await Promise.all([
                p.getBlock('latest'),
                p.getTransactionCount(carteira,'latest'),
                p.getTransactionCount(carteira,'pending'),
            ]);
            if(!bloco)throw Error('bloco ausente');
            return{bloco:bloco.number,quando:bloco.timestamp,confirmado,pendente};
        };
        const [a,b]=await Promise.all([um(principal),um(sec)]);
        const stale=(t:number)=>Math.abs(Math.floor(agoraMs/1000)-t)>20;
        if(stale(a.quando)||stale(b.quando))
            return{pode:false,motivo:'base stale: RPC nao esta acompanhando a corrente'};
        if(!executorMegazordInstalado() && papel!=='TITAN_SOLO' && (papelDaJanela(a.quando)!==papel||papelDaJanela(b.quando)!==papel))
            return{pode:false,motivo:'janela de nonce reservada ao outro executor ou intervalo de guarda'};
        if(a.pendente!==a.confirmado||b.pendente!==b.confirmado)
            return{pode:false,motivo:'transacao pendente; nao dividir nonce entre executores'};
        if(a.confirmado!==b.confirmado)
            return{pode:false,motivo:'dois RPCs discordam sobre nonce confirmado'};
        if(Math.abs(a.bloco-b.bloco)>3)
            return{pode:false,motivo:'dois RPCs com blocos divergentes'};
        return{pode:true,motivo:papel==='TITAN_SOLO'?'TITAN sem janela horaria; nonce livre e dois RPCs atuais':'janela, relogio, rede e nonce confirmados em dois RPCs',
            bloco:Math.max(a.bloco,b.bloco),nonce:a.confirmado};
    }catch(e){
        return{pode:false,motivo:'nao confirmou exclusividade em dois RPCs: '+
            (e instanceof Error?e.message.slice(0,130):'falha desconhecida')};
    }finally{if(own)(sec as JsonRpcProvider).destroy();}
}
