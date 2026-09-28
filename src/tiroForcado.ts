// Arquivo: src/tiroForcado.ts
//
// PROVA o caminho do tiro INTEIRO sem esperar o mercado cair.
//
//     npx tsx src/tiroForcado.ts <devedor> <queda%>
//
// Nao e fork e nao precisa de anvil: o RPC publico da Base aceita `eth_call`
// com state override — conferido em 2026-09-28. Entao troca-se o CODIGO do
// oraculo de precos da Aave por um stub compilado aqui com os precos REAIS, um
// deles derrubado. Todo o resto e real: a Aave real, o pool da Aerodrome real,
// os nossos contratos reais, no bloco atual.
//
// PRIMEIRA EXECUCAO, 2026-09-28, bloco 51912429, devedor
// 0xd1735aa5ffce9646e3cfec4cf4bd75c478c12fc1 (WETH US$ 4.625 contra USDC
// US$ 3.490, saude 1,100012), com o WETH derrubado 12%:
//
//     saude com o stub .... 0,968010  -> LIQUIDAVEL
//     V1 0x9066b0ba…    ... desfecho `mediu`, lucro 322759236 (US$ 322,74)
//     V2 0xb91c634f…    ... revertido, seletor 0x42301c23 NAO IDENTIFICADO
//
// O `mediu` do V1 e a prova: `cacar` com piso impossivel faz o contrato rodar a
// cacada INTEIRA — flash loan tomado na Aave, `liquidationCall` aceito, garantia
// vendida no pool da Aerodrome, emprestimo pago — e reverter no fim com
// `LucroInsuficiente(obtido, exigido)` carregando o lucro real. Sem esse
// desfecho nao ha numero.
//
// O LUCRO SAI INFLADO, E ISSO E DO TRUQUE, NAO DO CONTRATO. A Aave entrega a
// garantia avaliada pelo preco FALSO (baixo) e a Aerodrome compra pelo preco
// REAL (alto), o que cria um agio que nao existe no mundo:
//
//     medido com o oraculo forcado ....... US$ 322,74
//     artefato = 1745,15 x 1,05 x (2682,48/2360,59 - 1) = US$ 249,87
//     medido MENOS o artefato ............ US$  72,87
//     lucroEstimado() do repositorio ..... US$  75,89   <- caminho independente
//     diferenca .......................... 4,0%
//
// Ou seja: descontado o artefato que a propria conta prevê, o lucro medido pelo
// contrato de verdade bate em 4% com a curva de escorregamento que `src/venda.ts`
// mediu no pool. E a terceira vez que dois caminhos independentes deste projeto
// se conferem.
//
// Não é fork: o RPC público da Base aceita `eth_call` com state override
// (conferido). Então trocamos o CÓDIGO do oráculo de preços da Aave por um
// stub compilado com os preços reais, um deles derrubado. Tudo o mais é real:
// a Aave real, o pool da Aerodrome real, os nossos contratos reais, no bloco
// atual.
import { ProxyAgent, fetch as uf } from 'undici';
import solc from 'solc';
import { AbiCoder, id, getAddress } from 'ethers';
import { Decimal } from 'decimal.js';
import { REDES } from './liquidacoes';
import { enderecoDaResposta } from './reservas';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL } from './caca';
import { poolParaVender } from './cacarAoVivo';
import { POOLS } from './contratos';
import { codificarUserReserveData, decodificarUserReserveData, ehLimiteDoProvedor } from './liquidar';
import { MULTICALL3, codificarAggregate3, decodificarAggregate3, partirEmPedacos } from './multicall';

const RPC = 'https://mainnet.base.org';
const POOL = REDES.base!.pool;
const V1 = '0x9066b0ba6783322FEdE3BF5cd520C0f3A9AF3C78';
const V2 = '0xb91c634fb23934ED178b5116fCbFbF195B127F32';
const CONTA_BOT = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';
const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const agente = process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : undefined;
const coder = AbiCoder.defaultAbiCoder();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
let rid = 1;

