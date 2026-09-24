import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, COBRIR_O_MAXIMO, julgarCofre, podeCacarComDinheiroReal, SELETOR_COFRE, SELETOR_DONO } from './caca';
import { Decimal } from 'decimal.js';
import { quantoPedirEmprestado, FATIA_COBRIVEL, maiorQuedaDesdeABase, qualVarredura, custoMensalEmCUs, repartirPorFragilidade } from './cacarAoVivo';

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

const HORA = 60 * 60 * 1000;

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
    assert.equal(qualVarredura(maiorSeFosseBlocoABloco, fragil, 25, 0, HORA), 'nenhuma');
    assert.equal(qualVarredura(contraABase, fragil, 25, 0, HORA), 'quentes');
});

test('queda que alcança a posição mais frágil manda reler a lista quente', () => {
    assert.equal(qualVarredura(new Decimal(0.037), new Decimal(0.037), 25, 0, HORA), 'quentes');
    assert.equal(qualVarredura(new Decimal(0.036), new Decimal(0.037), 25, 0, HORA), 'nenhuma');
});

test('queda que passa da margem quente força a varredura COMPLETA', () => {
    // O buraco que este teste fecha: quem está longe de cair não está na lista
    // quente. Um tombo de 30% alcança gente de fora dela, e responder lendo só
    // os que já estavam por um fio seria deixar passar justamente os que o
    // tombo derrubou.
    assert.equal(qualVarredura(new Decimal(30), new Decimal(0.037), 25, 0, HORA), 'completa');
    assert.equal(qualVarredura(new Decimal(24), new Decimal(0.037), 25, 0, HORA), 'quentes');
});

test('a varredura completa acontece por tempo mesmo com preço parado', () => {
    // Juros correndo e empréstimo novo derrubam posição sem o oráculo mexer.
    assert.equal(qualVarredura(new Decimal(0), new Decimal(5), 25, HORA - 1, HORA), 'nenhuma');
    assert.equal(qualVarredura(new Decimal(0), new Decimal(5), 25, HORA, HORA), 'completa');
});

test('o gatilho não pode ficar preso ligado', () => {
    // Já aconteceu uma vez: comparar com uma régua velha fazia disparar em todo
    // bloco. Com régua e base andando juntas, preço parado não dispara.
    const precos = new Map([['0xaa', new Decimal(3000e8)]]);
    const base = new Map(precos);
    for (let bloco = 1; bloco < 30; bloco++) {
        const maior = maiorQuedaDesdeABase(base, precos);
        assert.equal(qualVarredura(maior, new Decimal(1), 25, bloco * 2000, HORA), 'nenhuma');
    }
});

test('moeda sem preço na base não inventa queda', () => {
    // Na primeira volta a base está vazia. Dividir por um preço ausente daria
    // NaN, ou pior, uma queda de 100% e uma varredura por engano todo bloco.
    const agora = new Map([['0xaa', new Decimal(3000e8)]]);
    assert.equal(maiorQuedaDesdeABase(new Map(), agora).toNumber(), 0);
    assert.equal(maiorQuedaDesdeABase(new Map([['0xaa', new Decimal(0)]]), agora).toNumber(), 0);
});

// O teto da conta é 20.000.000 CUs/mês. Não é opinião, é um número — então o
// gasto também precisa ser um número, conferido por teste e não por estimativa.
const TETO_DA_CONTA = 20_000_000;

// Medido na conta dela em 2026-09-23, bloco 51696083, e não chutado:
// 8.390 devedores, 1.166 deles a menos de 25% de cair.
const MEDIDO = { devedores: 8390, quentes: 1166, chamadasPorMulticall: 250, minutosEntreCompletas: 60 };

test('o desenho de hoje cabe no teto da conta', () => {
    // A brasa dispara em quase todo ciclo (a mais frágil estava a 0,037%, e
    // preço anda isso o tempo todo), então ela NÃO pode custar chamada: viaja
    // nas vagas que sobram no multicall dos preços. Aqui a lista quente é
    // exercitada no pior caso plausível, 10% dos ciclos.
    const gasto = custoMensalEmCUs({ ...MEDIDO, intervaloMs: 8000, fracaoQueDisparaQuentes: 0.1 });
    assert.ok(gasto < TETO_DA_CONTA, `gastaria ${gasto.toLocaleString('pt-BR')} CUs/mês`);
});

test('reler as 1.166 quentes em TODO ciclo estoura o teto', () => {
    // O defeito que a medição de 1.166 denunciou: com o gatilho armado em
    // 0,037% a lista quente seria relida quase sempre, e aí ela sozinha custa
    // mais que a conta inteira. É por isso que a brasa existe.
    const gasto = custoMensalEmCUs({ ...MEDIDO, intervaloMs: 8000, fracaoQueDisparaQuentes: 1 });
    assert.ok(gasto > TETO_DA_CONTA, `caberia com ${gasto} CUs/mês, e não devia`);
});

