// Run inside the built image with --network none. Never import signing material.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
for(const file of ['dist/megazord.js','dist/titanMorphoPreflight.js',
 'dist/megazordContratosPreflight.js','.tmp/artifacts/FlashArbProva.json',
 '.tmp/artifacts/contracts/TitanCacadorMorphoV3.sol/TitanCacadorMorphoV3.json'])
 assert.ok(fs.existsSync(file),'runtime missing '+file);
for(const env of [{MEGAZORD_MODO:'invalid'},
 {MEGAZORD_MODO:'observacao',CACA_ENVIAR:'1'},
 {MEGAZORD_MODO:'execucao',MEGAZORD_CONFIRMAR:'OPERAR_BASE_REAL',MEGAZORD_EXCLUSIVO:'1'}]){
 const r=spawnSync(process.execPath,['dist/megazord.js'],{
  env:{PATH:process.env.PATH,...env},encoding:'utf8',timeout:15000});
 assert.equal(r.status,1,JSON.stringify(r.error));
 assert.match(r.stdout+r.stderr,/MEGAZORD_MODO|recusa envio|credencial/);
}
(async()=>{
 const {iniciarMegazord}=require(path.resolve('dist/megazord.js'));
 const started=[];
 await assert.rejects(iniciarMegazord({MEGAZORD_MODO:'observacao'},async()=>({
  liquidacoes:async()=>{started.push('liquidacoes');return 'parar';},
  arbitragem:()=>{started.push('arbitragem');return new Promise(()=>{});},
 })),/encerrou/);
 assert.deepEqual(started,['liquidacoes','arbitragem']);
 console.log('runtime: artefatos presentes; ambos motores carregaveis; gates bloqueiam envio; nenhuma rede');
})().catch(e=>{console.error(e);process.exitCode=1;});