async function rpc<T>(m: string, p: unknown[]): Promise<{ result?: T; error?: { message: string; data?: unknown } }> {
    let ultimo = '';
    for (let i = 0; i < 8; i++) {
        try {
            const r = await uf(RPC, { method: 'POST', dispatcher: agente,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method: m, params: p }) });
            const j = await r.json() as { result?: T; error?: { message: string; data?: unknown } };
            // Limite do provedor NAO e resposta: e a rede pedindo espera. Sem
            // repetir aqui, a medicao sai como "erro" e vira ausencia com cara
            // de resposta — o defeito que este projeto mais encontra.
            if (j.error && ehLimiteDoProvedor(j.error.message)) { ultimo = j.error.message; }
            else return j;
        } catch (e) { ultimo = (e as Error).message; }
        await dormir(1500 * (i + 1));
    }
    throw new Error(`${m}: ${ultimo}`);
}
const call = async (to: string, data: string, over?: unknown): Promise<string> => {
    const r = await rpc<string>('eth_call', over ? [{ to, data }, 'latest', over] : [{ to, data }, 'latest']);
    if (r.error) throw new Error(r.error.message);
    return r.result!;
};
const pal = (h: string, i: number) => BigInt('0x' + h.replace(/^0x/, '').slice(i * 64, (i + 1) * 64));
const end = (h: string, i: number) => '0x' + h.replace(/^0x/, '').slice(i * 64 + 24, (i + 1) * 64);

