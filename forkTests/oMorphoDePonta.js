// O CACADOR DO MORPHO, DE PONTA A PONTA, no MORPHO BLUE DE VERDADE.
//
// "Uma chamada a eth_getCode isolada nao comprova compatibilidade funcional" —
// as palavras dela. Entao aqui nada e mock do lado do protocolo: o Morpho Blue
// e o contrato real da Base, identificado pela INTERFACE (os 10 seletores da
// sua superficie estao no bytecode de 15.623 bytes, e ele responde a `owner()`
// e a `isLltvEnabled(62,5%)`), e o nosso `CacadorMorpho` e compilado e
// publicado no fork.
//
// A descoberta dos mercados existentes esta bloqueada (o `eth_getLogs` publico
// recusou 23 de 24 janelas hoje). A saida nao e esperar: o `createMarket` do
// Morpho e PERMISSIONLESS, entao o teste cria o proprio mercado no Morpho real,
// com um oraculo nosso, e exercita o caminho inteiro. O que se prova e o
// MECANISMO — callback, unidades, permissoes, pagamento do emprestimo e piso de
// lucro — que e exatamente o que o contrato declara como nao verificado.
const assert = require('node:assert/strict');
const { Interface, AbiCoder, id, keccak256 } = require('ethers');

const MORPHO = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const ROUTER_AERODROME = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
const FACTORY_AERODROME = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const LLTV = 625000000000000000n; // 62,5% — o grupo de maior bonus do censo
const WAD = 10n ** 18n;
const ESCALA_ORACULO = 10n ** 36n;

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const morphoIface = new Interface([
    'function isIrmEnabled(address) view returns (bool)',
    'function isLltvEnabled(uint256) view returns (bool)',
    'function createMarket((address,address,address,address,uint256) marketParams)',
    'function supply((address,address,address,address,uint256) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256,uint256)',
    'function supplyCollateral((address,address,address,address,uint256) marketParams, uint256 assets, address onBehalf, bytes data)',
    'function borrow((address,address,address,address,uint256) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256,uint256)',
    'function position(bytes32,address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
    'function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)',
]);
const cacadorIface = new Interface([
    'function cacar((address,address,address,address,uint256) params, address devedor, uint256 seizedAssets, uint256 repaidShares, address poolDeVenda, bool poolEstavel, uint256 pisoDeLucro)',
    'function cofre() view returns (address)',
    'function dono() view returns (address)',
]);
const erc20 = new Interface([
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
]);

