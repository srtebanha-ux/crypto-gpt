// O TIRO VENCEDOR, EM FORK DA BASE — a validacao que nunca existiu.
//
// POR QUE ESTE TESTE EXISTE. As 39 transacoes reais de 07-08/10 reverteram
// TODAS porque nenhuma posicao cruzou (saude 1,00046 a 1,00208 no bloco
// anterior, lida na corrente). Ou seja: **nunca se provou que o contrato
// publicado consegue COMPLETAR uma liquidacao.** Compilar, testar com mock e
// contar 1.456 testes nao prova isso — a dona do bot disse exatamente isso.
//
// Aqui o caminho inteiro roda contra a Base de verdade, no estado de agora:
// Aave real, pool da Aerodrome real, contrato publicado real
// (0x9066b0ba..., o mesmo das 39), devedor real.
//
// O UNICO fingimento e o preco: a fonte de preco do WETH no oraculo da Aave e
// substituida por `OraculoFalso` e baixada ate a posicao ficar liquidavel. E o
// que acontece na vida quando o oraculo escreve — e o evento que a aposta tenta
// pegar.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const POOL_AAVE = '0xa238dd80c259a72e81d7e4664a9801593f98d1c5';
const CACADOR = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const DONO = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const POOL_VENDA = '0xcdac0d6c6c59727a65f871236188350531885c43';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
// Os alvos reais em que o bot atirou, com a cobertura que ele pediu.
const ALVOS = [
    ['0x66bb6c2949b20503adf3621db9903ee52f92ffb5', 75831589122n],
    ['0x16b00db74167b7469dda63b674ca9a3b1b70c439', 30463031728n],
    ['0xda0d95c69d3bdb65bc98e5889025ecbc1a23094f', 10233347683n],
    ['0x07a145dbbc7e425d0f1b3b9982f955e97abad7a2', 7009420648n],
    ['0x12f16a0aa0cefea43402ed11cf983cace2014dba', 3913824359n],
    ['0x616abe14181f02e379784265eebead9cfe942f04', 242782868n],
    ['0x9e70b090f9f7e367c81ff54265b412e483d444f6', 47636466n],
];

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const cacarIface = new Interface([
    'function cacar(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, address poolDeVenda, uint256 minProfit)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);
const call = async (to, data, bloco = 'latest') => chamar('eth_call', [{ to, data }, bloco]);
const palavra = (h, i) => BigInt(`0x${h.slice(2 + i * 64, 2 + (i + 1) * 64)}`);

async function conta(devedor) {
    const r = await call(POOL_AAVE, sel('getUserAccountData(address)') + devedor.slice(2).padStart(64, '0'));
    return {
        garantiaBase: palavra(r, 0), dividaBase: palavra(r, 1),
        limiar: palavra(r, 3), saude: palavra(r, 5),
    };
}
const saldoDe = async (token, quem) =>
    BigInt(await call(token, sel('balanceOf(address)') + quem.slice(2).padStart(64, '0')));

describe('O TIRO VENCEDOR, em fork da Base', function () {
    this.timeout(900000);

    it('o contrato publicado COMPLETA uma liquidacao e manda o lucro ao cofre', async function () {
        p = hre.network.provider;
        const bloco = parseInt(await chamar('eth_blockNumber', []), 16);

        // 1. O ORACULO DA AAVE, descoberto pela corrente (nada de cabeca).
        const prov = `0x${(await call(POOL_AAVE, sel('ADDRESSES_PROVIDER()'))).slice(26)}`;
        const oraculo = `0x${(await call(prov, sel('getPriceOracle()'))).slice(26)}`;
        const fonteWeth = `0x${(await call(oraculo, sel('getSourceOfAsset(address)') + WETH.slice(2).padStart(64, '0'))).slice(26)}`;
        const precoWeth = BigInt(await call(oraculo, sel('getAssetPrice(address)') + WETH.slice(2).padStart(64, '0')));
        console.log(`    bloco ${bloco} | provider ${prov}`);
        console.log(`    oraculo ${oraculo} | fonte do WETH ${fonteWeth} | preco US$ ${Number(precoWeth) / 1e8}`);
        assert.ok(precoWeth > 0n, 'sem preco do WETH nao ha teste');

        // 2. O ALVO: o primeiro dos reais que ainda tem divida no fork.
        let alvo = null;
        for (const [devedor, cobrir] of ALVOS) {
            const c = await conta(devedor);
            console.log(`    ${devedor.slice(0, 10)} saude ${(Number(c.saude) / 1e18).toFixed(8)} divida US$ ${(Number(c.dividaBase) / 1e8).toFixed(2)}`);
            if (c.dividaBase > 100_000_000n && alvo === null) alvo = { devedor, cobrir, ...c };
        }
        assert.ok(alvo !== null, 'nenhum dos alvos reais tem divida no fork — refaca a lista');
        console.log(`    >>> alvo ${alvo.devedor} divida US$ ${(Number(alvo.dividaBase) / 1e8).toFixed(2)}`);

        // 3. O FALSO ORACULO entra no lugar da FONTE do WETH, e so dele.
        const fabrica = await hre.artifacts.readArtifact('OraculoFalso');
        // Deploy de verdade para pegar o runtimeCode do compilador.
        const [conta0] = await chamar('eth_accounts', []);
        const txDeploy = await chamar('eth_sendTransaction', [{ from: conta0, data: fabrica.bytecode, gas: '0x500000' }]);
        const rec = await chamar('eth_getTransactionReceipt', [txDeploy]);
        const runtime = await chamar('eth_getCode', [rec.contractAddress, 'latest']);
        await chamar('hardhat_setCode', [fonteWeth, runtime]);

        // 4. BAIXAR o preco ate cruzar. Em passos, como o oraculo faria.
        let saude = alvo.saude; let usado = precoWeth; let passos = 0;
        for (let q = 1; q <= 60 && saude > 10n ** 18n; q++) {
            usado = (precoWeth * BigInt(1000 - q * 5)) / 1000n;
            const hex = `0x${usado.toString(16).padStart(64, '0')}`;
            await chamar('hardhat_setStorageAt', [fonteWeth, '0x0', hex]);
            saude = (await conta(alvo.devedor)).saude;
            passos = q;
        }
        const quedaPct = 100 - (Number(usado) * 100) / Number(precoWeth);
        console.log(`    preco do WETH US$ ${(Number(precoWeth) / 1e8).toFixed(2)} -> US$ ${(Number(usado) / 1e8).toFixed(2)} (-${quedaPct.toFixed(1)}%, ${passos} passos)`);
        console.log(`    saude agora ${(Number(saude) / 1e18).toFixed(8)}`);
        assert.ok(saude <= 10n ** 18n, 'nao consegui derrubar a posicao nem com -30% no WETH');

        // 5. O TIRO, do DONO, no contrato PUBLICADO, com o piso do contrato.
        await chamar('hardhat_impersonateAccount', [DONO]);
        await chamar('hardhat_setBalance', [DONO, '0x2386f26fc10000']); // 0,01 ETH
        const antesCofreUsdc = await saldoDe(USDC, COFRE);
        const antesCofreWeth = await saldoDe(WETH, COFRE);

        // o piso de 1,5% da cobertura — `pisoNoContrato` do projeto
        const piso = (alvo.cobrir * 150n) / 10_000n;
        const envio = cacarIface.encodeFunctionData('cacar', [
            WETH, USDC, alvo.devedor, alvo.cobrir, POOL_VENDA, piso,
        ]);
        let recTiro = null; let erro = null;
        try {
            const tx = await chamar('eth_sendTransaction', [{
                from: DONO, to: CACADOR, data: envio, gas: '0x4c4b40',
            }]);
            recTiro = await chamar('eth_getTransactionReceipt', [tx]);
        } catch (e) { erro = e.message; }

        const depoisCofreUsdc = await saldoDe(USDC, COFRE);
        const depoisCofreWeth = await saldoDe(WETH, COFRE);
        const lucroUsdc = depoisCofreUsdc - antesCofreUsdc;
        const lucroWeth = depoisCofreWeth - antesCofreWeth;
        console.log(`    cobertura pedida: ${Number(alvo.cobrir) / 1e6} USDC | piso exigido: ${Number(piso) / 1e6} USDC`);
        console.log(`    status: ${recTiro ? (recTiro.status === '0x1' ? 'SUCESSO' : 'REVERTIDA') : `ERRO (${erro})`}`);
        if (recTiro) console.log(`    gasUsed: ${parseInt(recTiro.gasUsed, 16)}`);
        console.log(`    LUCRO NO COFRE: ${Number(lucroUsdc) / 1e6} USDC | ${Number(lucroWeth) / 1e18} WETH`);

        assert.ok(recTiro !== null && recTiro.status === '0x1',
            `o tiro vencedor TEM de completar. ${erro ?? 'revertido'}`);
        assert.ok(lucroUsdc + lucroWeth > 0n, 'completou e nao sobrou lucro no cofre');
        assert.ok(lucroUsdc >= piso || lucroWeth > 0n, 'o lucro tem de respeitar o piso exigido');
    });
});
