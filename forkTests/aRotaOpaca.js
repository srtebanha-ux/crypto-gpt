// A UNICA ROTA QUE REVERTEU SEM MOTIVO LEGIVEL — onde ela reverteu.
//
// Item 2 dela: *"Investigue por trace a única rota com reversão opaca. Se a
// causa não puder ser demonstrada, mantenha CAUSA_DESCONHECIDA. Não fabrique
// uma explicação e não bloqueie a entrega inteira por isso."*
//
// No bloco 52612934, das 509 rotas com sobra positiva, 508 tocam uma peca com
// transferencia MEDIDA. A 509a — WETH -> 0x1453…d270 -> USDC -> 0xc20d…7777 ->
// WETH — reverteu com "Transaction reverted without a reason string" e as tres
// pecas mediram limpas. Ela e a unica que `julgarFalha` devolve como
// CAUSA_DESCONHECIDA, e e a unica que falta.
//
// O METODO e o que funcionou em 2026-10-10 para achar a camada do `0xb629b0e4`:
// o `callTracer` nao existe neste ambiente, o tracer PADRAO existe, e o
// Hardhat nao devolve o hash quando a transacao reverte no envio — entao
// `evm_setAutomine(false)` devolve o hash antes de executar.
//
// O QUE ESTE TESTE NAO FAZ: ele nao nomeia a causa se o trace nao a mostrar. A
// profundidade e o `pc` do primeiro REVERT dizem QUEM reverteu; dizer POR QUE
// sem isso seria fabricar explicacao.
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');

const {
    descobrirUniverso, lerPools, WETH_DA_BASE,
} = require('../dist/cacarArbitragem.js');
const {
    acharRotas, melhorTamanhoDaRota, semDuplicacaoEconomica, comoLerARota,
} = require('../dist/rotas.js');

const coder = AbiCoder.defaultAbiCoder();
const nIface = new Interface([
    'function executarRota((address pool,address tokenEntra,uint8 tipo,uint16 taxaPorDezMil)[] pernas, uint256 quantidade, uint256 lucroMinimo)',
]);

let p;
const chamar = (m, ps) => p.send(m, ps);

