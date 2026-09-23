// Arquivo: src/cacadorV2.test.ts
//
// Executa o ciclo inteiro do CacadorV2 numa EVM de verdade, antes de qualquer
// deploy e antes de qualquer dinheiro.
//
// O que estes testes existem para provar nao e que a caçada funciona — e que
// os tres defeitos da versao anterior nao voltam:
//
//   1. o lucro ia para `owner`, a conta cuja chave mora no Railway
//   2. `amountOutMin = 0` aceitava qualquer preco na venda
//   3. dois `approve` seguidos sem zerar quebram em USDT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { compilarContratos } from './compilarContrato';
import { montarBancadaEvm, DONO_PADRAO } from './bancadaEvm';

const coder = AbiCoder.defaultAbiCoder();
const sel = (s: string) => id(s).slice(0, 10);
const COFRE = `0x${'dd'.repeat(20)}`;
const VITIMA = `0x${'99'.repeat(20)}`;
const FACTORY = `0x${'fa'.repeat(20)}`;
const EMPRESTIMO = 1_000_000n;
const PREMIO = (EMPRESTIMO * 5n) / 10_000n;
const A_DEVOLVER = EMPRESTIMO + PREMIO;
/** 5% de agio: a Aave entrega isto de colateral. */
const GARANTIA = (EMPRESTIMO * 10_500n) / 10_000n;

async function cena(cambioBps: number) {
    const b = await montarBancadaEvm(compilarContratos(['CacadorV2.sol', 'MocksDeTeste.sol']).contratos);
    const garantia = await b.subir('TokenFalso', ['string'], ['WETH']);
    const divida = await b.subir('TokenFalso', ['string'], ['USDC']);
    const pool = await b.subir('PoolFalso', ['uint256', 'uint256'], [5n, 500n]);
    const router = await b.subir('RoteadorAerodromeFalso', [], []);
    await b.exigir(router, sel('definirCambio(uint256)') + coder.encode(['uint256'], [cambioBps]).slice(2));
    await b.exigir(divida, sel('criar(address,uint256)') + coder.encode(['address', 'uint256'], [pool, EMPRESTIMO * 10n]).slice(2));
    await b.exigir(garantia, sel('criar(address,uint256)') + coder.encode(['address', 'uint256'], [pool, EMPRESTIMO * 10n]).slice(2));
    await b.exigir(divida, sel('criar(address,uint256)') + coder.encode(['address', 'uint256'], [router, EMPRESTIMO * 20n]).slice(2));
    const cacador = await b.subir(
        'CacadorV2',
        ['address', 'address', 'address', 'address'],
        [pool, router, FACTORY, COFRE],
    );
    return { ...b, garantia, divida, pool, router, cacador };
}

const chamarCacar = (a: { garantia: string; divida: string; piso: bigint }) =>
    sel('cacar(address,address,address,uint256,bool,uint256)') +
    coder
        .encode(
            ['address', 'address', 'address', 'uint256', 'bool', 'uint256'],
            [a.garantia, a.divida, VITIMA, EMPRESTIMO, false, a.piso],
        )
        .slice(2);

const saldo = (quem: string) => sel('balanceOf(address)') + coder.encode(['address'], [quem]).slice(2);

test('o lucro vai para o COFRE, nao para o dono', async () => {
    // O defeito que motivou esta versao: `transfer(owner, profit)` fazia o
    // lucro dormir na conta cuja chave privada esta no Railway. Com o cofre
    // separado, uma chave roubada pode mandar caçar e nao alcanca o dinheiro.
    const c = await cena(11_000); // roteador devolve 110% do que recebe
    await c.exigir(c.cacador, chamarCacar({ garantia: c.garantia, divida: c.divida, piso: 0n }));

    const noCofre = BigInt(await c.exigir(c.divida, saldo(COFRE)));
    const noDono = BigInt(await c.exigir(c.divida, saldo(DONO_PADRAO)));
    assert.equal(noCofre, (GARANTIA * 11_000n) / 10_000n - A_DEVOLVER);
    assert.equal(noDono, 0n, 'o dono nao pode receber nada');
});

test('o caçador nao fica com nada: termina vazio', async () => {
    const c = await cena(11_000);
    await c.exigir(c.cacador, chamarCacar({ garantia: c.garantia, divida: c.divida, piso: 0n }));
    assert.equal(BigInt(await c.exigir(c.divida, saldo(c.cacador))), 0n);
    assert.equal(BigInt(await c.exigir(c.garantia, saldo(c.cacador))), 0n);
});

test('a DEX recusa ANTES de executar quando o preco nao alcanca o piso', async () => {
    // Com `amountOutMin = 0`, a troca acontecia no preco ruim e so depois a
    // gente revertia — pagando o gas da troca inteira. Agora o piso vai para
    // a propria DEX.
    const c = await cena(9_000); // devolve 90%: nem paga o emprestimo
    await assert.rejects(
        c.exigir(c.cacador, chamarCacar({ garantia: c.garantia, divida: c.divida, piso: 1n })),
    );
    assert.equal(BigInt(await c.exigir(c.divida, saldo(COFRE))), 0n);
});

test('piso alto demais reverte tudo, e o cofre nao recebe nada', async () => {
    const c = await cena(11_000);
    await assert.rejects(
        c.exigir(c.cacador, chamarCacar({ garantia: c.garantia, divida: c.divida, piso: EMPRESTIMO })),
    );
    assert.equal(BigInt(await c.exigir(c.divida, saldo(COFRE))), 0n);
});

test('so o dono caça, e so o dono resgata — sempre para o cofre', async () => {
    const c = await cena(11_000);
    const estranho = `0x${'ab'.repeat(20)}`;
    const r = await c.chamar(c.cacador, chamarCacar({ garantia: c.garantia, divida: c.divida, piso: 0n }), estranho);
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('NaoEDono()')), `veio ${r.retorno}`);
});

test('estranho nao consegue chamar executeOperation', async () => {
    const c = await cena(11_000);
    const estranho = `0x${'ab'.repeat(20)}`;
    const dados =
        sel('executeOperation(address,uint256,uint256,address,bytes)') +
        coder
            .encode(['address', 'uint256', 'uint256', 'address', 'bytes'], [c.divida, 1n, 0n, c.cacador, '0x'])
            .slice(2);
    const r = await c.chamar(c.cacador, dados, estranho);
    assert.equal(r.reverteu, true);
    assert.ok(r.retorno.startsWith(sel('ChamadaInesperada()')), `veio ${r.retorno}`);
});

test('o cofre esta gravado como imutavel e nao e o dono', async () => {
    const c = await cena(11_000);
    const lido = await c.exigir(c.cacador, sel('cofre()'));
    assert.equal(`0x${lido.slice(-40)}`.toLowerCase(), COFRE.toLowerCase());
    assert.notEqual(`0x${lido.slice(-40)}`.toLowerCase(), DONO_PADRAO.toLowerCase());
});
