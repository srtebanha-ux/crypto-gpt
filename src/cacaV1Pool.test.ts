import test from 'node:test';
import assert from 'node:assert/strict';
import {permiteV1NaPoolPadrao} from './cacaV1Pool';
const weth='0x4200000000000000000000000000000000000006';
const usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const cbbtc='0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const eurc='0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
const pool='0xcdac0d6c6c59727a65f871236188350531885c43';
test('known WETH/USDC only supports exact pair',()=>{
 assert.equal(permiteV1NaPoolPadrao(weth,usdc,pool,pool),true);
 assert.equal(permiteV1NaPoolPadrao(usdc,weth,pool,pool),true);
 assert.equal(permiteV1NaPoolPadrao(cbbtc,usdc,pool,pool),false);
 assert.equal(permiteV1NaPoolPadrao(eurc,usdc,pool,pool),false);
});
test('contract skips sale for same asset; no pool required',()=>{
 assert.equal(permiteV1NaPoolPadrao(cbbtc,cbbtc,pool,pool),true);
});
test('custom pool is unknown and remains subject to simulation',()=>{
 assert.equal(permiteV1NaPoolPadrao(eurc,usdc,'0x3333333333333333333333333333333333333333',pool),true);
});
