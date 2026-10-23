'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Interface}=require('ethers');
const {analyzeLogs,AAVE,MORPHO}=require('./rankearLiquidadoresBase.cjs');
const ifaceA=new Interface([
 'event LiquidationCall(address indexed collateralAsset,address indexed debtAsset,address indexed user,uint256 debtToCover,uint256 liquidatedCollateralAmount,address liquidator,bool receiveAToken)'
]);
const ifaceM=new Interface([
 'event Liquidate(bytes32 indexed id,address indexed caller,address indexed borrower,uint256 repaidAssets,uint256 repaidShares,uint256 seizedAssets,uint256 badDebtAssets,uint256 badDebtShares)'
]);
const g='0x'+'0'.repeat(63)+'1';
const token='0x'+'1'.repeat(40),borrower='0x'+'2'.repeat(40),liquidator='0x'+'3'.repeat(40);
function row(iface,ev,args,address,index,tx){
 const x=iface.encodeEventLog(iface.getEvent(ev),args);
 return{address,topics:x.topics,data:x.data,logIndex:'0x'+index.toString(16),
  blockNumber:'0x1',transactionHash:'0x'+tx.toString(16).padStart(64,'0')};
}
test('Aave usa liquidator do evento, nao from de transacao',()=>{
 const l=row(ifaceA,'LiquidationCall',[token,token,borrower,100n,110n,liquidator,false],AAVE,0,1);
 const r=analyzeLogs([l,l]);
 assert.equal(r.events,1);assert.equal(r.decodeErrors,0);
 assert.equal(r.ranked[0].liquidator,liquidator);
 assert.equal(r.ranked[0].events,1);
});
test('Morpho usa caller indexado, conta eventos separados e mostra mercados',()=>{
 const m=row(ifaceM,'Liquidate',[g,liquidator,borrower,100n,100n,110n,0n,0n],MORPHO,0,2);
 const a=analyzeLogs([m,{...m,logIndex:'0x1'}]);
 assert.equal(a.events,2);
 assert.equal(a.ranked[0].events,2);
 assert.equal(a.ranked[0].uniqueMarkets,1);
 assert.equal(a.ranked[0].uniqueTx,1);
});
test('ignora eventos falsos e enderecos nao confiaveis',()=>{
 const l=row(ifaceA,'LiquidationCall',[token,token,borrower,100n,110n,liquidator,false],token,0,1);
 assert.equal(analyzeLogs([l]).events,0);
});