test('a brasa cabe nas vagas que sobram do multicall dos preços', () => {
    // 250 chamadas por multicall, menos o bloco, menos os 15 preços.
    const vagas = 250 - 15 - 1;
    assert.equal(vagas, 234);
    const medidos = Array.from({ length: 1166 }, (_, i) => ({
        devedor: `0x${String(i).padStart(40, '0')}`,
        queda: new Decimal(0.03 + i * 0.02),
    }));
    const c = repartirPorFragilidade(medidos, vagas, 25);
    assert.equal(c.brasa.length, vagas);
    // O gatilho passa a ser a margem do PRIMEIRO que ficou de fora — todos os
    // mais frágeis que ele já são lidos a cada ciclo e não precisam de gatilho.
    assert.equal(c.margemDaBrasa.toFixed(2), medidos[vagas].queda.toFixed(2));
    assert.ok(c.margemDaBrasa.greaterThan(4), `gatilho em ${c.margemDaBrasa.toFixed(2)}%, longe dos 0,037%`);
});

test('a brasa sai ORDENADA POR FRAGILIDADE, não pela ordem que chegou', () => {
    // O defeito mais repetido deste projeto: fatiar slice(0, N) de uma lista
    // ordenada por outra coisa e publicar a amostra como se fosse ranking.
    const medidos = [
        { devedor: '0xA', queda: new Decimal(40) },
        { devedor: '0xB', queda: new Decimal(0.5) },
        { devedor: '0xC', queda: new Decimal(9) },
        { devedor: '0xD', queda: new Decimal(2) },
    ];
    const c = repartirPorFragilidade(medidos, 2, 25);
    assert.deepEqual(c.brasa, ['0xB', '0xD']);
    assert.deepEqual(c.quentes, ['0xC']);       // 0xA está a 40%, fora da margem
    assert.equal(c.margemDaBrasa.toNumber(), 9);
});

test('brasa que cobre todo mundo dentro da margem arma o gatilho na margem', () => {
    const c = repartirPorFragilidade([{ devedor: '0xA', queda: new Decimal(3) }], 10, 25);
    assert.deepEqual(c.brasa, ['0xA']);
    assert.deepEqual(c.quentes, []);
    assert.equal(c.margemDaBrasa.toNumber(), 25);
});

test('varrer os 8.390 a cada bloco estoura o teto em muitas vezes', () => {
    // O desenho original: varredura completa em todo bloco de 2s.
    const semGatilho = custoMensalEmCUs({
        ...MEDIDO, intervaloMs: 2000, quentes: 8390, fracaoQueDisparaQuentes: 1,
    });
    assert.ok(semGatilho > TETO_DA_CONTA * 20, `${semGatilho} CUs/mês`);
});

// ---------------------------------------------------------------------------
// A conferência do cofre, que agora acontece sozinha a cada boot.
// ---------------------------------------------------------------------------

const COFRE = '0x3dffA934170bdD491724747Be2c4F56E3f1512A7';
const CONTA_BOT = '0x3D310384d674532f5D41cF2D43B03001F3515AE8';

test('cofre certo aprova', () => {
    const l = julgarCofre({ cofre: COFRE, dono: CONTA_BOT });
    assert.equal(l.veredicto, 'aprovado');
    assert.ok(podeCacarComDinheiroReal(l));
});

test('cofre diferente do esperado REPROVA', () => {
    const l = julgarCofre({ cofre: A, dono: CONTA_BOT });
    assert.equal(l.veredicto, 'reprovado');
    assert.ok(l.porque.includes(A));
    assert.ok(!podeCacarComDinheiroReal(l));
});

test('cofre igual ao dono REPROVA, e diz exatamente por quê', () => {
    // O defeito do 0xd87AeE…, que rodou dias sem ninguém ver.
    const l = julgarCofre({ cofre: CONTA_BOT, dono: CONTA_BOT });
    assert.equal(l.veredicto, 'reprovado');
    assert.ok(l.porque.toLowerCase().includes('carteira quente'));
});

test('não conseguir ler NÃO é aprovação', () => {
    // Endereço errado, contrato inexistente, rede caída — tudo cai aqui, e
    // nada disso pode virar permissão para gastar dinheiro.
    const l = julgarCofre({ cofre: null, dono: null });
    assert.equal(l.veredicto, 'inconclusivo');
    assert.ok(!podeCacarComDinheiroReal(l));
});

test('dono ilegível não impede aprovar um cofre correto', () => {
    // A checagem cofre==dono é um extra. Se dono() não respondeu, o cofre
    // certo ainda é o cofre certo.
    assert.equal(julgarCofre({ cofre: COFRE, dono: null }).veredicto, 'aprovado');
});

test('a comparação ignora maiúsculas do checksum', () => {
    assert.equal(julgarCofre({ cofre: COFRE.toLowerCase(), dono: CONTA_BOT }).veredicto, 'aprovado');
});

test('os seletores de cofre() e dono() sao os que o contrato publica', () => {
    assert.equal(SELETOR_COFRE, '0x8fb8a14a');
    assert.equal(SELETOR_DONO, '0x70514bea');
});
