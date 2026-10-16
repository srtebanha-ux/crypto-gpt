// Comparacao LOCAL do mesmo fluxo Aave flashswap em Cancun.
// O mock da pool e da Aave vem da compilacao Paris; variante de
// contrato nova vem de artefatos Cancun separados.
const assert=require('node:assert/strict');
const hre=require('hardhat');
const {ethers}=require('ethers');
const provider=new ethers.BrowserProvider({
    request:({method,params})=>hre.network.provider.request({method,params}),
});
const Q=10n**18n;
async function dep(name,folder,signer,args=[],cancun=false){
    const root=cancun?'../.tmp/artifacts-cancun/contractsCancun/':
        '../.tmp/artifacts/contracts/';
    const a=require(root+folder+'/'+name+'.json');
    const c=await new ethers.ContractFactory(a.abi,a.bytecode,signer).deploy(...args);
    await c.waitForDeployment();
    return c;
}
describe('EIP1153 — Aave V3 flashswap baseline vs transient',function(){
    let owner,col,debt,aave,fac,pool,baseline,trans;
    async function setup(){
        owner=await provider.getSigner(0);
        col=await dep('TitanTokenTeste','TitanCreditoTeste.sol',owner,['WETH']);
        debt=await dep('TitanTokenTeste','TitanCreditoTeste.sol',owner,['USDC']);
        aave=await dep('TitanAaveTestPool','TitanAaveTeste.sol',owner);
        fac=await dep('TitanV3FactoryTest','TitanAaveTeste.sol',owner);
        pool=await dep('TitanV3SaidaExataTest','TitanAaveTeste.sol',
            owner,[col.target,debt.target]);
        await (await fac.registrar(col.target,debt.target,500,pool.target)).wait();
        baseline=await dep('CacadorAaveFlashSwap','CacadorAaveFlashSwap.sol',
            owner,[owner.address,aave.target,fac.target]);
        trans=await dep('CacadorAaveFlashSwapTransient',
            'CacadorAaveFlashSwapTransient.sol',owner,
            [owner.address,aave.target,fac.target],true);
        await (await debt.mint(pool.target,1000n*Q)).wait();
        await (await col.mint(aave.target,1000n*Q)).wait();
    }
    const args=()=>[pool.target,500,col.target,debt.target,
        '0x00000000000000000000000000000000000000F1',100n*Q,103n*Q,2n*Q];
    it('resultados identicos e medida de gas das duas variantes',async()=>{
        await setup();
        const expected=await baseline.liquidar.staticCall(...args());
        const actual=await trans.liquidar.staticCall(...args());
        assert.equal(expected,3n*Q);
        assert.equal(actual,expected);
        const oldReceipt=await (await baseline.liquidar(...args())).wait();
        const newReceipt=await (await trans.liquidar(...args())).wait();
        assert.equal(await col.balanceOf(baseline.target),0n);
        assert.equal(await col.balanceOf(trans.target),0n);
        assert.equal(await col.balanceOf(owner.address),6n*Q);
        console.log('baseline_gas='+oldReceipt.gasUsed.toString());
        console.log('transient_gas='+newReceipt.gasUsed.toString());
        console.log('gas_delta='+(oldReceipt.gasUsed-newReceipt.gasUsed).toString());
    });
    it('reverte HF saudavel antes do flashswap (transient)',async()=>{
        await setup();
        await (await aave.configure(Q,105,100,true)).wait();
        await assert.rejects(()=>trans.liquidar.staticCall(...args()),/SaudeNaoLiquidavel/);
    });
    it('reverte callback forjado e piso irreal na versao Cancun',async()=>{
        await setup();
        await assert.rejects(()=>trans.uniswapV3SwapCallback.staticCall(1n,-1n,'0x'));
        const x=args();x[7]=4n*Q;
        await assert.rejects(()=>trans.liquidar.staticCall(...x));
    });
    it('callback nao deixa flags transitorias ativas entre transacoes',async()=>{
        await setup();
        await (await trans.liquidar(...args())).wait();
        // A segunda chamada no mesmo contrato continua disponivel em nova tx
        assert.equal(await trans.liquidar.staticCall(...args()),3n*Q);
    });
});
