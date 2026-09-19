// Arquivo: src/cacadorCiclo.test.ts
//
// O ciclo INTEIRO do caçador, executado numa EVM local: empréstimo,
// liquidação, venda, devolução e lucro — com números conferidos na ponta.
//
// Por que isto vale mais que ler o contrato: entre "o código parece certo" e
// "o dinheiro sai na conta certa" cabe um erro de arredondamento, uma
// autorização faltando, um saldo lido na hora errada. Nada disso aparece na
// leitura; tudo aparece aqui, porque os dublês EXIGEM o que a Aave exigiria —
// o pool falso puxa o pagamento com `transferFrom` e reverte se a autorização
// faltar, igual ao de verdade.
//
// A conta que o teste confere, em uma linha:
//   pega X emprestado → paga X de dívida → recebe X×1,05 de garantia
//   → devolve X×1,0005 → sobra X×0,0495, e essa sobra tem de estar NO COFRE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { compilarContratos, type ContratoCompilado } from './compilarContrato';

const coder = AbiCoder.defaultAbiCoder();
const sel = (assinatura: string) => id(assinatura).slice(0, 10);

function compilarTudo(): Record<string, ContratoCompilado> {
    return compilarContratos(['CacadorDeLiquidacoes.sol', 'MocksDeTeste.sol']).contratos;
}

const DONO = `0x${'aa'.repeat(20)}`;
const COFRE = `0x${'dd'.repeat(20)}`;

interface Bancada {
    subir: (nome: string, tipos: string[], args: unknown[]) => Promise<string>;
    chamar: (para: string, dados: string, de?: string) => Promise<{ reverteu: boolean; retorno: string }>;
    exigir: (para: string, dados: string, de?: string) => Promise<string>;
}

async function montarBancada(): Promise<Bancada> {
    const { EVM } = await import('@ethereumjs/evm');
    const { hexToBytes, bytesToHex, Address } = await import('@ethereumjs/util');
    const evm = await EVM.create();
    const compilados = compilarTudo();

    const subir = async (nome: string, tipos: string[], args: unknown[]): Promise<string> => {
        const c = compilados[nome];
        assert.ok(c, `contrato ${nome} não compilou`);
        const argsHex = tipos.length > 0 ? coder.encode(tipos, args).slice(2) : '';
        const r = await evm.runCall({
            data: hexToBytes(`0x${c.evm.bytecode.object}${argsHex}`),
            caller: new Address(hexToBytes(DONO)),
            origin: new Address(hexToBytes(DONO)),
            gasLimit: 30_000_000n,
        });
        assert.equal(r.execResult.exceptionError, undefined, `${nome} não subiu`);
        // USAR O ENDEREÇO QUE A EVM CRIOU, e não copiar o código para um
        // endereço escolhido por mim.
        //
        // A primeira versão fazia a cópia, e o ciclo inteiro passou a rodar
        // sem mover um centavo — sem reverter, sem erro, emitindo o evento de
        // sucesso com lucro zero. A causa: o construtor roda no endereço que a
        // EVM criou e escreve a MEMÓRIA lá; copiar só o código deixa a memória
        // para trás.
        //
        // O caçador não sofreu porque `pool` e `cofre` são `immutable`, e
        // imutável mora dentro do código. Os dublês usam variáveis normais, e
        // chegaram do outro lado com ágio zero e prêmio zero — um pool que
        // empresta de graça e não paga bônus. Tudo batia, e nada acontecia.
        assert.ok(r.createdAddress, `${nome} não devolveu endereço`);
        return r.createdAddress.toString();
    };

    const chamar = async (para: string, dados: string, de = DONO) => {
        const r = await evm.runCall({
            to: new Address(hexToBytes(para)),
            caller: new Address(hexToBytes(de)),
            origin: new Address(hexToBytes(de)),
            data: hexToBytes(dados),
            gasLimit: 30_000_000n,
        });
        return {
            reverteu: r.execResult.exceptionError !== undefined,
            retorno: bytesToHex(r.execResult.returnValue),
        };
    };

    const exigir = async (para: string, dados: string, de = DONO) => {
        const r = await chamar(para, dados, de);
        assert.equal(r.reverteu, false, `chamada reverteu: ${r.retorno}`);
        return r.retorno;
    };

    return { subir, chamar, exigir };
}

