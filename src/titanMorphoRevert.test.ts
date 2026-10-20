import test from 'node:test';
import assert from 'node:assert/strict';
import {motivoDoRevertMorpho,resumoRevertsMorpho} from './titanMorphoRevert';
test('keeps custom error selector without dumping RPC calldata',()=>{
 const err={code:'CALL_EXCEPTION',data:'0x1234abcd'+'f'.repeat(64),
  shortMessage:'execution reverted (unknown custom error)'};
 const s=motivoDoRevertMorpho(err);
 assert.match(s,/0x1234abcd/);
 assert.doesNotMatch(s,/fffffff/);
});
test('nested revert data is recoverable; secrets are not in telemetry',()=>{
 const s=motivoDoRevertMorpho({error:{
  data:'0x08c379a0',
  reason:'execution reverted at https://user:password@rpc.example.com/api',
 }});
 assert.match(s,/Error\(string\)/);
 assert.doesNotMatch(s,/password|rpc\.example/);
});
test('summarizes most frequent failures, instead of returning only generic unknown',()=>{
 const m=new Map([['pool sem liquidez',1],['custom error 0xabcdefff',3]]);
 assert.match(resumoRevertsMorpho(m),/^3x custom error/);
 assert.equal(motivoDoRevertMorpho({}),'sem dados de reversao do RPC');
});
