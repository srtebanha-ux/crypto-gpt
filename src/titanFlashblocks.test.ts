import {test} from 'node:test';
import assert from 'node:assert/strict';
import {interpretarFlashblocks,pedidoAssinaturaFlashblocks} from './titanFlashblocks';
const evento=(index:number,payload='p1')=>JSON.stringify({
    jsonrpc:'2.0',method:'eth_subscription',
    params:{subscription:'0xabc',result:{index,payload_id:payload,
        diff:{transactions:[{hash:'0x01'},{hash:'0x02'}]}}},
});
test('assina o topico flashblocks_v1, nunca eth_sendRawTransaction',()=>{
    const x=JSON.parse(pedidoAssinaturaFlashblocks());
    assert.equal(x.method,'eth_subscribe');
    assert.deepEqual(x.params,['flashblocks_v1']);
});
test('decodifica mensagem de stream e hora local de chegada',()=>{
    const x=interpretarFlashblocks(evento(4),123456);
    assert.deepEqual(x,{idDoPayload:'p1',indice:4,transacoes:2,recebidoEmMs:123456});
});
test('rejeita JSON inválido, assinatura de resposta e indices invalidos',()=>{
    assert.equal(interpretarFlashblocks('nao-json'),null);
    assert.equal(interpretarFlashblocks('{"id":1,"result":"0xdead"}'),null);
    assert.equal(interpretarFlashblocks(evento(10)),null);
    assert.equal(interpretarFlashblocks(evento(-1)),null);
});
test('stream vazio e valido sem transacao; nenhuma ordem de envio gerada',()=>{
    const x=JSON.stringify({method:'eth_subscription',
        params:{result:{payload_id:'a',index:0,diff:{}}}});
    assert.equal(interpretarFlashblocks(x)?.transacoes,0);
});
