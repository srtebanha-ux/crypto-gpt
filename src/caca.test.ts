import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, COBRIR_O_MAXIMO, julgarCofre, podeCacarComDinheiroReal, SELETOR_COFRE, SELETOR_DONO } from './caca';
import { Decimal } from 'decimal.js';
import { quantoPedirEmprestado, FATIA_COBRIVEL, maiorQuedaDesdeABase, qualVarredura, custoMensalEmCUs, repartirPorFragilidade, oQueUmaQuedaRenderia, comoLerAsQuedas } from './cacarAoVivo';
import { dividaMinimaQueVale, lucroEstimado } from './perdidas';
import { custoDoTiroUsd, PISO_DA_GORJETA_WEI } from './prontidao';

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
    // 250 chamadas por multicall, menos os 15 preços, menos DUAS de carona no
    // mesmo eth_call: o número do bloco e o basefee. O log de produção diz
    // `naBrasa: 233`, e é esta conta que tem de dar nele — um comentário que
    // documenta 234 vagas quando o código reserva 2 é documentação que mente.
    const vagas = 250 - 15 - 2;
    assert.equal(vagas, 233);
    const medidos = Array.from({ length: 1166 }, (_, i) => ({
        devedor: `0x${String(i).padStart(40, '0')}`,
        queda: new Decimal(0.03 + i * 0.02),
        dividaUsd: new Decimal(5000),
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
        { devedor: '0xA', queda: new Decimal(40), dividaUsd: new Decimal(5000) },
        { devedor: '0xB', queda: new Decimal(0.5), dividaUsd: new Decimal(5000) },
        { devedor: '0xC', queda: new Decimal(9), dividaUsd: new Decimal(5000) },
        { devedor: '0xD', queda: new Decimal(2), dividaUsd: new Decimal(5000) },
    ];
    const c = repartirPorFragilidade(medidos, 2, 25);
    assert.deepEqual(c.brasa, ['0xB', '0xD']);
    assert.deepEqual(c.quentes, ['0xC']);       // 0xA está a 40%, fora da margem
    assert.equal(c.margemDaBrasa.toNumber(), 9);
});

