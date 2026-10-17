import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {decodificarCotacaoShadow,consolidarShadow} from './oracleShadow';

const now=1_800_000_000_000;
test('Binance combined trade and Coinbase ticker produce validated quotes',()=>{
    const p=['ETHUSDT','BTCUSDT'];
    const b=decodificarCotacaoShadow('binance',{stream:'ethusdt@trade',
        data:{e:'trade',s:'ETHUSDT',p:'3000.00'}},p,now);
    const c=decodificarCotacaoShadow('coinbase',{type:'ticker',
        product_id:'ETH-USD',price:'3002.00'},p,now);
    assert.equal(b?.preco.toString(),'3000');
    assert.equal(c?.preco.toString(),'3002');
    assert.deepEqual([...consolidarShadow(p,[b!,c!],now).precos.keys()],['ETHUSDT']);
});
test('quotes from two venues must agree within 35bps',()=>{
    const b={origem:'binance' as const,par:'ETHUSDT',preco:new Decimal(2990),recebidoEm:now};
    const c={origem:'coinbase' as const,par:'ETHUSDT',preco:new Decimal(3002),recebidoEm:now};
    const v=consolidarShadow(['ETHUSDT'],[b,c],now);
    assert.deepEqual(v.divergentes,['ETHUSDT']);
    assert.equal(v.precos.size,0);
});
test('stale, invalid, unsupported and negative values never generate signals',()=>{
    const p=['ETHUSDT'];
    assert.equal(decodificarCotacaoShadow('binance',{e:'trade',s:'ETHUSDT',p:'-1'},p,now),null);
    assert.equal(decodificarCotacaoShadow('binance',{e:'trade',s:'DOGEUSDT',p:'1'},p,now),null);
    assert.equal(decodificarCotacaoShadow('coinbase',{type:'ticker',product_id:'ETH-USD',
        price:'NaN'},p,now),null);
    const quote={origem:'binance' as const,par:'ETHUSDT',preco:new Decimal(3000),
        recebidoEm:now-3000};
    assert.equal(consolidarShadow(p,[quote],now).precos.size,0);
    assert.equal(consolidarShadow(p,[{...quote,recebidoEm:now+100}],now).precos.size,0);
});
test('single fresh price can only accelerate onchain reading, never proves liquidation',()=>{
    const quote={origem:'coinbase' as const,par:'BTCUSDT',preco:new Decimal(90000),recebidoEm:now};
    const r=consolidarShadow(['BTCUSDT'],[quote],now);
    assert.equal(r.quantidadeDeFontes,1);
    assert.equal(r.precos.get('BTCUSDT')?.toString(),'90000');
});
