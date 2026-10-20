// LIVE read-only diagnosis. No private keys, approvals, broadcasts or secrets.
const {JsonRpcProvider,Interface,getAddress,ZeroAddress}=require('ethers');
const MORPHO='0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const FACTORY='0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const AEROFACTORY='0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const V3='0x4628b37Ad534cB382ed56bC5d8801D12f86A7dCb';
const AERO='0xe25f8cB85157bF312BAAB1798fd2882CC8318912';
const OWNER='0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const mk=new Interface(['function idToMarketParams(bytes32) view returns(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)','function position(bytes32,address) view returns(uint256 supplyShares,uint128 borrowShares,uint128 collateral)','function market(bytes32) view returns(uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)']);
const price=new Interface(['function price() view returns(uint256)']);
const pools=new Interface(['function getPool(address,address,uint24) view returns(address)']);
const aeroPool=new Interface(['function getPool(address,address,bool) view returns(address)']);
const abiV3=new Interface(['function liquidar((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),address,uint256,uint256,uint24,uint256,uint256) returns(uint256)']);
const abiAero=new Interface(['function liquidar((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv),address,uint256,uint256,bool,uint256,uint256) returns(uint256)']);
const targets=[
  {id:'0x34f676bd8db106d6cdc90d0fb44145cea2f393310a794812cb1c5a8726b60913',user:'0x69218c6f102e3bb7b2733eb597ba29b55621045d'},
  {id:'0xde70aae6f81a39f4144149ba97e48f547cc6a9f36163f856acbf29e0e02ed8fd',user:'0x763103d82d22e54efee30e00c40bd34dbde9896f'},
  {id:'0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354',user:'0x7dcdb4ad4017f848879d17370aa6f32564e5cd08'}
];
const brief=e=>({selector:(typeof e.data==='string'?e.data:null)?.slice(0,10)??null,reason:String(e.reason??e.shortMessage??'unknown').slice(0,140)});
(async()=>{
 const p=new JsonRpcProvider('https://mainnet.base.org',8453,{staticNetwork:true});
 try{
  const b=await p.getBlock('latest');
  console.log('BLOCK',b?.number,'BASEFEE',String(b?.baseFeePerGas));
  for(const t of targets){
   try{
    const raw=await p.call({to:MORPHO,data:mk.encodeFunctionData('idToMarketParams',[t.id])});
    const m=mk.decodeFunctionResult('idToMarketParams',raw);
    const market=[m.loanToken,m.collateralToken,m.oracle,m.irm,m.lltv];
    const [rpos,rmarket,rprice]=await Promise.all([
      p.call({to:MORPHO,data:mk.encodeFunctionData('position',[t.id,t.user])}),
      p.call({to:MORPHO,data:mk.encodeFunctionData('market',[t.id])}),
      p.call({to:m.oracle,data:price.encodeFunctionData('price')}),
    ]);
    const pos=mk.decodeFunctionResult('position',rpos);
    const totals=mk.decodeFunctionResult('market',rmarket);
    const pr=price.decodeFunctionResult('price',rprice)[0];
    const borrow=pos.borrowShares;
    const estDebt=borrow*(totals.totalBorrowAssets+1n)/(totals.totalBorrowShares+1000000n);
    const factor=estDebt>0n?(pos.collateral*pr*m.lltv*10000n/(estDebt*10n**54n)):0n;
    console.log('MARKET',JSON.stringify({id:t.id,user:t.user,loan:m.loanToken,col:m.collateralToken,shares:String(borrow),collateral:String(pos.collateral),ltv:String(m.lltv),healthBps:String(factor),estimatedCrossed:factor<=10000n}));
    if(borrow===0n)continue;
    const sizes=[borrow/4n,borrow/2n,borrow].filter(x=>x>0n);
    for(const fee of [100,500,3000,10000]){
     const pool=pools.decodeFunctionResult('getPool',await p.call({to:FACTORY,data:pools.encodeFunctionData('getPool',[m.collateralToken,m.loanToken,fee])}))[0];
     if(pool===ZeroAddress)continue;
     for(const shares of sizes){
      const data=abiV3.encodeFunctionData('liquidar',[market,t.user,0n,shares,fee,1n,BigInt(b.timestamp+120)]);
      try{const out=abiV3.decodeFunctionResult('liquidar',await p.call({to:V3,from:OWNER,data}));console.log('V3_OK',fee,String(shares),String(out[0]));}
      catch(e){console.log('V3_REVERT',fee,String(shares),JSON.stringify(brief(e)));}
     }
    }
    for(const stable of [true,false]){
     const pool=aeroPool.decodeFunctionResult('getPool',await p.call({to:AEROFACTORY,data:aeroPool.encodeFunctionData('getPool',[m.collateralToken,m.loanToken,stable])}))[0];
     if(pool===ZeroAddress)continue;
     for(const shares of sizes){
      const data=abiAero.encodeFunctionData('liquidar',[market,t.user,0n,shares,stable,1n,BigInt(b.timestamp+120)]);
      try{const out=abiAero.decodeFunctionResult('liquidar',await p.call({to:AERO,from:OWNER,data}));console.log('AERO_OK',stable,String(shares),String(out[0]));}
      catch(e){console.log('AERO_REVERT',stable,String(shares),JSON.stringify(brief(e)));}
     }
    }
   }catch(e){console.log('MARKET_ERROR',t.id,JSON.stringify(brief(e)));}
  }
 }finally{p.destroy();}
})().catch(e=>{console.error('DIAGNOSTIC_ERROR',String(e.shortMessage??e.message).slice(0,180));process.exitCode=1});
