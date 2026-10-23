import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface} from 'ethers';
import {EURC_BASE,USDC_BASE,POOL_CANDIDATO,FABRICA_SLIPSTREAM,
 dadoPool,dadoFabricar,dadoQuoteSlipstream,decodificarMeta,decodificarPoolConfirmado,
 validaPoolSlipstream,decodificarQuoteSlipstream} from './cacaSlipstream';
const meta=new Interface(['function token0() view returns(address)','function token1() view returns(address)',
 'function factory() view returns(address)','function tickSpacing() view returns(int24)']);
const factory=new Interface(['function getPool(address,address,int24) view returns(address)']);
const quoter=new Interface(['function quoteExactInputSingle((address,address,uint256,int24,uint160)) returns(uint256,uint160,uint32,uint256)']);
test('ABI real CL pool e selector de quote',()=>{
 assert.equal(meta.parseTransaction({data:dadoPool('token0')})?.name,'token0');
 assert.equal(factory.decodeFunctionData('getPool',dadoFabricar(1))[2],1n);
 const vals=quoter.decodeFunctionData('quoteExactInputSingle',dadoQuoteSlipstream(2500000n,1))[0];
 assert.equal(vals[0].toLowerCase(),EURC_BASE.toLowerCase());
 assert.equal(vals[1].toLowerCase(),USDC_BASE.toLowerCase());
 assert.equal(vals[2],2500000n);
 assert.equal(vals[3],1n);
 assert.throws(()=>dadoQuoteSlipstream(0n,1));
 assert.throws(()=>dadoQuoteSlipstream(1n,0));
});
test('validacao falha fechada se candidato apontar outra fabrica ou ativo',()=>{
 const token0=decodificarMeta('token0',meta.encodeFunctionResult('token0',[EURC_BASE])) as string;
 const token1=decodificarMeta('token1',meta.encodeFunctionResult('token1',[USDC_BASE])) as string;
 const fa=decodificarMeta('factory',meta.encodeFunctionResult('factory',[FABRICA_SLIPSTREAM])) as string;
 const sp=decodificarMeta('tickSpacing',meta.encodeFunctionResult('tickSpacing',[1])) as number;
 const ok=decodificarPoolConfirmado(factory.encodeFunctionResult('getPool',[POOL_CANDIDATO]));
 const a={token0,token1,fabrica:fa,espaco:sp,confirmado:ok};
 assert.equal(validaPoolSlipstream(a),true);
 assert.equal(validaPoolSlipstream({...a,token1:'0x1111111111111111111111111111111111111111'}),false);
 assert.equal(validaPoolSlipstream({...a,fabrica:null}),false);
 assert.equal(validaPoolSlipstream({...a,confirmado:null}),false);
 assert.equal(decodificarMeta('tickSpacing','0x'),null);
 assert.equal(decodificarPoolConfirmado('0x'),null);
});
test('retorno de quoter sem dados nao e cotacao',()=>{
 const raw=quoter.encodeFunctionResult('quoteExactInputSingle',[987123n,42n,5n,193000n]);
 assert.deepEqual(decodificarQuoteSlipstream(raw),{saida:987123n,gasEstimate:193000n});
 assert.equal(decodificarQuoteSlipstream('0x'),null);
 assert.equal(decodificarQuoteSlipstream(quoter.encodeFunctionResult('quoteExactInputSingle',[0n,42n,5n,193000n])),null);
});
