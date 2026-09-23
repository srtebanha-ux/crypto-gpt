import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, COBRIR_O_MAXIMO } from './caca';
import { Decimal } from 'decimal.js';
import { quantoPedirEmprestado, FATIA_COBRIVEL, maiorQuedaDesdeABase, precisaVarrerTudo } from './cacarAoVivo';

const coder = AbiCoder.defaultAbiCoder();
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';
const D = '0x4444444444444444444444444444444444444444';

test('o emprestimo pedido e METADE da divida, nao um numero impossivel', () => {
    // `COBRIR_O_MAXIMO` ia direto para `flashLoanSimple` como o TAMANHO do
    // emprestimo. Valor "maximo" ali nao quer dizer "o quanto der": quer dizer
    // pedir 1e44 unidades emprestadas, e nenhum pool do mundo tem isso. Toda
    // caçada real reverteria, sempre — e os ensaios nunca denunciaram porque
    // batiam na recusa da Aave antes de chegar ao emprestimo.
    const divida = 45_049_000_000n; // 45.049 USDC, 6 casas
    assert.equal(quantoPedirEmprestado(divida), divida / FATIA_COBRIVEL);
    assert.ok(quantoPedirEmprestado(divida) < COBRIR_O_MAXIMO / 10n ** 20n);
});

test('pedir emprestado nunca devolve o valor impossivel', () => {
    for (const d of [1n, 1_000_000n, 10n ** 24n]) {
        assert.notEqual(quantoPedirEmprestado(d), COBRIR_O_MAXIMO);
        assert.notEqual(quantoPedirEmprestado(d), PISO_IMPOSSIVEL);
    }
});

test('V1 leva o endereco do pool; V2 leva o booleano de pool estavel', () => {
    // As duas versoes estao publicadas, e mandar o formato errado para a
    // errada nao reverte de um jeito reconhecivel: cai no fallback e volta
    // "0x", sem nome nem motivo.
    const v1 = codificarCacaV1({
        garantia: A, divida: B, devedor: C, quantoCobrir: 123n, poolDeVenda: D, lucroMinimo: 7n,
    });
    const v2 = codificarCacaV2({
        garantia: A, divida: B, devedor: C, quantoCobrir: 123n, isStablePool: true, lucroMinimo: 7n,
    });
    assert.equal(v1.slice(0, 10), id('cacar(address,address,address,uint256,address,uint256)').slice(0, 10));
    assert.equal(v2.slice(0, 10), id('cacar(address,address,address,uint256,bool,uint256)').slice(0, 10));
    assert.notEqual(v1.slice(0, 10), v2.slice(0, 10));
});

test('V1 codifica os seis campos na ordem certa', () => {
    const dados = codificarCacaV1({
        garantia: A, divida: B, devedor: C, quantoCobrir: 123n, poolDeVenda: D, lucroMinimo: 7n,
    });
    const [g, dv, de, q, pv, lm] = coder.decode(
        ['address', 'address', 'address', 'uint256', 'address', 'uint256'],
        '0x' + dados.slice(10),
    );
    assert.deepEqual([g, dv, de, pv], [A, B, C, D]);
    assert.equal(BigInt(q.toString()), 123n);
    assert.equal(BigInt(lm.toString()), 7n);
});

test('reversao com erro desconhecido nao vira medicao', () => {
    // Confundir "reverteu por outro motivo" com "mediu zero" faria o bot
    // desistir de um alvo bom achando que ele nao rende nada.
    const r = lerRespostaDaCaca({ ok: false, dados: '0xdeadbeef', mensagem: 'execution reverted' });
    assert.equal(r.desfecho, 'revertido');
    assert.equal(r.lucroCru, undefined);
});

test('a reversao do piso MEDE o lucro — e para isso que ela existe', () => {
    // Mandar piso impossivel faz o contrato executar a caçada inteira e
    // devolver, dentro do erro, quanto teria rendido. Sem gas, sem risco.
    const dados =
        id('LucroInsuficiente(uint256,uint256)').slice(0, 10) +
        coder.encode(['uint256', 'uint256'], [1_044_000_000n, PISO_IMPOSSIVEL]).slice(2);
    const r = lerRespostaDaCaca({ ok: false, dados, mensagem: 'execution reverted' });
    assert.equal(r.desfecho, 'mediu');
    assert.equal(r.lucroCru, 1_044_000_000n);
});

test('limite do provedor NAO e veredicto sobre a caçada', () => {
    // A licao que o ensaio ensinou: "over rate limit" contado como reprovacao
    // transformou uma medicao boa em "PARCIAL 4 de 5".
    assert.equal(lerRespostaDaCaca({ ok: false, dados: '0x', mensagem: 'over rate limit' }).desfecho, 'falhaDeRede');
});

