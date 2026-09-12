// Arquivo: src/flashArbContract.test.ts
//
// Compila `contracts/FlashArb.sol` e EXECUTA o bytecode resultante numa EVM
// local, comparando a aritmética do contrato com a de `ammMath.ts`.
//
// Por que isso importa mais que os outros testes deste projeto: o scanner
// decide se um ciclo vale a pena, e o contrato executa. Se os dois calcularem a
// saída de um swap de forma diferente, o scanner aprova ciclos que a execução
// reverte — gás queimado — ou reprova ciclos bons. É a mesma classe de defeito
// que já apareceu aqui quando o motor ao vivo e o backtest liam parâmetros
// separados, só que desta vez com dinheiro on-chain.
//
// O teste roda o BYTECODE, não uma releitura do código-fonte: um erro de
// arredondamento introduzido pelo compilador ou pelo otimizador apareceria
// aqui, e não apareceria numa comparação de fórmulas no papel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { getAmountOut } from './ammMath';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

interface CompiledContract {
    evm: { bytecode: { object: string } };
}

/** Compila o arnês e devolve o bytecode de criação. */
function compilar(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const solc = require('solc');
    const fonte = readFileSync(join(__dirname, '..', 'contracts', 'MathHarness.sol'), 'utf8');
    const entrada = {
        language: 'Solidity',
        sources: { 'MathHarness.sol': { content: fonte } },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
    };
    const saida = JSON.parse(solc.compile(JSON.stringify(entrada))) as {
        errors?: Array<{ severity: string; formattedMessage: string }>;
        contracts: Record<string, Record<string, CompiledContract>>;
    };
    const erros = (saida.errors ?? []).filter((e) => e.severity === 'error');
    assert.equal(erros.length, 0, erros.map((e) => e.formattedMessage).join('\n'));
    return saida.contracts['MathHarness.sol'].MathHarness.evm.bytecode.object;
}

const palavra = (n: bigint) => n.toString(16).padStart(64, '0');

/** Sobe o contrato numa EVM local e devolve uma função que o chama. */
async function carregar(): Promise<(seletor: string, args: bigint[]) => Promise<bigint>> {
    const { EVM } = await import('@ethereumjs/evm');
    const { hexToBytes, bytesToHex, Address } = await import('@ethereumjs/util');
    const { keccak256 } = await import('ethereum-cryptography/keccak.js');

    const evm = await EVM.create();
    const deploy = await evm.runCall({ data: hexToBytes(`0x${compilar()}`) });
    assert.equal(deploy.execResult.exceptionError, undefined, 'o contrato precisa subir sem erro');

    // O código precisa MORAR num endereço: com `to` indefinido a EVM trata a
    // chamada como criação de contrato e executa o calldata como init code.
    const endereco = new Address(hexToBytes(`0x${'11'.repeat(20)}`));
    await evm.stateManager.putContractCode(endereco, deploy.execResult.returnValue);

    return async (assinatura: string, args: bigint[]) => {
        // keccak-256 do Ethereum, do pacote. O SHA3-256 do Node é outro
        // algoritmo e produziria seletores errados sem erro nenhum.
        const seletor = bytesToHex(keccak256(new Uint8Array(Buffer.from(assinatura, 'utf8')))).slice(0, 10);
        const r = await evm.runCall({
            to: endereco,
            data: hexToBytes(seletor + args.map(palavra).join('')),
        });
        assert.equal(r.execResult.exceptionError, undefined, `a chamada ${assinatura} reverteu`);
        return BigInt(bytesToHex(r.execResult.returnValue));
    };
}

/** Casos escolhidos para cobrir extremos, não só o meio da faixa. */
const CASOS: Array<[bigint, bigint, bigint]> = [
    [1000n, 1_000_000n, 2_000_000n],
    [1n, 1_000_000n, 2_000_000n], // menor entrada possível
    [500_000n, 1_000_000n, 2_000_000n], // metade da reserva: slippage enorme
    [123_456_789n, 987_654_321_000n, 555_555_555_000n],
    [10n ** 18n, 10n ** 24n, 10n ** 24n], // escala real de token de 18 casas
];

test('a saída de swap do CONTRATO bate exatamente com a do scanner', async () => {
    // Divergência aqui significa que o scanner aprova o que a execução reverte,
    // ou reprova o que daria lucro. Nos dois casos o erro sai como número
    // plausível, nunca como exceção.
    const chamar = await carregar();
    for (const [amountIn, reserveIn, reserveOut] of CASOS) {
        const doContrato = await chamar('amountOut(uint256,uint256,uint256)', [amountIn, reserveIn, reserveOut]);
        const doScanner = getAmountOut(new Decimal(amountIn.toString()), {
            reserveIn: new Decimal(reserveIn.toString()),
            reserveOut: new Decimal(reserveOut.toString()),
            feeFraction: new Decimal('0.003'),
        });
        assert.equal(
            doContrato.toString(),
            doScanner.floor().toString(),
            `divergência em amountIn=${amountIn}: contrato ${doContrato}, scanner ${doScanner}`,
        );
    }
});

test('o pagamento do empréstimo é arredondado PARA CIMA', async () => {
    // Um wei a menos e o pool reverte por violação da invariante K, queimando o
    // gás de uma arbitragem que era boa. Arredondar para cima custa um wei e
    // salva a transação.
    const chamar = await carregar();
    for (const [amountOut, reserveIn, reserveOut] of CASOS) {
        const aPagar = await chamar('amountIn(uint256,uint256,uint256)', [amountOut, reserveIn, reserveOut]);
        // Devolver `aPagar` tem que render ao menos `amountOut` de volta.
        const devolve = await chamar('amountOut(uint256,uint256,uint256)', [aPagar, reserveIn, reserveOut]);
        assert.ok(
            devolve >= amountOut,
            `pagar ${aPagar} devolveu ${devolve}, menos que os ${amountOut} emprestados — o pool reverteria`,
        );
    }
});

test('ida e volta pelo mesmo pool sempre PERDE — é a taxa, e ela é real', async () => {
    // Se um ciclo de ida e volta no mesmo pool desse lucro, a matemática estaria
    // errada e o scanner encontraria "arbitragem" infinita em qualquer pool.
    const chamar = await carregar();
    const reserva = 10n ** 24n;
    const entrada = 10n ** 20n;
    const ida = await chamar('amountOut(uint256,uint256,uint256)', [entrada, reserva, reserva]);
    const volta = await chamar('amountOut(uint256,uint256,uint256)', [ida, reserva, reserva]);
    assert.ok(volta < entrada, `ida e volta devolveu ${volta} contra ${entrada} — a taxa sumiu`);
});
