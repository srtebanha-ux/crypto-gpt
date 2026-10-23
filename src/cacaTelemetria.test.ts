import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configurarRadarCaca,atualizarRadarCaca,registrarAlvoCaca,registrarTiroCaca,estadoRadarCaca} from './cacaTelemetria';

const id1='0x1111111111111111111111111111111111111111';
const id2='0x2222222222222222222222222222222222222222';
test('alvos prioritarios publicados com estado desconhecido ate leitura REAL',()=>{
 configurarRadarCaca([id1,id2],true,{CACA_TELEMETRIA_URL:'',CACA_TELEMETRIA_TOKEN:''} as NodeJS.ProcessEnv);
 const a=estadoRadarCaca();
 assert.equal(a.alvos.length,2);assert.equal(a.alvos[0]?.hf,null);
 atualizarRadarCaca(53_000_000,230,0);
 registrarAlvoCaca(id1,1.02,0.75,53_000_000);
 const b=estadoRadarCaca();
 assert.equal(b.bloco,53_000_000);assert.equal(b.vigiados,230);
 assert.equal(b.podemAtirar,0);assert.equal(b.alvos[0]?.hf,1.02);
 assert.equal(b.alvos[1]?.hf,null);
});
test('nunca inventa tiro ou aceita hash invalido',()=>{
 const prev=estadoRadarCaca().ultimoTiro;
 registrarTiroCaca('0x123',123,'confirmado');
 assert.deepEqual(estadoRadarCaca().ultimoTiro,prev);
 const hash='0x'+'f'.repeat(64);
 registrarTiroCaca(hash,53000000,'enviado');
 assert.deepEqual(estadoRadarCaca().ultimoTiro,{hash,bloco:53000000,estado:'enviado'});
});
