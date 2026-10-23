import {test} from 'node:test';
import assert from 'node:assert/strict';
import {papelDaJanela,conferirJanelaDeNonce} from './janelaDeNonce';
import type {JsonRpcProvider} from 'ethers';
const base='0x0000000000000000000000000000000000000001';
const t=(min:number)=>Date.UTC(2026,9,16,15,min,15);
function fake(ms:number,pending=4,latest=4,chainId=8453n){
    return {getNetwork:async()=>({chainId}),getBlock:async()=>({number:10,timestamp:Math.floor(ms/1000)}),
        getTransactionCount:async(_addr:string,tag:string)=>tag==='pending'?pending:latest
    } as unknown as JsonRpcProvider;
}
test('exclusividade entre CACA e TITAN e intervalos seguros em ambas as bordas',()=>{
    for(let m=0;m<60;m++){
        const p=papelDaJanela(Math.floor(t(m)/1000));
        assert.equal(p,m>=2&&m<=26?'CACA':m>=32&&m<=56?'TITAN':null);
    }
});
test('dois RPCs atuais, sem nonce pendente, autorizam apenas a janela correta',async()=>{
    const ms=t(15),rpc=fake(ms);
    assert.equal((await conferirJanelaDeNonce(rpc,base,'CACA',{segundo:rpc,agoraMs:ms})).pode,true);
    assert.equal((await conferirJanelaDeNonce(rpc,base,'TITAN',{segundo:rpc,agoraMs:ms})).pode,false);
});
test('nonce pendente, RPC stale e erro de rede bloqueiam imediatamente ambos',async()=>{
    const ms=t(45);
    assert.equal((await conferirJanelaDeNonce(fake(ms,5),base,'TITAN',
        {segundo:fake(ms),agoraMs:ms})).pode,false);
    assert.equal((await conferirJanelaDeNonce(fake(ms-100000),base,'TITAN',
        {segundo:fake(ms),agoraMs:ms})).pode,false);
    assert.equal((await conferirJanelaDeNonce(fake(ms),base,'TITAN',
        {segundo:fake(ms,4,3),agoraMs:ms})).pode,false);
    assert.equal((await conferirJanelaDeNonce(fake(ms),base,'TITAN',
        {segundo:fake(ms,4,4,1n),agoraMs:ms})).pode,false);
});
