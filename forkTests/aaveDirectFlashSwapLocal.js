const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const artifact=(name,folder)=>require('../.tmp/artifacts/contracts/'+folder+'/'+name+'.json');
const provider=new ethers.BrowserProvider({
    request:({method,params})=>hre.network.provider.request({method,params}),
});
async function deploy(name,folder,signer,...args) {
    const a=artifact(name,folder);
    const c=await new ethers.ContractFactory(a.abi,a.bytecode,signer).deploy(...args);
    await c.waitForDeployment();
    return c;
}
const Q=10n**18n;
describe('TITAN Aave direct flash swap V3 — LOCAL, nao mainnet',function(){
    let owner,other,collateral,debt,aave,fac,pool,liq;
    async function setup(reverse=false) {
        owner=await provider.getSigner(0);
        other=await provider.getSigner(1);
        collateral=await deploy('TitanTokenTeste','TitanCreditoTeste.sol',owner,'WETH');
        debt=await deploy('TitanTokenTeste','TitanCreditoTeste.sol',owner,'USDC');
        aave=await deploy('TitanAaveTestPool','TitanAaveTeste.sol',owner);
        fac=await deploy('TitanV3FactoryTest','TitanAaveTeste.sol',owner);
        pool=await deploy('TitanV3SaidaExataTest','TitanAaveTeste.sol',owner,
            reverse?debt.target:collateral.target,
            reverse?collateral.target:debt.target
        );
        await (await fac.registrar(collateral.target,debt.target,500,pool.target)).wait();
        liq=await deploy('CacadorAaveFlashSwap','CacadorAaveFlashSwap.sol',owner,
            await owner.getAddress(),aave.target,fac.target);
        await (await debt.mint(pool.target,1000n*Q)).wait();
        await (await collateral.mint(aave.target,1000n*Q)).wait();
    }
    // Deterministic target (mock getUserAccountData ignores address).
    const target='0x00000000000000000000000000000000000000F1';
    function args(min=2n*Q,max=103n*Q,fee=500,p=pool.target) {
        return [p,fee,collateral.target,debt.target,target,100n*Q,max,min];
    }
    it('liquida com a pool V3, paga colateral e somente lucro do ciclo vai ao cofre',async()=>{
        await setup();
        await (await collateral.mint(liq.target,1n)).wait();
        const old=await collateral.balanceOf(await owner.getAddress());
        const quote=await liq.liquidar.staticCall(...args());
        assert.equal(quote,3n*Q);
        const receipt=await (await liq.liquidar(...args())).wait();
        assert.equal(await collateral.balanceOf(owner.address),old+3n*Q);
        assert.equal(await collateral.balanceOf(liq.target),1n);
        assert.equal(await collateral.balanceOf(pool.target),102n*Q);
        assert.equal(await debt.balanceOf(aave.target),100n*Q);
        assert.equal(await debt.balanceOf(liq.target),0n);
        assert.ok(receipt.gasUsed>0n);
        console.log('gas local da liquidacao:',receipt.gasUsed.toString());
    });
    it('funciona tambem com garantia em token1, divida em token0',async()=>{
        await setup(true);
        assert.equal(await liq.liquidar.staticCall(...args()),3n*Q);
    });
    it('aborta quando HF >= 1 antes de emprestar tokens',async()=>{
        await setup();
        await (await aave.configure(1n*Q,105,100,true)).wait();
        await assert.rejects(()=>liq.liquidar.staticCall(...args()),/SaudeNaoLiquidavel/);
        assert.equal(await debt.balanceOf(aave.target),0n);
    });
    it('nao permite fabrica falsa ou fee de pool nao registrado',async()=>{
        await setup();
        await assert.rejects(()=>liq.liquidar.staticCall(...args(2n*Q,103n*Q,3000)),/PoolNaoCanonica/);
    });
    it('bloqueia spoof de callback e executores que nao sao owner',async()=>{
        await setup();
        await assert.rejects(
            ()=>liq.uniswapV3SwapCallback.staticCall(1n,-1n,'0x'),
            (e)=>liq.interface.parseError(e.data)?.name==='CallbackInesperado',
        );
        await assert.rejects(
            ()=>liq.connect(other).liquidar.staticCall(...args()),
            (e)=>liq.interface.parseError(e.data)?.name==='NaoDono',
        );
    });
    it('nao aceita slippage superior ao max de garantia',async()=>{
        await setup();
        await (await pool.configurar(10800,true)).wait();
        await assert.rejects(()=>liq.liquidar.staticCall(...args()),/GarantiaExcessiva/);
    });
    it('nao aceita liquidacao que nao cobre minProfit',async()=>{
        await setup();
        await assert.rejects(()=>liq.liquidar.staticCall(...args(4n*Q)),/GarantiaInsuficiente/);
    });
    it('rejeita swap parcial que devolve menos divida do que solicitada',async()=>{
        await setup();
        await (await pool.configurar(10200,false)).wait();
        await assert.rejects(()=>liq.liquidar.staticCall(...args()),/DividaNaoRecebida/);
    });
});