test('brasa que cobre todo mundo dentro da margem arma o gatilho na margem', () => {
    const c = repartirPorFragilidade([{ devedor: '0xA', queda: new Decimal(3), dividaUsd: new Decimal(5000) }], 10, 25);
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

// ---------------------------------------------------------------------------
// O piso de TAMANHO da brasa.
//
// Estes testes existem por uma linha de log real, do tiro em seco de
// 2026-09-27: o alvo escolhido — o mais fragil de 234 na brasa — pediria
// emprestado 119.283.982.799.745 wei de WETH. Isso e US$ 0,32. A divida
// inteira era US$ 0,65. A fila mais rapida do bot estava apontada para po, e
// o log dizia "naBrasa: 234" como se fossem 234 alvos.
// ---------------------------------------------------------------------------

/** As condicoes exatas do log do tiro em seco. */
const BASEFEE_DO_LOG = 20_000_000n;              // 0,0200 gwei
const ETH_DO_LOG = new Decimal('2714.75');
const DIVIDA_DO_ALVO_DO_LOG = new Decimal('0.6477');   // 2 x US$ 0,32

test('o piso de tamanho sai do tiro MAIS BARATO, e o alvo do tiro em seco fica 37x abaixo dele', () => {
    const custoMinimo = custoDoTiroUsd(PISO_DA_GORJETA_WEI, BASEFEE_DO_LOG, ETH_DO_LOG);
    assert.ok(custoMinimo !== null);
    // 700.000 de gás x 0,12 gwei = 0,000084 ETH.
    assert.equal(custoMinimo!.toFixed(4), '0.2280');

    const piso = dividaMinimaQueVale(custoMinimo);
    assert.ok(piso !== null);
    assert.equal(piso!.toFixed(2), '23.95');

    // O alvo que o bot mirou não chega nem perto.
    assert.ok(piso!.dividedBy(DIVIDA_DO_ALVO_DO_LOG).greaterThan(35),
        `o alvo do log devia US$ ${DIVIDA_DO_ALVO_DO_LOG.toFixed(2)}, ${piso!.dividedBy(DIVIDA_DO_ALVO_DO_LOG).toFixed(0)}x abaixo do piso`);

    // E o lucro dele é centavos de centavo — menos que o gás.
    assert.ok(lucroEstimado(DIVIDA_DO_ALVO_DO_LOG).lessThan(0),
        'liquidar US$ 0,65 dá prejuízo depois do gás');
});

test('quem está exatamente no piso entra: o corte é >=, não >', () => {
    const piso = dividaMinimaQueVale(new Decimal('0.2280390'));
    const c = repartirPorFragilidade(
        [{ devedor: '0xA', queda: new Decimal(1), dividaUsd: piso }],
        10, 25, piso,
    );
    assert.deepEqual(c.brasa, ['0xA']);
    assert.equal(c.poEmDemasia, 0);
});

test('o piso da SELEÇÃO é mais frouxo que o portão do TIRO — errar excluindo é o erro caro', () => {
    const custo = new Decimal('0.2280390');
    const daSelecao = dividaMinimaQueVale(custo, 1)!;
    const doPortao = dividaMinimaQueVale(custo, 2)!;
    assert.ok(daSelecao.lessThan(doPortao),
        `seleção US$ ${daSelecao.toFixed(2)} tem de ser menor que portão US$ ${doPortao.toFixed(2)}`);
    // Nada que o portão aceitaria pode ser cortado antes de chegar nele.
    assert.ok(lucroEstimado(doPortao).greaterThanOrEqualTo(custo.mul(2).minus(1e-9)));
});

test('pó mais frágil NÃO rouba a vaga da baleia menos frágil', () => {
    // O defeito, no menor caso que o mostra: uma vaga, duas posições.
    const piso = new Decimal(24);
    const medidos = [
        { devedor: '0xPO',     queda: new Decimal(0.01), dividaUsd: new Decimal('0.65') },
        { devedor: '0xBALEIA', queda: new Decimal(3),    dividaUsd: new Decimal(4000) },
    ];
    const semPiso = repartirPorFragilidade(medidos, 1, 25);
    assert.deepEqual(semPiso.brasa, ['0xPO'], 'sem piso, a fragilidade pura entrega a vaga ao pó');

    const comPiso = repartirPorFragilidade(medidos, 1, 25, piso);
    assert.deepEqual(comPiso.brasa, ['0xBALEIA']);
    assert.equal(comPiso.poEmDemasia, 1);
    assert.equal(comPiso.valemUmTiro, 1);
});

test('a régua da postura (menorMargem) para de ser ditada pelo pó', () => {
    // menorMargem alimenta posturaPorMargem: é ela que decide se o bot vai
    // para 200ms. Vinda do pó, o bot acelerava por uma posição de US$ 0,65.
    const medidos = [
        { devedor: '0xPO',     queda: new Decimal(0.004), dividaUsd: new Decimal('0.65') },
        { devedor: '0xBALEIA', queda: new Decimal(6),     dividaUsd: new Decimal(4000) },
    ];
    assert.equal(repartirPorFragilidade(medidos, 5, 25).menorMargem!.toNumber(), 0.004);
    assert.equal(repartirPorFragilidade(medidos, 5, 25, new Decimal(24)).menorMargem!.toNumber(), 6);
});

test('o gatilho (margemDaBrasa) também passa a ignorar o pó que ficou de fora', () => {
    const medidos = [
        { devedor: '0xA', queda: new Decimal(1),  dividaUsd: new Decimal(4000) },
        { devedor: '0xPO', queda: new Decimal(2), dividaUsd: new Decimal('0.65') },
        { devedor: '0xB', queda: new Decimal(8),  dividaUsd: new Decimal(4000) },
    ];
    // Uma vaga só. Sem piso o gatilho seria a margem do pó (2%): o bot releria
    // a lista quente por causa de alguém que nunca valeria um tiro.
    assert.equal(repartirPorFragilidade(medidos, 1, 25).margemDaBrasa.toNumber(), 2);
    assert.equal(repartirPorFragilidade(medidos, 1, 25, new Decimal(24)).margemDaBrasa.toNumber(), 8);
});

test('sem cotação do ETH não se filtra nada: piso inventado é pior que piso nenhum', () => {
    assert.equal(dividaMinimaQueVale(null), null);
    assert.equal(custoDoTiroUsd(PISO_DA_GORJETA_WEI, BASEFEE_DO_LOG, null), null);
    const medidos = [{ devedor: '0xPO', queda: new Decimal(0.01), dividaUsd: new Decimal('0.65') }];
    const c = repartirPorFragilidade(medidos, 10, 25, null);
    assert.deepEqual(c.brasa, ['0xPO'], 'sem piso a lista passa inteira — cego é melhor que cego achando que vê');
    assert.equal(c.poEmDemasia, 0);
    assert.equal(c.valemUmTiro, 1);
});

test('dívida NÃO lida não é descartada: falta de dado não vira decisão', () => {
    const medidos = [{ devedor: '0xSEMDADO', queda: new Decimal(0.5), dividaUsd: null }];
    const c = repartirPorFragilidade(medidos, 10, 25, new Decimal(24));
    assert.deepEqual(c.brasa, ['0xSEMDADO']);
    assert.equal(c.poEmDemasia, 0);
});

test('a conta fecha: o que vale mais o que foi cortado é o total medido', () => {
    const medidos = Array.from({ length: 50 }, (_, i) => ({
        devedor: `0x${String(i).padStart(40, '0')}`,
        queda: new Decimal(1 + i * 0.1),
        // Um em cada três é pó.
        dividaUsd: i % 3 === 0 ? new Decimal('0.65') : new Decimal(5000),
    }));
    const c = repartirPorFragilidade(medidos, 234, 25, new Decimal(24));
    assert.equal(c.valemUmTiro + c.poEmDemasia, 50);
    assert.equal(c.poEmDemasia, 17);
    assert.equal(c.brasa.length, 33);
});

test('um piso maior que todo mundo deixa a brasa vazia — e isso é informação, não bug', () => {
    // Base com gás caríssimo: o piso sobe e pode passar de todo mundo. A brasa
    // vazia com o número do pó ao lado é a resposta para "por que 23h sem
    // nada": não é o bot que está cego, é a lista que é de pó.
    const medidos = [
        { devedor: '0xA', queda: new Decimal(1), dividaUsd: new Decimal(10) },
        { devedor: '0xB', queda: new Decimal(2), dividaUsd: new Decimal(20) },
    ];
    const c = repartirPorFragilidade(medidos, 234, 25, new Decimal(100));
    assert.deepEqual(c.brasa, []);
    assert.deepEqual(c.quentes, []);
    assert.equal(c.menorMargem, null);
    assert.equal(c.poEmDemasia, 2);
    assert.equal(c.valemUmTiro, 0);
    assert.equal(c.margemDaBrasa.toNumber(), 25);
});

test('gás caro na Base sobe o piso: a mesma lista vale menos quando o bloco cobra mais', () => {
    const caro = custoDoTiroUsd(PISO_DA_GORJETA_WEI, 5_000_000_000n, ETH_DO_LOG); // 5 gwei
    const barato = custoDoTiroUsd(PISO_DA_GORJETA_WEI, BASEFEE_DO_LOG, ETH_DO_LOG);
    assert.ok(dividaMinimaQueVale(caro)!.greaterThan(dividaMinimaQueVale(barato)!.mul(10)),
        'a 5 gwei o piso tem de subir em mais de uma ordem de grandeza');
});

// ---------------------------------------------------------------------------
// "O que uma queda de X% poria na mesa."
//
// Existe por causa de `margemDoAlvo: "precisa cair 1.1562%"` no ensaio de
// 2026-09-27 10:31. O numero sozinho nao dizia se atras do primeiro alvo vem
// um ou vem cinquenta — e e isso que decide se vale esperar o mercado.
// ---------------------------------------------------------------------------

test('a tabela de quedas é cumulativa e ordenada, não a ordem que chegou', () => {
    const medidos = [
        { devedor: '0xA', queda: new Decimal(0.5), dividaUsd: new Decimal(4000) },
        { devedor: '0xB', queda: new Decimal(2.5), dividaUsd: new Decimal(4000) },
        { devedor: '0xC', queda: new Decimal(7),   dividaUsd: new Decimal(4000) },
    ];
    const t = oQueUmaQuedaRenderia(medidos, [5, 1, 10, 3]);
    assert.deepEqual(t.map((d) => d.quedaPct), [1, 3, 5, 10], 'os degraus saem em ordem');
    assert.deepEqual(t.map((d) => d.quantos), [1, 2, 2, 3], 'cada degrau inclui os anteriores');
});

test('alcançar não é lucrar: o pó entra em quantos e fica fora de quantosValem', () => {
    const medidos = [
        { devedor: '0xPO',     queda: new Decimal(0.1), dividaUsd: new Decimal('0.65') },
        { devedor: '0xBALEIA', queda: new Decimal(0.2), dividaUsd: new Decimal(4000) },
    ];
    const [um] = oQueUmaQuedaRenderia(medidos, [1]);
    assert.equal(um!.quantos, 2);
    assert.equal(um!.quantosValem, 1, 'US$ 0,65 é alcançado mas não paga o próprio gás');
});

test('o lucro somado NÃO é a dívida somada — o erro otimista clássico', () => {
    const medidos = [{ devedor: '0xA', queda: new Decimal(1), dividaUsd: new Decimal(4000) }];
    const [um] = oQueUmaQuedaRenderia(medidos, [1]);
    assert.equal(um!.dividaUsd.toFixed(0), '4000');
    // Ágio de 5% sobre a METADE, menos o custo de vender, menos o gás: ~US$ 88.
    assert.equal(um!.lucroUsd.toFixed(0), '88');
    assert.ok(um!.lucroUsd.lessThan(um!.dividaUsd.dividedBy(40)));
});

test('prejuízo de uma posição não é subtraído do prêmio das outras', () => {
    // Somar lucro negativo mascararia o pó dentro do total e faria uma queda
    // parecer menos lucrativa do que é: a posição ruim simplesmente não é
    // atirada, ela não come o lucro da boa.
    const so = oQueUmaQuedaRenderia([{ devedor: '0xA', queda: new Decimal(1), dividaUsd: new Decimal(4000) }], [1]);
    const com = oQueUmaQuedaRenderia([
        { devedor: '0xA', queda: new Decimal(1), dividaUsd: new Decimal(4000) },
        { devedor: '0xPO', queda: new Decimal(1), dividaUsd: new Decimal('0.65') },
    ], [1]);
    assert.equal(com[0]!.lucroUsd.toFixed(4), so[0]!.lucroUsd.toFixed(4));
});

test('dívida não lida não conta como zero nem quebra a soma', () => {
    const medidos = [
        { devedor: '0xA', queda: new Decimal(1), dividaUsd: null },
        { devedor: '0xB', queda: new Decimal(1), dividaUsd: new Decimal(4000) },
    ];
    const [um] = oQueUmaQuedaRenderia(medidos, [1]);
    assert.equal(um!.quantos, 2, 'ela é alcançada: isso se sabe');
    assert.equal(um!.quantosValem, 1, 'mas não se pode afirmar que vale');
    assert.equal(um!.dividaUsd.toFixed(0), '4000');
});

test('lista vazia dá zeros, não NaN', () => {
    const t = oQueUmaQuedaRenderia([], [1, 5]);
    assert.deepEqual(t.map((d) => d.quantos), [0, 0]);
    assert.equal(t[0]!.lucroUsd.toFixed(2), '0.00');
    assert.equal(t[0]!.dividaUsd.toFixed(2), '0.00');
});

test('o caso real: um alvo a 1,1562% e o que viria atrás dele', () => {
    // A margem medida, mais uma cauda plausível. Serve para provar que a
    // tabela distingue "um alvo sozinho" de "um alvo e uma fila".
    const medidos = [
        { devedor: '0xPERTO', queda: new Decimal('1.1562'), dividaUsd: new Decimal('91.74') },
        { devedor: '0xATRAS1', queda: new Decimal(4),  dividaUsd: new Decimal(4000) },
        { devedor: '0xATRAS2', queda: new Decimal(8),  dividaUsd: new Decimal(4000) },
    ];
    const t = oQueUmaQuedaRenderia(medidos, [2, 5, 10]);
    // Uma queda de 2% pega SÓ o de perto, e ele rende centavos.
    assert.equal(t[0]!.quantosValem, 1);
    assert.equal(t[0]!.lucroUsd.toFixed(2), '1.72');
    // Uma de 5% já vale 50x mais. É esta diferença que o log não mostrava.
    assert.equal(t[1]!.quantosValem, 2);
    assert.ok(t[1]!.lucroUsd.greaterThan(t[0]!.lucroUsd.mul(50)));
});

test('a linha que ela vai ler tem forma travada', () => {
    // Formatação escondida dentro de um log não tem teste, e é esta linha que
    // decide se continua na Aave da Base ou vai caçar em outro protocolo.
    const medidos = [
        { devedor: '0xPERTO', queda: new Decimal('1.1562'), dividaUsd: new Decimal('91.74') },
        { devedor: '0xMEDIO', queda: new Decimal(4),        dividaUsd: new Decimal(4000) },
    ];
    assert.equal(
        comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [2, 5])),
        '2%: 1 valem (US$ 2) | 5%: 2 valem (US$ 90)',
    );
});

test('tabela vazia diz "nada medido", não vira string vazia', () => {
    // String vazia no log some no meio dos outros campos e parece que o campo
    // não existe — o oposto de informar.
    assert.equal(comoLerAsQuedas([]), 'nada medido');
});