const criar = (para: string, quanto: bigint) =>
    sel('criar(address,uint256)') + coder.encode(['address', 'uint256'], [para, quanto]).slice(2);
const saldoDe = (quem: string) =>
    sel('balanceOf(address)') + coder.encode(['address'], [quem]).slice(2);
const cacar = (a: {
    garantia: string; divida: string; devedor: string;
    quanto: bigint; poolVenda: string; lucroMinimo: bigint;
}) =>
    sel('cacar(address,address,address,uint256,address,uint256)') +
    coder
        .encode(
            ['address', 'address', 'address', 'uint256', 'address', 'uint256'],
            [a.garantia, a.divida, a.devedor, a.quanto, a.poolVenda, a.lucroMinimo],
        )
        .slice(2);

const ZERO = `0x${'00'.repeat(20)}`;
const VITIMA = `0x${'99'.repeat(20)}`;
const EMPRESTIMO = 1_000_000n;
/** 5% de ágio menos 0,05% de prêmio = 4,95% sobre o emprestado. */
const LUCRO_ESPERADO = 49_500n;

/** Monta o cenário feliz: um token só, pool com fundos, caçador pronto. */
async function cenario(bonusBps = 500n, premioBps = 5n) {
    const b = await montarBancada();
    const token = await b.subir('TokenFalso', ['string'], ['USDC']);
    const pool = await b.subir('PoolFalso', ['uint256', 'uint256'], [premioBps, bonusBps]);
    const cacador = await b.subir('CacadorDeLiquidacoes', ['address', 'address'], [pool, COFRE]);
    // O pool precisa ter com que emprestar E com que pagar o ágio.
    await b.exigir(token, criar(pool, EMPRESTIMO * 10n));
    return { ...b, token, pool, cacador };
}

test('o ciclo completo termina com o lucro EXATO no cofre', async () => {
    const c = await cenario();
    const antes = BigInt(await c.exigir(c.token, saldoDe(COFRE)));
    assert.equal(antes, 0n);

    await c.exigir(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 0n,
        }),
    );

    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), LUCRO_ESPERADO);
});

test('o caçador NÃO fica com nada — o contrato termina vazio', async () => {
    // Token parado no contrato é token exposto a quem tiver a chave. O ciclo
    // tem de varrer tudo para o cofre na mesma transação.
    const c = await cenario();
    await c.exigir(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 0n,
        }),
    );
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(c.cacador))), 0n);
});

test('o empréstimo é devolvido com prêmio — o pool termina mais rico', async () => {
    const c = await cenario();
    const antes = BigInt(await c.exigir(c.token, saldoDe(c.pool)));
    await c.exigir(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 0n,
        }),
    );
    const depois = BigInt(await c.exigir(c.token, saldoDe(c.pool)));
    // O pool emprestou X, recebeu X + prêmio, pagou X×1,05 de ágio e cobrou
    // X de dívida. Líquido: prêmio − ágio.
    assert.equal(depois - antes, -LUCRO_ESPERADO);
});

test('piso de lucro alto demais REVERTE tudo — e o cofre não recebe nada', async () => {
    // A garantia de segurança. Se o piso não fosse conferido dentro da
    // transação, uma estimativa errada do vigia viraria prejuízo real.
    const c = await cenario();
    const r = await c.chamar(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: LUCRO_ESPERADO + 1n,
        }),
    );
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('LucroInsuficiente(uint256,uint256)')), `veio ${r.retorno}`);
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), 0n, 'nada pode ter saído');
});

test('piso exatamente igual ao lucro passa — a comparação é >=, não >', async () => {
    const c = await cenario();
    await c.exigir(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: LUCRO_ESPERADO,
        }),
    );
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), LUCRO_ESPERADO);
});

