import { test } from 'node:test';
import assert from 'node:assert/strict';
import { implantarMultiHop } from './implantarTitanMultiHop';

const plano={
    TITAN_MULTI_DEPLOY:'1',
    TITAN_MULTI_CONFIRMAR_DEPLOY:'IMPLANTAR_MULTIHOP_BASE_REAL',
    TITAN_NONCE_EXCLUSIVO:'1',
    TITAN_MULTI_DEPLOY_MARCADOR:'/app/data/titan-multihop-prova-unitaria.json',
    TITAN_MULTI_DEPLOY_TETO_WEI:'1000000000000000',
    CACA_ENVIAR:'0',
};
test('deploy nao tem emissor proprio: necessita chave e RPC ja existentes no CACA',async()=>{
    await assert.rejects(()=>implantarMultiHop({...plano}),/CACA_CHAVE_PRIVADA e CACA_RPC_URL/);
});
test('deploy barra colisao com o mesmo CACA transmissor antes de usar chave',async()=>{
    await assert.rejects(()=>implantarMultiHop({...plano,CACA_ENVIAR:'1'}),/interrompa o envio financeiro do CACA/);
});
test('deploy exige a confirmacao independente de nonce e rede',async()=>{
    await assert.rejects(()=>implantarMultiHop({...plano,TITAN_NONCE_EXCLUSIVO:'0'}),/nonce exclusivo/);
    await assert.rejects(()=>implantarMultiHop({...plano,TITAN_MULTI_DEPLOY:'0'}),/deploy desativado/);
});