/** O stub do oráculo, com os preços reais embutidos no código. */
function compilarOraculo(precos: Array<{ ativo: string; preco: bigint }>): string {
    const ramos = precos
        // O solc exige o endereco em checksum, senao recusa o literal.
        .map((p) => `        if (a == ${getAddress(p.ativo)}) return ${p.preco.toString()};`)
        .join('\n');
    const fonte = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
contract OraculoForcado {
    function getAssetPrice(address a) public pure returns (uint256) {
${ramos}
        revert("ativo sem preco no stub");
    }
    function getAssetsPrices(address[] calldata aa) external pure returns (uint256[] memory out) {
        out = new uint256[](aa.length);
        for (uint256 i = 0; i < aa.length; i++) out[i] = getAssetPrice(aa[i]);
    }
    function BASE_CURRENCY() external pure returns (address) { return address(0); }
    function BASE_CURRENCY_UNIT() external pure returns (uint256) { return 1e8; }
    function getSourceOfAsset(address) external pure returns (address) { return address(0); }
    function getFallbackOracle() external pure returns (address) { return address(0); }
}`;
    const saida = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity',
        sources: { 'O.sol': { content: fonte } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['evm.deployedBytecode.object'] } } },
    })));
    const erros = (saida.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
    if (erros.length > 0) throw new Error(erros.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
    return '0x' + saida.contracts['O.sol'].OraculoForcado.evm.deployedBytecode.object;
}

(async () => {
    const DEVEDOR = (process.argv[2] ?? '0xd1735aa5a90fb5b0a0d6eca8fd77eb9b2e1d4eba').toLowerCase();
    const QUEDA_PCT = Number(process.argv[3] ?? '12');

    const bloco = Number.parseInt((await rpc<string>('eth_blockNumber', [])).result!, 16);
    console.log(`=== TIRO FORÇADO — bloco ${bloco} da Base, ${new Date().toISOString()}`);
    console.log(`=== devedor ${DEVEDOR}`);
    console.log(`=== queda forçada no preço da GARANTIA: ${QUEDA_PCT}%\n`);

    const prov = enderecoDaResposta(await call(POOL, '0x0542975c'))!;
    const dataProvider = enderecoDaResposta(await call(prov, '0xe860accb'))!;
    const oraculo = enderecoDaResposta(await call(prov, '0xfca513a8'))!;
    const listaHex = await call(POOL, '0xd1946dbc');
    const moedas = Array.from({ length: Number(pal(listaHex, 1)) }, (_, i) => end(listaHex, 2 + i));
    console.log(`oráculo real ..... ${oraculo}`);
    console.log(`dataProvider ..... ${dataProvider}`);
    console.log(`reservas ......... ${moedas.length}\n`);

    // Preços e posição reais
    const precos: Array<{ ativo: string; preco: bigint }> = [];
    const casas = new Map<string, number>();
    const simbolo = new Map<string, string>();
    let garantia = '', divida = '', gUsd = new Decimal(0), dUsd = new Decimal(0), dCrua = 0n;
    // Tudo num multicall: o RPC publico barra rajada de chamadas soltas.
    for (const pedaco of partirEmPedacos(moedas, 5)) {
        const rs = decodificarAggregate3(await call(MULTICALL3, codificarAggregate3(pedaco.flatMap((m) => [
            { alvo: oraculo, dados: '0xb3596f07' + m.replace(/^0x/, '').padStart(64, '0') },
            { alvo: m, dados: '0x313ce567' },
            { alvo: m, dados: '0x95d89b41' },
            { alvo: dataProvider, dados: codificarUserReserveData(m, DEVEDOR) },
        ]))));
        pedaco.forEach((m, k) => {
            const [rp, rd, rs2, ru] = [rs[k * 4], rs[k * 4 + 1], rs[k * 4 + 2], rs[k * 4 + 3]];
            if (!rp?.ok || !rd?.ok || !ru?.ok) throw new Error(`nao li a reserva ${m}`);
            const p = pal(rp.dados, 0);
            precos.push({ ativo: m, preco: p });
            const dec = Number(pal(rd.dados, 0));
            casas.set(m, dec);
            simbolo.set(m, rs2?.ok
                ? Buffer.from(rs2.dados.replace(/^0x/, ''), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').trim() || m.slice(0, 8)
                : m.slice(0, 8));
            const u = decodificarUserReserveData(ru.dados);
            const usd = (c: bigint) => new Decimal(c.toString()).div(new Decimal(10).pow(dec)).mul(new Decimal(p.toString())).div(1e8);
            if (u.usadaComoGarantia && u.garantiaCrua > 0n && usd(u.garantiaCrua).greaterThan(gUsd)) {
                garantia = m; gUsd = usd(u.garantiaCrua);
            }
            if (u.dividaCrua > 0n && usd(u.dividaCrua).greaterThan(dUsd)) {
                divida = m; dUsd = usd(u.dividaCrua); dCrua = u.dividaCrua;
            }
        });
        await dormir(1600);
    }
    const conta = await call(POOL, '0xbf92857c' + DEVEDOR.replace(/^0x/, '').padStart(64, '0'));
    console.log(`POSIÇÃO REAL AGORA`);
    console.log(`  garantia ....... ${simbolo.get(garantia)} US$ ${gUsd.toFixed(2)}`);
    console.log(`  dívida ......... ${simbolo.get(divida)} US$ ${dUsd.toFixed(2)}`);
    console.log(`  saúde .......... ${new Decimal(pal(conta, 5).toString()).div('1e18').toFixed(6)}`);
    console.log(`  par do pool .... ${simbolo.get(garantia)}/${simbolo.get(divida)} — pool de venda ${POOLS.aerodrome.par}\n`);

    // O stub: mesmo preço em tudo, MENOS a garantia
    const forcados = precos.map((p) => p.ativo === garantia
        ? { ativo: p.ativo, preco: (p.preco * BigInt(Math.round((100 - QUEDA_PCT) * 100))) / 10000n }
        : p);
    const codigo = compilarOraculo(forcados);
    const antes = precos.find((p) => p.ativo === garantia)!.preco;
    const depois = forcados.find((p) => p.ativo === garantia)!.preco;
    console.log(`STUB DO ORÁCULO compilado (${(codigo.length - 2) / 2} bytes)`);
    console.log(`  ${simbolo.get(garantia)}: US$ ${(Number(antes) / 1e8).toFixed(2)} -> US$ ${(Number(depois) / 1e8).toFixed(2)}\n`);

    const override = { [oraculo]: { code: codigo } };

    // A saúde COM o stub, para provar que ela cruzou
    const contaForcada = await call(POOL, '0xbf92857c' + DEVEDOR.replace(/^0x/, '').padStart(64, '0'), override);
    const saudeForcada = new Decimal(pal(contaForcada, 5).toString()).div('1e18');
    console.log(`SAÚDE COM O STUB: ${saudeForcada.toFixed(6)}  ${saudeForcada.lessThan(1) ? '<<< LIQUIDÁVEL' : '(ainda saudável — aumente a queda)'}\n`);
    if (!saudeForcada.lessThan(1)) { console.log('Pare aqui: sem cruzar não há o que provar.'); return; }

    // O TIRO, com o piso impossível: o contrato executa a caçada INTEIRA e
    // reverte com LucroInsuficiente(obtido, exigido) carregando o lucro real.
    const quantoCobrir = dCrua / 2n;
    const pool = poolParaVender({ garantia, divida }, POOLS.aerodrome.endereco);
    console.log(`CHAMANDO cacar() DE VERDADE`);
    console.log(`  cobrindo ....... ${quantoCobrir} unidades cruas de ${simbolo.get(divida)} (metade da dívida)`);
    console.log(`  pool de venda .. ${pool}${pool === POOLS.aerodrome.endereco ? '' : '  (ZERO: moeda única, não vende)'}`);

    for (const [nome, endereco, tipo] of [['V1', V1, 'V1'], ['V2', V2, 'V2']] as const) {
        const dados = tipo === 'V1'
            ? codificarCacaV1({ garantia, divida, devedor: DEVEDOR, quantoCobrir, poolDeVenda: pool, lucroMinimo: PISO_IMPOSSIVEL })
            : codificarCacaV2({ garantia, divida, devedor: DEVEDOR, quantoCobrir, isStablePool: false, lucroMinimo: PISO_IMPOSSIVEL });
        const r = await rpc<string>('eth_call', [{ from: CONTA_BOT, to: endereco, data: dados }, 'latest', override]);
        const cru = typeof r.error?.data === 'string' ? r.error.data
            : (r.error?.data as { data?: string } | undefined)?.data ?? '0x';
        const leitura = lerRespostaDaCaca({ ok: r.error === undefined, dados: cru, mensagem: r.error?.message });
        const dec = casas.get(divida)!;
        const preco = forcados.find((p) => p.ativo === divida)!.preco;
        console.log(`\n--- ${nome}  ${endereco}`);
        console.log(`    desfecho ..... ${leitura.desfecho}`);
        if (leitura.desfecho === 'mediu') {
            const usd = new Decimal(leitura.lucroCru!.toString()).div(new Decimal(10).pow(dec)).mul(new Decimal(preco.toString())).div(1e8);
            console.log(`    >>> A CAÇADA INTEIRA EXECUTOU. Flash loan tomado, Aave aceitou a`);
            console.log(`        liquidação, garantia vendida, empréstimo pago.`);
            console.log(`    LUCRO MEDIDO . ${leitura.lucroCru} unidades cruas = US$ ${usd.toFixed(2)}`);
            console.log(`    destino ...... cofre ${COFRE} (transfer no fim de executeOperation)`);
        } else {
            console.log(`    erro ......... ${leitura.erro}`);
            console.log(`    dados crus ... ${cru.slice(0, 74)}`);
            const sel = cru.slice(0, 10);
            const nomes: Record<string, string> = {
                '0x930bb771': 'HealthFactorNotBelowThreshold() — a Aave diz que NÃO cruzou',
                [id('PoolSemLiquidez()').slice(0, 10)]: 'PoolSemLiquidez()',
                [id('NaoAutorizado()').slice(0, 10)]: 'NaoAutorizado()',
                [id('ChamadaInesperada()').slice(0, 10)]: 'ChamadaInesperada()',
                '0x08c379a0': 'Error(string)',
            };
            if (cru !== '0x') console.log(`    seletor ...... ${sel} ${nomes[sel] ?? '(não reconhecido)'}`);
        }
    }
})().catch((e) => { console.error('ERRO', e.message); process.exit(1); });