test('posição saudável faz a transação inteira reverter, sem sobra', async () => {
    // O caso real de todo dia: o vigia viu uma oportunidade que já foi levada.
    // O custo disso tem de ser só o gás.
    const c = await cenario();
    await c.exigir(c.pool, sel('definirSaudavel(bool)') + coder.encode(['bool'], [true]).slice(2));
    const r = await c.chamar(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 0n,
        }),
    );
    assert.equal(r.reverteu, true);
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), 0n);
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(c.cacador))), 0n);
});

test('ágio menor que o prêmio do empréstimo REVERTE em vez de dar prejuízo', async () => {
    // Bônus de 0,01% contra prêmio de 0,05%: a caçada custaria mais do que
    // rende. Sem o piso, isso viraria uma perda silenciosa a cada tentativa.
    const c = await cenario(1n, 5n);
    const r = await c.chamar(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 1n,
        }),
    );
    assert.equal(r.reverteu, true);
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), 0n);
});

test('o lucro acompanha o ágio da moeda — 7,5% rende mais que 5%', async () => {
    // Os bônus medidos na Base foram 5%, 7,5% e 8,5%. O contrato não sabe
    // qual é: ele recebe o que a Aave entregar e mede na ponta.
    const c = await cenario(750n, 5n);
    await c.exigir(
        c.cacador,
        cacar({
            garantia: c.token, divida: c.token, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: ZERO, lucroMinimo: 0n,
        }),
    );
    // 7,5% − 0,05% = 7,45%
    assert.equal(BigInt(await c.exigir(c.token, saldoDe(COFRE))), 74_500n);
});

// ---------------------------------------------------------------------------
// O caminho com TROCA: garantia diferente da dívida.
//
// É o caso comum de verdade — quem deve USDC quase sempre deu ETH em garantia.
// O contrato recebe o ETH com ágio, precisa vendê-lo para ter USDC de volta, e
// é na venda que mora o risco: a taxa do pool e o deslizamento comem parte do
// ágio, e se comerem tudo a caçada vira prejuízo. Por isso o piso de lucro é
// conferido DEPOIS da venda, e não antes.
// ---------------------------------------------------------------------------

/** A mesma conta do contrato, em TypeScript, para conferir de fora. */
function saidaDoSwap(entrada: bigint, reservaEntrada: bigint, reservaSaida: bigint): bigint {
    const comTaxa = entrada * 997n;
    return (comTaxa * reservaSaida) / (reservaEntrada * 1000n + comTaxa);
}

const RESERVA = 10n ** 12n;

/** Cenário com dois tokens e um par para vender a garantia. */
async function cenarioComTroca(bonusBps = 500n, premioBps = 5n, reserva = RESERVA) {
    const b = await montarBancada();
    const garantia = await b.subir('TokenFalso', ['string'], ['WETH']);
    const divida = await b.subir('TokenFalso', ['string'], ['USDC']);
    const pool = await b.subir('PoolFalso', ['uint256', 'uint256'], [premioBps, bonusBps]);
    const par = await b.subir(
        'ParFalso',
        ['address', 'address', 'uint112', 'uint112'],
        [garantia, divida, reserva, reserva],
    );
    // O pool precisa de dívida para emprestar e de garantia para pagar o ágio.
    await b.exigir(divida, criar(pool, EMPRESTIMO * 10n));
    await b.exigir(garantia, criar(pool, EMPRESTIMO * 10n));
    // O par precisa ter de fato o que as reservas dizem.
    await b.exigir(garantia, criar(par, reserva));
    await b.exigir(divida, criar(par, reserva));
    return { ...b, garantia, divida, pool, par };
}

