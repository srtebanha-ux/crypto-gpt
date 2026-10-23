import test from 'node:test';
import assert from 'node:assert/strict';
import {id,getAddress} from 'ethers';
import {dadosDaFonteNoAaveOracle,lerFonteDoAaveOracle} from './cacaFeedDaAave';
const token='0x1111111111111111111111111111111111111111';
const oracle='0x2222222222222222222222222222222222222222';
test('encode AaveOracle.getSourceOfAsset sem encaminhar a endereco falso',()=>{
 const calldata=dadosDaFonteNoAaveOracle(token);
 assert.equal(calldata.slice(0,10),id('getSourceOfAsset(address)').slice(0,10));
 assert.equal(calldata.length,74);
 assert.equal(calldata.slice(-40),token.slice(2));
 assert.throws(()=>dadosDaFonteNoAaveOracle('0x1234'));
});
test('decode endereco retornado pelo oracle, sem inferir feed em caso de zero ou erro',()=>{
 const raw='0x'+oracle.slice(2).padStart(64,'0');
 assert.equal(lerFonteDoAaveOracle(raw),getAddress(oracle));
 assert.equal(lerFonteDoAaveOracle('0x'+'0'.repeat(64)),null);
 assert.equal(lerFonteDoAaveOracle('0x12'),null);
 assert.equal(lerFonteDoAaveOracle('0x'+'g'.repeat(64)),null);
});
