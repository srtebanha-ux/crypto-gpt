/** Trava duravel do primeiro envio Multi-Hop dentro do UNICO processo do CACA.
 * Reservar a marca ANTES do nonce e da assinatura. Se o RPC falhar depois,
 * nao repetir em outra inicializacao sem reconciliar a transacao onchain.
 * O modo canary NAO usa um segundo assinador nem um segundo executor.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MARCADOR_CANARY = '/app/data/caca-multihop-primeiro-envio.json';

export function reservarUmEnvioMulti(
    entrada:{carteira:string;devedor:string;contrato:string;bloco:number},
    marcador:string=MARCADOR_CANARY,
): {liberado:boolean;motivo:string} {
    if(!marcador.startsWith('/app/data/')||marcador.includes('..'))
        return {liberado:false,motivo:'marcador fora do volume persistente'};
    let fd:number|undefined;
    try {
        fs.mkdirSync(path.dirname(marcador),{recursive:true});
        fd=fs.openSync(marcador,'wx',0o600); // atomicamente impede segundo envio
        fs.writeFileSync(fd,JSON.stringify({
            ...entrada,estado:'reservado_antes_do_nonce',
            quando:new Date().toISOString(),
            observacao:'nao apagar sem conciliar nonce e recibo na Base',
        }));
        fs.fsyncSync(fd);
        return {liberado:true,motivo:'primeiro e unico envio reservado'};
    } catch(err){
        const code=(err as NodeJS.ErrnoException).code;
        return {liberado:false,motivo:code==='EEXIST'
            ?'primeiro tiro ja foi reservado; conferir recibo e nonce antes de qualquer repeticao'
            :'nao consegui gravar marcador no volume: '+(code??'erro')};
    } finally{
        if(fd!==undefined)fs.closeSync(fd);
    }
}
export function custoMaximoMultiDentroDoTeto(
    limiteGas:bigint, maxFeePerGas:bigint, custoL1Wei:bigint, limiteTotalWei:bigint
):boolean {
    return limiteGas>0n&&maxFeePerGas>0n&&custoL1Wei>0n
        &&limiteTotalWei>0n
        &&limiteGas*maxFeePerGas+custoL1Wei<=limiteTotalWei;
}
