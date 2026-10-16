/**
 * TITAN Flashblocks: telemetria SOMENTE DE LEITURA.
 * Evento de 200ms ≠ estado final do bloco. NAO autoriza envio,
 * NAO assina transacoes, NAO contorna o ensaio economico onchain.
 * Requer endpoint WSS explicitamente configurado: nao derivar do HTTP.
 */
import WebSocket from 'ws';

export interface FlashblockTitan {
    idDoPayload: string;
    indice: number;
    transacoes: number;
    recebidoEmMs: number;
}
export function pedidoAssinaturaFlashblocks(id=1): string {
    return JSON.stringify({ jsonrpc:'2.0',id,method:'eth_subscribe',params:['flashblocks_v1'] });
}
export function interpretarFlashblocks(dado:string,agora=Date.now()):FlashblockTitan|null {
    let msg:unknown;
    try { msg=JSON.parse(dado); } catch {return null;}
    if(!msg||typeof msg!=='object') return null;
    const x=msg as Record<string,unknown>;
    if(x.method!=='eth_subscription'||!x.params||typeof x.params!=='object') return null;
    const params=x.params as Record<string,unknown>;
    if(!params.result||typeof params.result!=='object') return null;
    const r=params.result as Record<string,unknown>;
    const index=r.index;
    if(!Number.isInteger(index)||typeof index!=='number'||index<0||index>9) return null;
    if(typeof r.payload_id!=='string'||r.payload_id.length<1||r.payload_id.length>256) return null;
    const diff=r.diff;
    if(!diff||typeof diff!=='object') return null;
    const txs=(diff as Record<string,unknown>).transactions;
    if(txs!==undefined&&!Array.isArray(txs)) return null;
    return {
        idDoPayload:r.payload_id,indice:index,
        transacoes:Array.isArray(txs)?txs.length:0,recebidoEmMs:agora,
    };
}
export function abrirTelemetriaFlashblocks(
    wss:string,aoReceber:(f:FlashblockTitan)=>void,
    aoEstado?:(status:string)=>void,
):{fechar:()=>void} {
    if(!wss.startsWith('wss://')) throw new Error('FLASHBLOCKS_WSS deve ser um wss:// declarado');
    let fechado=false;
    let socket:WebSocket|null=null;
    let retry:NodeJS.Timeout|null=null;
    let delay=1000;
    const conectar=()=>{
        if(fechado)return;
        socket=new WebSocket(wss,{handshakeTimeout:5000});
        socket.on('open',()=>{
            delay=1000;
            aoEstado?.('conectado');
            socket?.send(pedidoAssinaturaFlashblocks());
        });
        socket.on('message',(data)=>{
            const evento=interpretarFlashblocks(data.toString());
            if(evento)aoReceber(evento);
        });
        socket.on('error',()=>aoEstado?.('falha do stream; sem efeito no motor'));
        socket.on('close',()=>{
            aoEstado?.('desconectado; nao altera o estado confirmado');
            socket=null;
            if(!fechado){
                retry=setTimeout(conectar,delay);
                delay=Math.min(delay*2,30_000);
            }
        });
    };
    conectar();
    return { fechar:()=>{
        fechado=true;
        if(retry)clearTimeout(retry);
        socket?.close();
    }};
}
// Diagnostico opcional e isolado, sem qualquer chave privada.
if(require.main===module){
    const url=process.env.TITAN_FLASHBLOCKS_WSS;
    if(!url) {
        console.error('[TITAN/FLASHBLOCKS] informe TITAN_FLASHBLOCKS_WSS (endpoint explicitamente suportado)');
        process.exitCode=2;
    } else {
        abrirTelemetriaFlashblocks(url,
            (x)=>console.log('[TITAN/FLASHBLOCKS] '+JSON.stringify(x)),
            (status)=>console.error('[TITAN/FLASHBLOCKS] '+status));
    }
}