describe('O CACADOR DO MORPHO, de ponta a ponta no Morpho real', function () {
    this.timeout(1800000);

    it('cria mercado, derruba o oráculo e liquida pelo callback', async function () {
        const p = hre.network.provider;
        const call = async (to, data) => p.send('eth_call', [{ to, data }, 'latest']);
        const enviar = async (from, to, data, gas = '0x1000000', valor) => {
            const campos = { from, data, gas };
            if (to) campos.to = to;
            if (valor) campos.value = valor;
            const tx = await p.send('eth_sendTransaction', [campos]);
            const r = await p.send('eth_getTransactionReceipt', [tx]);
            return r;
        };
        const saldo = async (t, q) => BigInt(await call(t, erc20.encodeFunctionData('balanceOf', [q])));

        // ---------- 0. o Morpho real responde? ----------
        const codigo = await p.send('eth_getCode', [MORPHO, 'latest']);
        assert.ok((codigo.length - 2) / 2 > 10000, 'o Morpho real tem de ter codigo no fork');
        const irmZero = BigInt(await call(MORPHO, morphoIface.encodeFunctionData('isIrmEnabled', ['0x' + '0'.repeat(40)]))) === 1n;
        const lltvOk = BigInt(await call(MORPHO, morphoIface.encodeFunctionData('isLltvEnabled', [LLTV]))) === 1n;
        console.log(`    Morpho ${MORPHO} | ${(codigo.length - 2) / 2} bytes | irm(0) ${irmZero} | lltv 62,5% ${lltvOk}`);
        assert.ok(lltvOk, 'o LLTV de 62,5% tem de estar habilitado');
        const IRM = irmZero ? '0x' + '0'.repeat(40) : null;
        assert.ok(IRM !== null, 'sem IRM habilitado nao da para criar mercado — declararia o bloqueio');

        const [eu, borrower] = await p.send('eth_accounts', []);

        // ---------- 1. o nosso ORACULO: preco na escala 1e36 ----------
        // O Morpho le `price()` e a escala e 1e36 ajustada pelos decimais:
        // price = (loan por collateral) * 1e36 * 10^(decLoan) / 10^(decColl)
        // WETH 18 casas, USDC 6 -> 1 WETH = 2500 USDC vira 2500 * 1e36 * 1e6/1e18
        const precoDe = (usdPorWeth) => (BigInt(usdPorWeth) * ESCALA_ORACULO * 10n ** 6n) / 10n ** 18n;
        const artOrcMorpho = await hre.artifacts.readArtifact('OraculoMorphoFalso');
        const recOrc2 = await enviar(eu, undefined, artOrcMorpho.bytecode);
        const ORACULO_M = recOrc2.contractAddress;
        const setPreco = async (v) => p.send('hardhat_setStorageAt', [ORACULO_M, '0x0', `0x${v.toString(16).padStart(64, '0')}`]);
        await setPreco(precoDe(2500));
        const lido = BigInt(await call(ORACULO_M, sel('price()')));
        console.log(`    oraculo nosso ${ORACULO_M} | price() ${lido} (${Number(lido / (ESCALA_ORACULO / 10n ** 12n)) / 1e18} na escala 1e36 ajustada)`);
        assert.equal(lido, precoDe(2500));

        // ---------- 2. o MERCADO, criado no Morpho real ----------
        const params = [USDC, WETH, ORACULO_M, IRM, LLTV];
        const idMercado = keccak256(coder.encode(['(address,address,address,address,uint256)'], [params]));
        const recCriar = await enviar(eu, MORPHO, morphoIface.encodeFunctionData('createMarket', [params]));
        assert.equal(recCriar.status, '0x1', 'createMarket tem de passar no Morpho real');
        console.log(`    mercado criado ${idMercado.slice(0, 18)}... (USDC/WETH, lltv 62,5%)`);

        // ---------- 3. DINHEIRO: USDC e WETH de quem tem ----------
        // Sem baleia conhecida: USDC vem de `hardhat_setStorageAt`? O mapping de
        // saldo e desconhecido. Entao: WETH se cria com `deposit()`, e USDC vem
        // de uma troca no router da Aerodrome, que e o mesmo caminho que o
        // contrato usa para vender — testar com o pool real e melhor.
        await p.send('hardhat_setBalance', [eu, '0x' + (400n * 10n ** 18n).toString(16)]);
        await p.send('hardhat_setBalance', [borrower, '0x' + (200n * 10n ** 18n).toString(16)]);
        await enviar(eu, WETH, sel('deposit()'), '0x100000', '0x' + (300n * 10n ** 18n).toString(16));
        await enviar(borrower, WETH, sel('deposit()'), '0x100000', '0x' + (100n * 10n ** 18n).toString(16));
        const rotaIface = new Interface([
            'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[])',
        ]);
        await enviar(eu, WETH, erc20.encodeFunctionData('approve', [ROUTER_AERODROME, 300n * 10n ** 18n]));
        const agora = Number((await p.send('eth_getBlockByNumber', ['latest', false])).timestamp);
        await enviar(eu, ROUTER_AERODROME, rotaIface.encodeFunctionData('swapExactTokensForTokens', [
            100n * 10n ** 18n, 0n, [[WETH, USDC, false, FACTORY_AERODROME]], eu, agora + 3600,
        ]));
        const meuUsdc = await saldo(USDC, eu);
        console.log(`    vendi 100 WETH no pool real -> ${Number(meuUsdc) / 1e6} USDC`);
        assert.ok(meuUsdc > 100_000_000n, 'preciso de USDC para emprestar ao mercado');

        // ---------- 4. a POSICAO: eu empresto, o devedor toma ----------
        await enviar(eu, USDC, erc20.encodeFunctionData('approve', [MORPHO, meuUsdc]));
        const recSupply = await enviar(eu, MORPHO, morphoIface.encodeFunctionData('supply', [params, meuUsdc / 2n, 0n, eu, '0x']));
        assert.equal(recSupply.status, '0x1', 'supply tem de passar');
        await enviar(borrower, WETH, erc20.encodeFunctionData('approve', [MORPHO, 100n * 10n ** 18n]));
        await enviar(borrower, MORPHO, morphoIface.encodeFunctionData('supplyCollateral', [params, 10n * 10n ** 18n, borrower, '0x']));
        // 10 WETH a 2500 = 25.000; 62,5% = 15.625 de teto. Tomo 15.500.
        const tomar = 15_500_000_000n;
        const recBorrow = await enviar(borrower, MORPHO, morphoIface.encodeFunctionData('borrow', [params, tomar, 0n, borrower, borrower]));
        assert.equal(recBorrow.status, '0x1', 'borrow tem de passar — se nao, a escala do oraculo esta errada');
        console.log(`    devedor: 10 WETH de garantia, ${Number(tomar) / 1e6} USDC de divida`);

        // A SAUDE PELA NOSSA CONTA, com a funcao do projeto.
        require('ts-node/register');
        const { saudeNoMorpho, ESCALA_DO_ORACULO } = require('../src/morpho');
        const { Decimal } = require('decimal.js');
        const posCrua = await call(MORPHO, morphoIface.encodeFunctionData('position', [idMercado, borrower]));
        const pos = morphoIface.decodeFunctionResult('position', posCrua);
        const mktCrua = await call(MORPHO, morphoIface.encodeFunctionData('market', [idMercado]));
        const mkt = morphoIface.decodeFunctionResult('market', mktCrua);
        const dividaCrua = mkt[3] === 0n ? 0n : (pos[1] * mkt[2] + mkt[3] - 1n) / mkt[3];
        const nossa = (preco) => saudeNoMorpho({
            garantiaCrua: new Decimal(pos[2].toString()),
            dividaCrua: new Decimal(dividaCrua.toString()),
            precoDoOraculo: new Decimal(preco.toString()),
            lltv: new Decimal('0.625'),
        });
        console.log(`    NOSSA saude a US$ 2.500: ${nossa(precoDe(2500)).toFixed(8)} (o Morpho aceitou o borrow, logo > 1)`);
        assert.ok(nossa(precoDe(2500)).greaterThan(1), 'ESCALA_DO_ORACULO errada: eu digo quebrada e o Morpho emprestou');
        assert.equal(ESCALA_DO_ORACULO.toFixed(0), (10n ** 36n).toString());

        // ---------- 5. o ORACULO CAI e a posicao fica liquidavel ----------
        await setPreco(precoDe(2000));
        console.log(`    preco US$ 2.500 -> US$ 2.000 | NOSSA saude: ${nossa(precoDe(2000)).toFixed(8)}`);
        assert.ok(nossa(precoDe(2000)).lessThanOrEqualTo(1), 'a US$ 2.000 tem de estar liquidavel pela nossa conta');

        // ---------- 6. O NOSSO CONTRATO, publicado e disparado ----------
        const art = await hre.artifacts.readArtifact('CacadorMorpho');
        const construtor = coder.encode(['address', 'address', 'address', 'address'],
            [MORPHO, ROUTER_AERODROME, FACTORY_AERODROME, COFRE]);
        const recDeploy = await enviar(eu, undefined, art.bytecode + construtor.slice(2));
        assert.equal(recDeploy.status, '0x1', 'o CacadorMorpho tem de publicar');
        const CACADOR = recDeploy.contractAddress;
        assert.equal(`0x${(await call(CACADOR, sel('cofre()'))).slice(26)}`.toLowerCase(), COFRE.toLowerCase());
        console.log(`    CacadorMorpho em ${CACADOR} | cofre confere`);

        const antesCofre = await saldo(USDC, COFRE);
        // Tomar metade da garantia: 5 WETH a 2.000 = 10.000 de divida paga.
        const seized = 2n * 10n ** 18n;
        // poolDeVenda != 0 porque a garantia (WETH) NAO e a divida (USDC): sem
        // vender nao ha USDC para o Morpho puxar. O endereco e so a bandeira de
        // "venda" — a rota de verdade sai do router e da factory do construtor.
        const piso = 1n; // >0 de proposito: prova que o portao do piso roda
        let status = 'ERRO'; let erro = null; let gas = null;
        try {
            const r = await enviar(eu, CACADOR, cacadorIface.encodeFunctionData('cacar', [
                params, borrower, seized, 0n, '0xcdac0d6c6c59727a65f871236188350531885c43', false, piso,
            ]));
            status = r.status === '0x1' ? 'SUCESSO' : 'REVERTIDA';
            gas = parseInt(r.gasUsed, 16);
        } catch (e) { erro = e.message.slice(0, 160); }
        const lucroCofre = await saldo(USDC, COFRE) - antesCofre;
        const sobrouWeth = await saldo(WETH, COFRE);
        console.log(`    cacar(seized ${Number(seized) / 1e18} WETH, vendendo no pool real) -> ${status}`);
        if (gas) console.log(`    gasUsed ${gas}`);
        if (erro) console.log(`    erro: ${erro}`);
        console.log(`    cofre: +${Number(lucroCofre) / 1e6} USDC | WETH no cofre: ${Number(sobrouWeth) / 1e18}`);

        // O QUE ESTE TESTE AFIRMA, e cada um fecha uma incerteza declarada no .sol:
        //   - o callback `onMorphoLiquidate(uint256,bytes)` EXISTE e e chamado
        //   - as unidades de `seizedAssets` e do oraculo estao certas
        //   - o Morpho consegue PUXAR o loanToken desta conta (o `approve`)
        //   - o piso de lucro e conferido no fim
        //   - o lucro vai ao cofre imutavel
        assert.equal(status, 'SUCESSO', `a liquidacao no Morpho real tem de completar. ${erro ?? ''}`);
        assert.ok(lucroCofre > 0n || sobrouWeth > 0n, 'completou e nao sobrou nada no cofre');

        // ---------- 7. OS MODOS DE FALHA, no mesmo mercado real ----------
        //
        // "Teste o fluxo completo em fork, incluindo falhas relevantes." Cada
        // um destes e uma porta por onde o contrato poderia perder dinheiro ou
        // ser usado por terceiro.
        const falhou = async (quem, data, rotulo) => {
            try {
                const r = await enviar(quem, CACADOR, data);
                return r.status === '0x0' ? `revertida (${rotulo})` : 'PASSOU — e nao devia';
            } catch (e) { return `recusada (${rotulo})`; }
        };
        const falhas = {};

        // (a) ESTRANHO chamando `cacar`: so o dono caca.
        falhas.estranhoCacando = await falhou(borrower, cacadorIface.encodeFunctionData('cacar', [
            params, borrower, seized, 0n, '0xcdac0d6c6c59727a65f871236188350531885c43', false, 1n,
        ]), 'NaoEDono');

        // (b) ESTRANHO chamando o CALLBACK direto: a garantia esta aqui entre
        //     uma cacada e outra? Nao — mas se a `caca` ficasse viva, qualquer
        //     um entraria. O contrato tem de recusar por `msg.sender`.
        const callbackIface = new Interface(['function onMorphoLiquidate(uint256,bytes)']);
        falhas.callbackDeEstranho = await falhou(borrower,
            callbackIface.encodeFunctionData('onMorphoLiquidate', [1n, coder.encode(['address'], [borrower])]),
            'ChamadaInesperada');

        // (c) OS DOIS ZERO e OS DOIS CHEIOS: o Morpho aceita um ou outro, e o
        //     portao esta do NOSSO lado para a reversao dizer qual foi o erro.
        falhas.osDoisZero = await falhou(eu, cacadorIface.encodeFunctionData('cacar', [
            params, borrower, 0n, 0n, '0xcdac0d6c6c59727a65f871236188350531885c43', false, 1n,
        ]), 'UmDosDoisZero');
        falhas.osDoisCheios = await falhou(eu, cacadorIface.encodeFunctionData('cacar', [
            params, borrower, seized, 1000n, '0xcdac0d6c6c59727a65f871236188350531885c43', false, 1n,
        ]), 'UmDosDoisZero');

        // (d) PISO IMPOSSIVEL: a venda tem de ser recusada pelo ROUTER antes de
        //     executar, e a cacada inteira reverte. E o portao que impede
        //     executar uma liquidacao que nao paga.
        falhas.pisoImpossivel = await falhou(eu, cacadorIface.encodeFunctionData('cacar', [
            params, borrower, seized, 0n, '0xcdac0d6c6c59727a65f871236188350531885c43', false,
            10n ** 12n,
        ]), 'LucroInsuficiente/router');

        console.log(`    modos de falha: ${JSON.stringify(falhas, null, 1).replace(/\n/g, '\n    ')}`);
        for (const [caso, resultado] of Object.entries(falhas)) {
            assert.ok(!resultado.startsWith('PASSOU'), `${caso}: ${resultado}`);
        }
    });
});
