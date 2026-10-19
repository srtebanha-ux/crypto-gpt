import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lerSubbloco,anotarSubbloco,type EstadoFlashblocks} from './titanFlashblocks';
const base={payload_id:'0x01020304',index:0,
 base:{block_number:'0x32'},diff:{transactions:[]}};
const zero:EstadoFlashblocks={estado:'conectando',blocosLogicos:0,
 subblocos:0,indiceMaximo:0,pendentesRecebidos:0,erros:0,
 ultimoPayloadId:null,ultimoNumero:null,ultimoAvisoEm:0};
test('Base RPC newFlashblocks uses payload_id snake_case and carries 0 index',()=>{
 const a=lerSubbloco(base);
 assert.deepEqual(a,{payloadId:'0x01020304',indice:0,numero:'0x32'});
});
test('Flashblock indices above 10 belong to the same logical block until payload id changes',()=>{
 let z=anotarSubbloco(zero,lerSubbloco(base)!,100);
 z=anotarSubbloco(z,lerSubbloco({...base,index:11,base:undefined})!,200);
 assert.equal(z.blocosLogicos,1);assert.equal(z.subblocos,2);
 assert.equal(z.indiceMaximo,11);assert.equal(z.ultimoNumero,'0x32');
 z=anotarSubbloco(z,lerSubbloco({...base,payload_id:'0x05060708',index:0})!,300);
 assert.equal(z.blocosLogicos,2);assert.equal(z.ultimoPayloadId,'0x05060708');
});
test('rejected payload ids and unsupported schema never become a flashblock',()=>{
 assert.equal(lerSubbloco({...base,payloadId:'0xabc',payload_id:undefined}),null);
 assert.equal(lerSubbloco({...base,index:-1}),null);
 assert.equal(lerSubbloco({...base,index:11.2}),null);
 assert.equal(lerSubbloco({...base,payload_id:'https://site'}),null);
 assert.equal(lerSubbloco({}),null);
});