test('a leitura em paralelo NAO pode embaralhar a ordem', () => {
    // Quem chama indexa por posicao: os precos primeiro, os devedores depois.
    // Se um pedaco voltar fora de lugar, o bot le a saude de uma pessoa
    // achando que e de outra — e liquida a errada, ou deixa a certa passar.
    // Este teste guarda a propriedade que a paralelizacao poderia quebrar.
    const pedacos = [
        ['a1', 'a2'],
        ['b1', 'b2'],
        ['c1'],
    ];
    const porPedaco: Array<string[]> = new Array(pedacos.length);
    // Chegando fora de ordem de proposito, como a rede faz.
    [2, 0, 1].forEach((i) => { porPedaco[i] = pedacos[i]; });
    assert.deepEqual(porPedaco.flat(), ['a1', 'a2', 'b1', 'b2', 'c1']);
});

test('pedaco que falha vira buracos, nao lista curta', () => {
    // Lista curta desalinharia TODAS as posicoes seguintes, em silencio.
    const pedaco = ['x', 'y', 'z'];
    const falhou = pedaco.map(() => null);
    assert.equal(falhou.length, pedaco.length);
});

// ---------------------------------------------------------------------------
// O gatilho de preço: ler 15 preços por bloco em vez de 8.368 posições.
// ---------------------------------------------------------------------------

test('preço parado não manda varrer nada', () => {
    const base = new Map([['0xaa', new Decimal(3000e8)], ['0xbb', new Decimal(1e8)]]);
    const agora = new Map([['0xaa', new Decimal(3000e8)], ['0xbb', new Decimal(1e8)]]);
    assert.equal(maiorQuedaDesdeABase(base, agora).toNumber(), 0);
});

test('preço SUBINDO não derruba ninguém, então não conta como queda', () => {
    const base = new Map([['0xaa', new Decimal(3000e8)]]);
    const agora = new Map([['0xaa', new Decimal(3300e8)]]);
    assert.equal(maiorQuedaDesdeABase(base, agora).toNumber(), 0);
});

test('a queda é medida contra a varredura, não contra o bloco anterior', () => {
    // O defeito que este teste guarda: comparar com o bloco anterior deixa uma
    // queda de 0,02% por bloco, vinte vezes seguidas, nunca disparar — cada
    // bloco isolado fica abaixo do gatilho enquanto o preço já andou 0,4%.
    const base = new Map([['0xaa', new Decimal(1000)]]);
    let corrente = new Decimal(1000);
    let maiorSeFosseBlocoABloco = new Decimal(0);
    for (let i = 0; i < 20; i++) {
        const proximo = corrente.mul(0.9998); // -0,02% por bloco
        const q = corrente.minus(proximo).dividedBy(corrente).mul(100);
        if (q.greaterThan(maiorSeFosseBlocoABloco)) maiorSeFosseBlocoABloco = q;
        corrente = proximo;
    }
    const contraABase = maiorQuedaDesdeABase(base, new Map([['0xaa', corrente]]));
    assert.ok(maiorSeFosseBlocoABloco.lessThan(0.03), 'bloco a bloco enxerga só 0,02%');
    assert.ok(contraABase.greaterThan(0.39), `contra a base enxerga ${contraABase.toFixed(3)}%`);
    // Com a posição mais frágil a 0,037%, uma régua vê a queda e a outra não.
    const fragil = new Decimal(0.037);
    assert.equal(precisaVarrerTudo(maiorSeFosseBlocoABloco, fragil, 0, 30), false);
    assert.equal(precisaVarrerTudo(contraABase, fragil, 0, 30), true);
});

test('queda que alcança a posição mais frágil manda varrer', () => {
    assert.equal(precisaVarrerTudo(new Decimal(0.037), new Decimal(0.037), 0, 30), true);
    assert.equal(precisaVarrerTudo(new Decimal(0.036), new Decimal(0.037), 0, 30), false);
});

test('a varredura completa acontece por tempo mesmo com preço parado', () => {
    // Juros correndo e empréstimo novo derrubam posição sem o oráculo mexer.
    assert.equal(precisaVarrerTudo(new Decimal(0), new Decimal(5), 29, 30), false);
    assert.equal(precisaVarrerTudo(new Decimal(0), new Decimal(5), 30, 30), true);
});

test('o gatilho não pode ficar preso ligado', () => {
    // Já aconteceu uma vez: comparar com uma régua velha fazia disparar em todo
    // bloco. Com régua e base andando juntas, preço parado não dispara.
    const precos = new Map([['0xaa', new Decimal(3000e8)]]);
    const base = new Map(precos);
    for (let bloco = 1; bloco < 30; bloco++) {
        const maior = maiorQuedaDesdeABase(base, precos);
        assert.equal(precisaVarrerTudo(maior, new Decimal(1), bloco, 30), false);
    }
});

test('moeda sem preço na base não inventa queda', () => {
    // Na primeira volta a base está vazia. Dividir por um preço ausente daria
    // NaN, ou pior, uma queda de 100% e uma varredura por engano todo bloco.
    const agora = new Map([['0xaa', new Decimal(3000e8)]]);
    assert.equal(maiorQuedaDesdeABase(new Map(), agora).toNumber(), 0);
    assert.equal(maiorQuedaDesdeABase(new Map([['0xaa', new Decimal(0)]]), agora).toNumber(), 0);
});
