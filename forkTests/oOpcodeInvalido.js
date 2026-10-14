// POR QUE OS CANDIDATOS 0 E 1 DERAM `invalid opcode`.
//
// A dona do bot recusou a atribuicao automatica: *"Investigue por trace as duas
// reversoes `invalid opcode` sem atribui-las automaticamente a taxa de
// transferencia."* Esta certo — a taxa explica o `UniswapV2: K` do candidato 2,
// e `invalid opcode` e outra coisa: ele e o que a EVM faz ao encontrar um byte
// que nao e instrucao, ou um `assert` do Solidity < 0.8 (opcode 0xfe).
const assert = require('node:assert/strict');
const { AbiCoder, Interface, id } = require('ethers');
const {
    descobrirUniverso, lerPools, montarCandidatos, decidir, precoDoGasWei,
} = require('../dist/cacarArbitragem.js');

const coder = AbiCoder.defaultAbiCoder();
const sel = (a) => id(a).slice(0, 10);
const arbIface = new Interface([
    'function executarArbitragem(address poolEmprestimo, address poolVenda, address tokenEmprestado, uint256 quantidade, uint256 lucroMinimo)',
]);
let p;
const chamar = (m, ps) => p.send(m, ps);

describe('a causa do `invalid opcode`, pelo trace', function () {
    this.timeout(900_000);

    it('traça a execução e aponta O CONTRATO e o PASSO que falhou', async function () {
        p = hre.network.provider;
        const bloco = Number(await chamar('eth_blockNumber', []));
        const [dono] = await chamar('eth_accounts', []);
        const art = await hre.artifacts.readArtifact('FlashArb');
        const recD = await chamar('eth_sendTransaction', [{ from: dono, data: art.bytecode, gas: '0x1000000' }]);
        const arb = (await chamar('eth_getTransactionReceipt', [recD])).contractAddress;

        const universo = await descobrirUniverso(chamar, Number(process.env.ARB_POOLS ?? 150));
        const lido = await lerPools(chamar, universo.pools, universo.porFabrica, bloco);
        const gasWei = await precoDoGasWei(chamar);
        const estimados = montarCandidatos(lido.pools).slice(0, 400)
            .map((c) => decidir(c, gasWei, Date.now())).filter((d) => d.aprovado);
        if (estimados.length === 0) { console.log('    nenhum ESTIMADO POSITIVO'); this.skip(); return; }

        // `evm_setAutomine(false)` devolve o hash ANTES de executar: sem isso o
        // Hardhat nao da o hash de uma transacao que reverte, e sem hash nao ha
        // trace. E o mesmo truque do `forkTests/ondeReverteu.js`.
        await chamar('evm_setAutomine', [false]);
        let relatados = 0;
        for (const d of estimados.slice(0, 2)) {
            const c = d.candidato;
            const piso = (c.sobra * 8n) / 10n;
            const hash = await chamar('eth_sendTransaction', [{
                from: dono, to: arb, gas: '0x1000000',
                data: arbIface.encodeFunctionData('executarArbitragem',
                    [c.emprestimo.endereco, c.venda.endereco, c.T, c.quantia, piso]),
            }]);
            await chamar('evm_mine', []);
            const rec = await chamar('eth_getTransactionReceipt', [hash]);
            let tr = null;
            try { tr = await chamar('debug_traceTransaction', [hash, {}]); } catch (e) {
                console.log(`    trace indisponível: ${String(e.message ?? e).slice(0, 120)}`);
            }
            console.log(`\n    rota: empréstimo ${c.emprestimo.endereco} -> venda ${c.venda.endereco}`);
            console.log(`    token emprestado ${c.T} | status ${rec?.status}`);
            if (tr === null || !Array.isArray(tr.structLogs)) { relatados += 1; continue; }

            // O ULTIMO opcode executado, e em que PROFUNDIDADE: e isso que diz
            // de QUEM e o `invalid opcode` — do nosso contrato, do pool, ou do
            // token. Atribuir sem isto seria suposicao.
            const logs = tr.structLogs;
            const ultimo = logs[logs.length - 1];
            const invalidos = logs.filter((l) => l.op === 'INVALID' || l.op === 'opcode 0xfe');
            // A pilha de chamadas no instante da falha: cada CALL/DELEGATECALL
            // aberto e um contrato dentro do caminho.
            const alvos = [];
            for (const l of logs) {
                if (['CALL', 'STATICCALL', 'DELEGATECALL'].includes(l.op) && Array.isArray(l.stack)) {
                    const a = l.stack[l.stack.length - 2];
                    if (typeof a === 'string') alvos.push(`0x${a.slice(-40)}`);
                }
            }
            const ultimosAlvos = [...new Set(alvos.slice(-6))];
            console.log(`    passos ${logs.length} | gasUsed ${rec?.gasUsed}`);
            console.log(`    último opcode: ${ultimo?.op} em depth ${ultimo?.depth} pc ${ultimo?.pc}`);
            console.log(`    opcodes INVALID encontrados: ${invalidos.length}`
                + (invalidos.length > 0
                    ? ` (primeiro em depth ${invalidos[0].depth}, pc ${invalidos[0].pc})`
                    : ''));
            console.log(`    últimos contratos chamados: ${ultimosAlvos.join(', ')}`);
            // A CONCLUSAO sai do dado: profundidade > 1 no instante do INVALID
            // significa que NAO foi o nosso contrato.
            if (invalidos.length > 0) {
                const dp = invalidos[0].depth;
                console.log(`    >>> o INVALID aconteceu em depth ${dp}: `
                    + (dp > 1
                        ? 'NÃO é o nosso contrato — é um contrato chamado por ele (pool ou token)'
                        : 'é o NOSSO contrato, e isso seria defeito nosso'));
            } else {
                console.log('    >>> nenhum opcode INVALID no trace: a reversão veio por REVERT '
                    + 'normal, e o "invalid opcode" era a mensagem do runner, não a causa');
            }
            relatados += 1;
        }
        await chamar('evm_setAutomine', [true]);
        assert.ok(relatados > 0, 'nada foi traçado');
    });
});
