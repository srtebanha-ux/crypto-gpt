// Teste LOCAL sem fork nem RPC externo: credito recebido, swaps, reembolso,
// lucro enviado ao cofre e revert quando nao pode devolver o principal.
const assert = require('node:assert/strict');
const hre = require('hardhat');
const { ethers } = require('ethers');

const artifact = name => require('../.tmp/artifacts/contracts/' +
    (name === 'CacadorArbMorpho' ? 'CacadorArbMorpho.sol/' :
    'TitanCreditoTeste.sol/') + name + '.json');
const provider = new ethers.BrowserProvider({
    request: ({method,params}) => hre.network.provider.request({method,params}),
});
async function implantar(name,signer,...args) {
    const a=artifact(name);
    const contrato=await new ethers.ContractFactory(a.abi,a.bytecode,signer).deploy(...args);
    await contrato.waitForDeployment();
    return contrato;
}
const q=10n**18n;
describe('CacadorArbMorpho — flash loan sem taxa e swap atomico',function(){
    let dono, outro,base,token,morpho,primeiro,segundo,arb;
    async function iniciar(taxaSegundaNum=3n,taxaSegundaDen=5n) {
        dono=await provider.getSigner(0);
        outro=await provider.getSigner(1);
        base=await implantar('TitanTokenTeste',dono,'WETH');
        token=await implantar('TitanTokenTeste',dono,'USDC');
        morpho=await implantar('TitanMorphoTeste',dono);
        primeiro=await implantar('TitanV3Teste',dono,await base.getAddress(),
            await token.getAddress(),2n,1n);
        segundo=await implantar('TitanV3Teste',dono,await token.getAddress(),
            await base.getAddress(),taxaSegundaNum,taxaSegundaDen);
        arb=await implantar('CacadorArbMorpho',dono,await dono.getAddress(),
            await morpho.getAddress());
        await (await base.mint(await morpho.getAddress(),1000n*q)).wait();
        await (await token.mint(await primeiro.getAddress(),1000n*q)).wait();
        await (await base.mint(await segundo.getAddress(),1000n*q)).wait();
    }
    function caminho() { return [
        [primeiro.target,base.target,0,0],
        [segundo.target,token.target,0,0],
    ]; }
    it('empresta, faz duas trocas, devolve 100 e envia somente 20 ao cofre',async function(){
        await iniciar();
        // Protege fundos anteriores: 7 WETH guardados nao sao lucro.
        await (await base.mint(arb.target,7n*q)).wait();
        const saldoInicial=await base.balanceOf(await dono.getAddress());
        const cotado=await arb.executarRota.staticCall(caminho(),100n*q,19n*q);
        assert.equal(cotado,20n*q);
        await (await arb.executarRota(caminho(),100n*q,19n*q)).wait();
        assert.equal(await base.balanceOf(await morpho.getAddress()),1000n*q);
        assert.equal(await base.balanceOf(await dono.getAddress()),saldoInicial+20n*q);
        assert.equal(await base.balanceOf(arb.target),7n*q);
    });
    it('reverte se a segunda troca nao devolve principal',async function(){
        await iniciar(1n,5n);
        const saldoAntes=await base.balanceOf(await morpho.getAddress());
        await assert.rejects(()=>arb.executarRota.staticCall(caminho(),100n*q,1n*q));
        assert.equal(await base.balanceOf(await morpho.getAddress()),saldoAntes);
        assert.equal(await base.balanceOf(await dono.getAddress()),0n);
    });
    it('impede callback de Morpho falsificado e chamada sem dono',async function(){
        await iniciar();
        await assert.rejects(()=>arb.onMorphoFlashLoan(100n*q,'0x'));
        await assert.rejects(()=>arb.connect(outro).executarRota.staticCall(
            caminho(),100n*q,0n));
    });
    it('nao aceita lucro minimo que excede a sobra comprovada',async function(){
        await iniciar();
        await assert.rejects(()=>arb.executarRota.staticCall(caminho(),100n*q,21n*q));
        assert.equal(await base.balanceOf(await morpho.getAddress()),1000n*q);
    });
});