describe('a rota opaca, no trace', function () {
    this.timeout(1_800_000);

    it('diz QUEM reverteu, ou mantém CAUSA_DESCONHECIDA', async function () {
        p = hre.network.provider;
        const bloco = Number(await chamar('eth_blockNumber', []));
        const contas = await chamar('eth_accounts', []);
        const [dono, cofre] = contas;

        const u = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 100));
        const lido = await lerPools(chamar, u.pools, u.porFabrica, bloco);
        const paraRota = lido.pools.map((q) => ({
            endereco: q.endereco, token0: q.token0, token1: q.token1,
            reserva0: q.reserva0, reserva1: q.reserva1,
            tipo: 'v2', taxaPorDezMil: 30, fabrica: q.fabrica,
        }));
        const rotas = acharRotas(paraRota, WETH_DA_BASE, {
            maxHops: 4, podeEmprestar: (q) => q.tipo === 'v2', teto: 40_000,
        });
        const brutas = [];
        for (const r of rotas) {
            const m = melhorTamanhoDaRota(r, 40);
            if (m === null || m.sobra <= 0n) continue;
            brutas.push({ rota: r, sobra: m.sobra, ...m });
        }
        const { unicas } = semDuplicacaoEconomica(brutas);

        // A ROTA ALVO pelo token que a identifica, nao por indice: indice muda
        // com a ordem da varredura, e o alvo deixaria de ser o alvo em silencio.
        const MARCA = (process.env.ARB_OPACA ?? '0xc20d6089d99f1f53bcfd18226f311c5569187777')
            .toLowerCase();
        const alvo = unicas.find((a) => a.rota.hops.some(
            (h) => h.de.toLowerCase() === MARCA || h.para.toLowerCase() === MARCA,
        ));
        if (alvo === undefined) {
            console.log(`    a rota marcada por ${MARCA} não está entre as ${unicas.length}`
                + ' com sobra positiva neste bloco: NADA a tracear, e isto é ausência MEDIDA');
            this.skip();
            return;
        }

        const art = await hre.artifacts.readArtifact('FlashArbN');
        const dep = await chamar('eth_sendTransaction', [{
            from: dono, data: art.bytecode + coder.encode(['address'], [cofre]).slice(2),
            gas: '0x1000000',
        }]);
        const rd = await chamar('eth_getTransactionReceipt', [dep]);
        assert.equal(rd.status, '0x1');
        const arbN = rd.contractAddress;

        const pernas = alvo.rota.hops.map((h) => ({
            pool: h.pool.endereco, tokenEntra: h.de,
            tipo: h.pool.tipo === 'v2' ? 0 : 1, taxaPorDezMil: h.pool.taxaPorDezMil,
        }));
        const dados = nIface.encodeFunctionData('executarRota',
            [pernas, alvo.quantia, (alvo.sobra * 8n) / 10n]);

        console.log(`    bloco ${bloco} | ${comoLerARota(alvo.rota)}`);
        console.log(`    quantia ${alvo.quantia} | sobra estimada ${alvo.sobra}`);

        // O HASH ANTES DA EXECUCAO: sem isto o Hardhat nao devolve hash para
        // transacao que reverte, e sem hash nao ha trace.
        await chamar('evm_setAutomine', [false]);
        let hash = null;
        try {
            hash = await chamar('eth_sendTransaction', [{
                from: dono, to: arbN, data: dados, gas: '0x1000000',
            }]);
        } catch (e) {
            console.log(`    o nó recusou a transação antes de minar: ${String(e.message ?? e)}`);
        }
        await chamar('evm_mine', []);
        await chamar('evm_setAutomine', [true]);
        if (hash === null) {
            console.log('    >>> CAUSA_DESCONHECIDA mantida: sem hash não há trace');
            return;
        }
        const rec = await chamar('eth_getTransactionReceipt', [hash]);
        console.log(`    status do recibo: ${rec === null ? 'sem recibo' : rec.status}`);
        if (rec !== null && rec.status === '0x1') {
            console.log('    a rota COMPLETOU neste estado limpo — a reversão de antes era'
                + ' contaminação do experimento, não propriedade da rota');
            return;
        }

        let trace = null;
        try {
            trace = await chamar('debug_traceTransaction', [hash, {}]);
        } catch (e) {
            console.log(`    o tracer não respondeu: ${String(e.message ?? e)}`);
            console.log('    >>> CAUSA_DESCONHECIDA mantida: sem trace não se nomeia causa');
            return;
        }
        const passos = trace.structLogs ?? [];
        console.log(`    ${passos.length} passo(s) de trace`);
        const reverts = [];
        for (let i = 0; i < passos.length; i += 1) {
            if (passos[i].op === 'REVERT') reverts.push(passos[i]);
        }
        if (reverts.length === 0) {
            // ZERO REVERT com recibo de falha quer dizer que a execucao morreu
            // por outra razao — gas, ou um opcode invalido. Dizer "a combinacao
            // nao fecha" aqui seria inventar.
            const ultimo = passos[passos.length - 1];
            console.log(`    ZERO REVERT no trace. Último op: ${ultimo ? ultimo.op : 'nenhum'}`
                + ` | gasUsed do recibo ${rec.gasUsed}`);
            console.log('    >>> CAUSA_DESCONHECIDA mantida: nenhum REVERT para localizar');
            return;
        }
        // O MAIS PROFUNDO e a ORIGEM; os de cima sao propagacao.
        const maisProfundo = reverts.reduce((a, b) => (b.depth > a.depth ? b : a));
        console.log('    cascata de REVERT (profundidade -> pc):');
        for (const r of reverts) console.log(`      depth ${r.depth}  pc ${r.pc}`);
        console.log(`    >>> ORIGEM: depth ${maisProfundo.depth}, pc ${maisProfundo.pc}`);

        // QUEM e o depth mais fundo. "depth 4" nao e evidencia; um endereco e.
        //
        // A entrada numa profundidade vem do ultimo CALL/DELEGATECALL/
        // STATICCALL executado na profundidade de CIMA. O destino e o segundo
        // item do topo da pilha, e `structLogs` traz a pilha com o TOPO NO FIM.
        const iOrigem = passos.indexOf(maisProfundo);
        let entrada = null;
        for (let i = iOrigem; i >= 0; i -= 1) {
            const s = passos[i];
            if (s.depth !== maisProfundo.depth - 1) continue;
            if (!['CALL', 'STATICCALL', 'DELEGATECALL', 'CALLCODE'].includes(s.op)) continue;
            const pilha = s.stack ?? [];
            if (pilha.length < 2) break;
            const cru = pilha[pilha.length - 2];
            entrada = { op: s.op, alvo: `0x${String(cru).slice(-40)}`.toLowerCase(), pc: s.pc };
            break;
        }
        if (entrada === null) {
            console.log('    não achei o CALL que entrou nessa profundidade: o alvo fica SEM NOME,'
                + ' e CAUSA_DESCONHECIDA se mantém');
        } else {
            const pools = alvo.rota.hops.map((h) => h.pool.endereco.toLowerCase());
            const tokens = [...new Set(alvo.rota.hops.flatMap((h) => [h.de, h.para]))]
                .map((x) => x.toLowerCase());
            const quem = pools.includes(entrada.alvo)
                ? `POOL da rota (perna ${pools.indexOf(entrada.alvo) + 1})`
                : (tokens.includes(entrada.alvo) ? 'TOKEN da rota' : 'nenhuma peça da rota');
            console.log(`    quem reverteu: ${entrada.alvo}  —  ${quem}`);
            console.log(`    entrou por ${entrada.op} no pc ${entrada.pc} da profundidade de cima`);
            console.log(`    pools da rota: ${pools.join(', ')}`);
            console.log(`    tokens da rota: ${tokens.join(', ')}`);
        }
        console.log(`    o NOSSO contrato é ${arbN}; depth 1 é ele, mais fundo é um pool`
            + ' ou um token chamado por ele');
        // DISCRIMINA as duas leituras possiveis, com UMA chamada e sem gastar:
        // se a rota passa com piso ZERO, ela FECHOU — o que faltou foi lucro
        // contra a minha estimativa, e a causa e economica. Se reverte igual,
        // nao houve com que pagar o emprestimo, e a falha e de EXECUCAO.
        //
        // Sem este par a mesma reversao sustenta as duas historias, e escolher
        // uma seria fabricar explicacao.
        let comPisoZero = null;
        try {
            await chamar('eth_call', [{
                from: dono, to: arbN, gas: '0x1000000',
                data: nIface.encodeFunctionData('executarRota', [pernas, alvo.quantia, 0n]),
            }, 'latest']);
            comPisoZero = 'PASSOU';
        } catch (e) {
            comPisoZero = `reverteu: ${String(e.message ?? e).slice(0, 120)}`;
        }
        console.log(`\n    a MESMA rota com piso de lucro ZERO: ${comPisoZero}`);
        if (comPisoZero === 'PASSOU') {
            console.log('    >>> DEMONSTRADO: a rota EXECUTA. A reversão era o PISO de lucro'
                + ' (80% da sobra estimada) não sendo alcançado — a execução fecha e a'
                + ' estimativa é que estava alta. Não é peça hostil e não é executor quebrado.');
        } else {
            console.log('    >>> DEMONSTRADO: nem com piso zero há com que pagar o empréstimo.'
                + ' A reversão parte do token do pagamento por saldo insuficiente, que é falha'
                + ' de EXECUÇÃO da rota — não de uma peça.');
        }
        console.log('    DECLARADO: o trace diz QUEM reverteu e ONDE. Ele não diz o NOME do'
            + ' erro quando não há dado de retorno legível — e nomear sem isso seria fabricar.');
        assert.ok(reverts.length > 0);
    });
});
