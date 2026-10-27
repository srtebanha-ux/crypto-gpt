const test=require('node:test');
const assert=require('node:assert/strict');
const {getCreateAddress}=require('ethers');
const {noncesToInspect}=require('./titanDescobrirExecutorPublico.cjs');
test('Direct CREATE search covers all small-wallet nonces without guessing a deployment',()=>{
 assert.deepEqual(noncesToInspect(0),[]);
 assert.deepEqual(noncesToInspect(5),[0,1,2,3,4]);
 assert.equal(getCreateAddress({from:'0x3D310384d674532f5D41cF2D43B03001F3515AE8',nonce:0}).startsWith('0x'),true);
});
test('High nonce never claims complete coverage when sampling only head and tail',()=>{
 assert.deepEqual(noncesToInspect(15,6),[0,1,2,12,13,14]);
 assert.equal(noncesToInspect(128).length,128);
 assert.equal(noncesToInspect(129).length,128);
});
test('Invalid count cannot silently imply no deployment',()=>{
 assert.throws(()=>noncesToInspect(-1));
 assert.throws(()=>noncesToInspect(NaN));
 assert.throws(()=>noncesToInspect(10,1));
});