test('com troca de moeda o lucro é o ágio MENOS a taxa do pool e o deslizamento', async () => {
    const c = await cenarioComTroca();

    // 5% de ágio sobre o emprestado.
    const garantiaRecebida = (EMPRESTIMO * 10_500n) / 10_000n;
    // Vender essa garantia no par, com a taxa de 0,3% e o deslizamento.
    const dividaDeVolta = saidaDoSwap(garantiaRecebida, RESERVA, RESERVA);
    const aDevolver = EMPRESTIMO + (EMPRESTIMO * 5n) / 10_000n;
    const esperado = dividaDeVolta - aDevolver;

    const cacador = await c.subir('CacadorDeLiquidacoes', ['address', 'address'], [c.pool, COFRE]);
    await c.exigir(
        cacador,
        cacar({
            garantia: c.garantia, divida: c.divida, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: c.par, lucroMinimo: 0n,
        }),
    );

    assert.equal(BigInt(await c.exigir(c.divida, saldoDe(COFRE))), esperado);
    // E o ágio de 5% encolheu de verdade: a venda custou alguma coisa.
    assert.ok(esperado < 49_500n, `a troca tem de custar algo: ${esperado}`);
    assert.ok(esperado > 40_000n, `mas não pode comer quase tudo: ${esperado}`);
});

test('a garantia recebida some toda na venda — nada fica parado no contrato', async () => {
    const c = await cenarioComTroca();
    const cacador = await c.subir('CacadorDeLiquidacoes', ['address', 'address'], [c.pool, COFRE]);
    await c.exigir(
        cacador,
        cacar({
            garantia: c.garantia, divida: c.divida, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: c.par, lucroMinimo: 0n,
        }),
    );
    assert.equal(BigInt(await c.exigir(c.garantia, saldoDe(cacador))), 0n, 'garantia parada');
    assert.equal(BigInt(await c.exigir(c.divida, saldoDe(cacador))), 0n, 'dívida parada');
});

test('par raso REVERTE: o deslizamento come o ágio inteiro', async () => {
    // O risco de verdade deste caminho. Um pool pequeno devolve muito menos do
    // que a garantia vale, e sem o piso isso viraria prejuízo a cada caçada —
    // com a transação passando e o cofre encolhendo.
    const c = await cenarioComTroca(500n, 5n, 2_000_000n);
    const cacador = await c.subir('CacadorDeLiquidacoes', ['address', 'address'], [c.pool, COFRE]);
    const r = await c.chamar(
        cacador,
        cacar({
            garantia: c.garantia, divida: c.divida, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: c.par, lucroMinimo: 1n,
        }),
    );
    assert.equal(r.reverteu, true, 'par raso tem de reverter');
    assert.equal(BigInt(await c.exigir(c.divida, saldoDe(COFRE))), 0n);
});

test('a ordem dos tokens no par não muda o resultado', async () => {
    // O contrato pergunta ao par quem é `token0` e inverte as reservas
    // conforme. Trocar a ordem e obter outro lucro seria o sinal de que essa
    // inversão está errada — e o erro sairia como número plausível, nunca
    // como exceção.
    const b = await montarBancada();
    const garantia = await b.subir('TokenFalso', ['string'], ['WETH']);
    const divida = await b.subir('TokenFalso', ['string'], ['USDC']);
    const pool = await b.subir('PoolFalso', ['uint256', 'uint256'], [5n, 500n]);
    // Aqui a DÍVIDA é o token0, ao contrário do outro cenário.
    const par = await b.subir(
        'ParFalso',
        ['address', 'address', 'uint112', 'uint112'],
        [divida, garantia, RESERVA, RESERVA],
    );
    await b.exigir(divida, criar(pool, EMPRESTIMO * 10n));
    await b.exigir(garantia, criar(pool, EMPRESTIMO * 10n));
    await b.exigir(garantia, criar(par, RESERVA));
    await b.exigir(divida, criar(par, RESERVA));
    const cacador = await b.subir('CacadorDeLiquidacoes', ['address', 'address'], [pool, COFRE]);

    await b.exigir(
        cacador,
        cacar({
            garantia, divida, devedor: VITIMA,
            quanto: EMPRESTIMO, poolVenda: par, lucroMinimo: 0n,
        }),
    );

    const garantiaRecebida = (EMPRESTIMO * 10_500n) / 10_000n;
    const esperado = saidaDoSwap(garantiaRecebida, RESERVA, RESERVA) - (EMPRESTIMO + 500n);
    assert.equal(BigInt(await b.exigir(divida, saldoDe(COFRE))), esperado);
});
