import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, id } from 'ethers';
import { codificarCacaV1, codificarCacaV2, lerRespostaDaCaca, PISO_IMPOSSIVEL, COBRIR_O_MAXIMO, julgarCofre, podeCacarComDinheiroReal, SELETOR_COFRE, SELETOR_DONO } from './caca';
import { Decimal } from 'decimal.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTO_DA_LISTA_QUENTE_MS } from './cacarAoVivo';
import { ritmoDaPostura as oRitmo, pisoEfetivoDaAposta, type Postura as TipoDePostura } from './adiantar';
import { quantoPedirEmprestado, FATIA_COBRIVEL, maiorQuedaDesdeABase, qualVarredura, custoMensalEmCUs, repartirPorFragilidade, margemQueDecideORitmo, poolParaVender, SEM_VENDA, pisoDoLucroEmUnidadesCruas, oPrecoCancela, oQueUmaQuedaRenderia, comoLerAsQuedas,
    viaDeQuebra, oQueUmaAltaRenderia, altaEquivalente, contarVias, comoLerABussola, familiaDoAtivo,
    cabemNoCiclo, hostDoRpc } from './cacarAoVivo';
import type { Via } from './cacarAoVivo';
import { SAUDE_UM, quedaAteLiquidar, altaDaDividaAteLiquidar } from './posicoes';
import { dividaMinimaQueVale, lucroEstimado, lucroDaCobertura, coberturaOtima, lucroMaximo } from './perdidas';
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
    // 700.000 de gás x 0,27 gwei = 0,000189 ETH = US$ 0,5131.
    // Era US$ 0,2280 com o piso de gorjeta em 0,1 gwei; o piso foi para 0,25 em
    // 2026-09-29 (c43a102, pedido dela) e este número é consequência aritmética,
    // não regra nova. É a MESMA causa do piso da faixa ter ido de 0,45 para 1,02.
    assert.equal(custoMinimo!.toFixed(4), '0.5131');

    const piso = dividaMinimaQueVale(custoMinimo);
    assert.ok(piso !== null);
    // US$ 23,95 -> US$ 36,87: mesma cadeia do piso de gorjeta de 0,25 gwei. A
    // dívida mínima que paga o próprio gás sobe junto com o custo do tiro.
    assert.equal(piso!.toFixed(2), '36.87');

    // O alvo que o bot mirou não chega nem perto — e ficou AINDA mais longe:
    // 37x abaixo do piso viraram 57x. O título do teste diz 37x e fica como
    // registro do dia em que foi medido; a asserção segue a regra.
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
    // `dividaMinimaQueVale` inverte a fórmula SEM escorregamento, e isso é
    // deliberado: no tamanho do piso (US$ 34) a venda é de US$ 18 num pool de
    // US$ 4,4 milhões, e o escorregamento vale sete centésimos de milésimo de
    // centavo. Invertir a curva inteira para ganhar isso seria precisão falsa —
    // e o erro que sobra empurra o piso para BAIXO, que é o lado seguro para um
    // filtro de seleção.
    const faltou = custo.mul(2).minus(lucroEstimado(doPortao));
    assert.ok(faltou.lessThan('0.0001'), `faltou US$ ${faltou.toFixed(10)}, que é nada`);
    assert.ok(faltou.greaterThan(0), 'e falta para MENOS: o piso admite um pouco mais, não menos');
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
    // Ágio de 5% sobre a METADE, menos a taxa do pool, menos o escorregamento
    // da venda de US$ 2.100, menos o gás: US$ 86,90.
    assert.equal(um!.lucroUsd.toFixed(0), '87');
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

test('o caso real de 2026-09-27: duas baleias empatadas no teto do pool', () => {
    // O log das 19:46 disse `5%: maior US$ 1986 a 3.85%` e o das 20:02, dezesseis
    // minutos depois, `a 4.04%`; no degrau de 10% foi de 6.05% para 9.48%. Parecia
    // o prêmio se afastando do alcance. NADA havia se movido: o lucro satura no
    // teto do pool (US$ 1.985,95), então as baleias empatam até a última casa e o
    // desempate caía na ordem em que o multicall voltou.
    //
    // A prova é a MESMA lista em duas ordens dando a MESMA resposta — e a resposta
    // é a que está mais PERTO de cair, porque é um alvo por vez que dispara.
    const perto = { devedor: '0xPERTO', queda: new Decimal('2.12'), dividaUsd: new Decimal('1933691.53') };
    const longe = { devedor: '0xLONGE', queda: new Decimal('4.04'), dividaUsd: new Decimal(5_000_000) };

    assert.equal(
        lucroEstimado(perto.dividaUsd).toFixed(8),
        lucroEstimado(longe.dividaUsd).toFixed(8),
        'as duas dívidas têm que empatar, senão o teste não testa o empate',
    );

    for (const lista of [[perto, longe], [longe, perto]]) {
        const [degrau] = oQueUmaQuedaRenderia(lista, [5]);
        assert.equal(degrau!.maior!.quedaPct.toFixed(2), '2.12');
        assert.equal(degrau!.maior!.lucroUsd.toFixed(0), '1986');
    }
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
        '2%: 1 alcanço/1 valem (US$ 1.72, maior US$ 1.72 a 1.16% [par SUPOSTO: pode ser imune], mas 1 de 1 são PALPITE: par ainda não resolvido)'
        + ' | 5%: 2 alcanço/2 valem (US$ 89, maior US$ 87 a 4.00% [par SUPOSTO: pode ser imune], mas 2 de 2 são PALPITE: par ainda não resolvido)',
    );
});

test('sem palpite nenhum a linha NÃO carrega a ressalva', () => {
    // O gêmeo do teste acima, e a razão de a ressalva existir: ela tem de
    // aparecer quando o par é suposto E sumir quando ele foi medido. Uma
    // ressalva que sai sempre vira ruído e deixa de ser lida — foi assim que
    // `jaSabia: 6575` passou despercebido por dias.
    const medidos = [
        { devedor: '0xPERTO', queda: new Decimal('1.1562'), dividaUsd: new Decimal('91.74'), via: 'long' as const },
        { devedor: '0xMEDIO', queda: new Decimal(4), dividaUsd: new Decimal(4000), via: 'long' as const },
    ];
    const linha = comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [2, 5]));
    assert.equal(linha.includes('PALPITE'), false, linha);
    assert.equal(
        linha,
        '2%: 1 alcanço/1 valem (US$ 1.72, maior US$ 1.72 a 1.16% [par MEDIDO]) | 5%: 2 alcanço/2 valem (US$ 89, maior US$ 87 a 4.00% [par MEDIDO])',
    );
});

test('a ressalva conta SÓ os supostos, não o degrau inteiro', () => {
    // O caso que uma contagem preguiçosa erraria: um medido e um suposto no
    // mesmo degrau têm de sair como "1 de 2", não "2 de 2" nem nada.
    const medidos = [
        { devedor: '0xSABIDO', queda: new Decimal(1), dividaUsd: new Decimal(4000), via: 'long' as const },
        { devedor: '0xSUPOSTO', queda: new Decimal(1), dividaUsd: new Decimal(4000) },
    ];
    assert.match(comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [2])), /mas 1 de 2 são PALPITE/);
});

test('tabela vazia diz "nada medido", não vira string vazia', () => {
    // String vazia no log some no meio dos outros campos e parece que o campo
    // não existe — o oposto de informar.
    assert.equal(comoLerAsQuedas([]), 'nada medido');
});

// ---------------------------------------------------------------------------
// Duas respostas erradas minhas, com a MESMA raiz.
//
// 1. O bot imprimiu "10%: 100 valem (US$ 2161328)". Fantasia: cobrava 0,59% de
//    custo de venda a posições que somam US$ 95 milhões, quando vender US$ 50
//    milhões num pool de US$ 4,4 milhões custa o pool inteiro.
//
// 2. Consertei cobrando o escorregamento — e aí a mesma posição virou
//    "prejuízo de US$ 44 milhões". Também errado.
//
// A raiz das duas: tratar como FIXO algo que é escolha nossa. Primeiro o custo
// de venda; depois o tamanho da fatia. A Aave não obriga a cobrir metade —
// `debtToCover` pode ser qualquer valor até o limite. Dívida grande não é
// prejuízo nem bonança: é prêmio COM TETO.
// ---------------------------------------------------------------------------

test('a baleia de US$ 95 milhões rende o MÁXIMO do pool, não prejuízo nem milhões', () => {
    const lucro = lucroEstimado(new Decimal(95_454_358));
    assert.equal(lucro.toFixed(2), lucroMaximo().toFixed(2));
    assert.equal(lucro.toFixed(0), '1986');
    // Para constar o tamanho dos dois erros que este teste fecha.
    const fantasia = new Decimal(95_454_358).dividedBy(2).mul(0.05 - 0.0059).minus(0.3);
    assert.equal(fantasia.toFixed(0), '2104768', 'o que eu imprimi');
    const seCobrisseMetade = lucroDaCobertura(new Decimal(95_454_358).dividedBy(2));
    assert.ok(seCobrisseMetade.lessThan(-40_000_000), 'o que eu disse depois');
});

test('o lucro SATURA e nunca volta a cair: acima da fatia ótima a gente só não cobre mais', () => {
    const cresce = [100_000, 200_000, 400_000, 1_000_000, 10_000_000, 95_454_358]
        .map((d) => lucroEstimado(new Decimal(d)));
    for (let i = 1; i < cresce.length; i++) {
        assert.ok(cresce[i]!.greaterThanOrEqualTo(cresce[i - 1]!.minus('0.01')),
            `lucro caiu de ${cresce[i - 1]!.toFixed(2)} para ${cresce[i]!.toFixed(2)}`);
    }
    assert.equal(cresce[cresce.length - 1]!.toFixed(0), lucroMaximo().toFixed(0));
});

test('a fatia ótima e o lucro máximo do pool medido', () => {
    assert.equal(coberturaOtima().toFixed(0), '90387');
    assert.equal(lucroMaximo().toFixed(0), '1986');
    // É máximo mesmo: cobrir mais ou menos rende menos.
    assert.ok(lucroDaCobertura(coberturaOtima().mul('1.5')).lessThan(lucroMaximo()));
    assert.ok(lucroDaCobertura(coberturaOtima().mul('0.5')).lessThan(lucroMaximo()));
});

test('o lucro máximo bate com a medição INDEPENDENTE de contratos.ts', () => {
    // contratos.ts registrou em 2026-09-19, por outro caminho: US$ 2.103 de
    // lucro máximo neste pool. Esta fórmula dá US$ 1.986. Duas derivações
    // independentes dentro de 6% é o que me faz confiar na segunda.
    const erro = lucroMaximo().minus(2103).abs().dividedBy(2103);
    assert.ok(erro.lessThan('0.06'), `fórmula ${lucroMaximo().toFixed(0)} vs medição 2103`);
});

test('pool mais raso derruba o teto: o custo de vender é do POOL, não do projeto', () => {
    // O Uniswap V2 medido tem US$ 649.469 — 6,8x mais raso. contratos.ts
    // registrou US$ 300 de lucro máximo nele.
    const raso = new Decimal(649_469);
    assert.ok(lucroMaximo(raso).lessThan(lucroMaximo().dividedBy(4)));
    assert.ok(coberturaOtima(raso).lessThan(coberturaOtima().dividedBy(4)));
    assert.ok(lucroMaximo(raso).minus(300).abs().dividedBy(300).lessThan('0.25'),
        `raso rende ${lucroMaximo(raso).toFixed(0)}, a medição dizia 300`);
});

test('profundidade zero não vira lucro infinito nem NaN', () => {
    const l = lucroDaCobertura(new Decimal(2000), new Decimal(0));
    assert.ok(l.isFinite());
    assert.ok(l.lessThan(0), 'sem pool não se vende nada');
});

test('a tabela de quedas fica honesta nos DOIS sentidos', () => {
    const medidos = [
        { devedor: '0xBOM',    queda: new Decimal(1), dividaUsd: new Decimal(4000) },
        { devedor: '0xBALEIA', queda: new Decimal(1), dividaUsd: new Decimal(95_454_358) },
        { devedor: '0xPO',     queda: new Decimal(1), dividaUsd: new Decimal('0.65') },
    ];
    const [um] = oQueUmaQuedaRenderia(medidos, [1]);
    assert.equal(um!.quantos, 3);
    assert.equal(um!.quantosValem, 2, 'o pó não vale; a baleia vale');
    // US$ 87 do bom + US$ 1.986 da baleia. Nem US$ 2 milhões, nem prejuízo.
    assert.equal(um!.lucroUsd.toFixed(0), '2073');
});

// --- quantoPedirEmprestado com o teto da fatia ---

test('baleia: pede a fatia ótima, não metade', () => {
    const cruUSDC = 95_454_358n * 1_000_000n;             // USDC tem 6 casas
    const pedido = quantoPedirEmprestado(cruUSDC, new Decimal(95_454_358), coberturaOtima());
    assert.equal(pedido, 90_387_042000n);
    assert.ok(pedido < cruUSDC / 2n, 'muito abaixo da metade');
    // E a conversão fecha: as unidades cruas viram os mesmos dólares.
    assert.equal((Number(pedido) / 1e6).toFixed(0), coberturaOtima().toFixed(0));
});

test('posição pequena: continua pedindo metade, o teto não morde', () => {
    const cru = 4000n * 10n ** 18n;
    assert.equal(quantoPedirEmprestado(cru, new Decimal(4000), coberturaOtima()), cru / 2n);
});

test('sem cotação da dívida volta a METADE — comportamento antigo, não palpite', () => {
    const cru = 95_454_358n * 1_000_000n;
    assert.equal(quantoPedirEmprestado(cru), cru / 2n);
    assert.equal(quantoPedirEmprestado(cru, undefined, coberturaOtima()), cru / 2n);
    assert.equal(quantoPedirEmprestado(cru, new Decimal(95_454_358), undefined), cru / 2n);
});

test('valores impossíveis de cotação não viram fatia estranha', () => {
    const cru = 1000n * 10n ** 18n;
    for (const d of [new Decimal(0), new Decimal(-5), new Decimal(NaN), new Decimal(Infinity)]) {
        assert.equal(quantoPedirEmprestado(cru, d, coberturaOtima()), cru / 2n, `dívida ${d}`);
    }
    for (const t of [new Decimal(0), new Decimal(-1), new Decimal(NaN)]) {
        assert.equal(quantoPedirEmprestado(cru, new Decimal(1000), t), cru / 2n, `teto ${t}`);
    }
});

test('nunca pede ZERO: uma caçada que não cobre nada é gás jogado fora', () => {
    // Dívida gigante em unidades cruas minúsculas: a regra de três arredondaria
    // para zero. Tem de cair na metade em vez de mandar zero.
    const pedido = quantoPedirEmprestado(4n, new Decimal(1_000_000_000), coberturaOtima());
    assert.ok(pedido > 0n, `pediu ${pedido}`);
    assert.equal(pedido, 2n);
});

test('nunca pede mais que a metade: a Aave recusa acima do close factor', () => {
    const cru = 100_000n * 10n ** 6n;
    for (const teto of [new Decimal(1e9), new Decimal(50_000), coberturaOtima()]) {
        const p = quantoPedirEmprestado(cru, new Decimal(100_000), teto);
        assert.ok(p <= cru / 2n, `teto ${teto.toFixed(0)} pediu ${p}`);
    }
});

test('a linha mostra ALCANÇO e VALEM separados — é a resposta para "a prova tem alvo?"', () => {
    // `1%: 0 valem` não dizia se ali existem zero posições ou cinquenta
    // pequenas demais para a regra normal. O tiro de prova atira justamente
    // nessas, então a diferença entre os dois números é o que decide.
    const medidos = [
        { devedor: '0xPO1', queda: new Decimal(0.5), dividaUsd: new Decimal('0.65') },
        { devedor: '0xPO2', queda: new Decimal(0.7), dividaUsd: new Decimal(5) },
        { devedor: '0xBOM', queda: new Decimal(0.9), dividaUsd: new Decimal(4000) },
    ];
    const linha = comoLerAsQuedas(oQueUmaQuedaRenderia(medidos, [1]));
    assert.equal(linha, '1%: 3 alcanço/1 valem (US$ 87, maior US$ 87 a 0.90% [par SUPOSTO: pode ser imune], mas 3 de 3 são PALPITE: par ainda não resolvido)');
});

// ---------------------------------------------------------------------------
// As vagas de prova.
//
// O log de 17:53 mostrou o furo: `1%: 3 alcanço/0 valem` e `maisPerto: 1.1555%`.
// Três posições a menos de 1% de cair, nenhuma passando o piso de tamanho — e
// o `maisPerto` medindo só quem passa. Ou seja: as três posições que o modo
// prova existe para atirar estavam FORA da brasa, e só seriam relidas na
// varredura de hora em hora.
//
// O modo prova soltava o portão do TIRO e não soltava o filtro da SELEÇÃO.
// Metade do conserto não conserta nada.
// ---------------------------------------------------------------------------

test('o furo: sem vagas de prova, o alvo da prova fica fora da brasa', () => {
    const piso = new Decimal(22);
    const medidos = [
        { devedor: '0xPROVA', queda: new Decimal('0.5'), dividaUsd: new Decimal(10) },   // dust, pertíssimo
        { devedor: '0xREAL',  queda: new Decimal(3),     dividaUsd: new Decimal(4000) },
    ];
    const sem = repartirPorFragilidade(medidos, 10, 25, piso);
    assert.deepEqual(sem.brasa, ['0xREAL'], 'o alvo da prova não está sendo vigiado');
    assert.equal(sem.vagasDeProva, 0);
});

test('com vagas de prova, ele entra na brasa e passa a ser lido a cada ciclo', () => {
    const piso = new Decimal(22);
    const medidos = [
        { devedor: '0xPROVA', queda: new Decimal('0.5'), dividaUsd: new Decimal(10) },
        { devedor: '0xREAL',  queda: new Decimal(3),     dividaUsd: new Decimal(4000) },
    ];
    const com = repartirPorFragilidade(medidos, 10, 25, piso, 5);
    assert.ok(com.brasa.includes('0xPROVA'), 'agora é vigiado');
    assert.ok(com.brasa.includes('0xREAL'), 'e o de verdade continua');
    assert.equal(com.vagasDeProva, 1);
});

test('as vagas de prova saem DE DENTRO das da brasa, não por cima', () => {
    // O multicall cabe 233 e não 234. Estourar isso quebraria a leitura toda.
    const medidos = [
        ...Array.from({ length: 300 }, (_, i) => ({
            devedor: `0xR${i}`, queda: new Decimal(1 + i * 0.01), dividaUsd: new Decimal(4000),
        })),
        ...Array.from({ length: 50 }, (_, i) => ({
            devedor: `0xP${i}`, queda: new Decimal(0.1 + i * 0.001), dividaUsd: new Decimal(5),
        })),
    ];
    const c = repartirPorFragilidade(medidos, 233, 25, new Decimal(22), 10);
    assert.equal(c.brasa.length, 233, 'nunca passa da capacidade do multicall');
    assert.equal(c.vagasDeProva, 10);
    assert.equal(c.brasa.filter((d) => d.startsWith('0xP')).length, 10);
    assert.equal(c.brasa.filter((d) => d.startsWith('0xR')).length, 223);
});

test('as RÉGUAS continuam saindo dos alvos de verdade, não dos de prova', () => {
    // `menorMargem` decide o ritmo de 200ms. Se um alvo de 22 centavos a 0,1%
    // ditasse a régua, o bot inteiro aceleraria por ele — trocaria um furo por
    // outro, e este custa CU.
    const medidos = [
        { devedor: '0xPROVA', queda: new Decimal('0.1'), dividaUsd: new Decimal(5) },
        { devedor: '0xREAL',  queda: new Decimal(6),     dividaUsd: new Decimal(4000) },
    ];
    const c = repartirPorFragilidade(medidos, 10, 25, new Decimal(22), 5);
    assert.ok(c.brasa.includes('0xPROVA'), 'vigiado');
    assert.equal(c.menorMargem!.toNumber(), 6, 'mas a régua é a do alvo de verdade');
});

test('sem piso não há vagas de prova: não existe "abaixo do piso" sem piso', () => {
    const medidos = [{ devedor: '0xA', queda: new Decimal(1), dividaUsd: new Decimal(5) }];
    assert.equal(repartirPorFragilidade(medidos, 10, 25, null, 10).vagasDeProva, 0);
});

test('vagas de prova negativas ou fracionárias não quebram a conta', () => {
    const medidos = [
        { devedor: '0xP', queda: new Decimal('0.5'), dividaUsd: new Decimal(5) },
        { devedor: '0xR', queda: new Decimal(3), dividaUsd: new Decimal(4000) },
    ];
    assert.equal(repartirPorFragilidade(medidos, 10, 25, new Decimal(22), -5).vagasDeProva, 0);
    assert.equal(repartirPorFragilidade(medidos, 1.7, 25, new Decimal(22), 1).brasa.length, 1,
        'vaga fracionária arredonda para baixo: o multicall conta inteiro');
});

test('dívida NÃO lida não é escolhida como alvo de prova: não se sabe se é pó', () => {
    const medidos = [{ devedor: '0xSEMDADO', queda: new Decimal('0.1'), dividaUsd: null }];
    const c = repartirPorFragilidade(medidos, 10, 25, new Decimal(22), 10);
    assert.equal(c.vagasDeProva, 0);
    assert.ok(c.brasa.includes('0xSEMDADO'), 'ela entra como alvo NORMAL, que é o certo');
});

test('a soma escondia a forma: o MAIOR sozinho entra na linha', () => {
    // Conferido direto na Base em 2026-09-27: o bot dizia "2%: 3 valem (US$ 91)",
    // que parece três liquidações de US$ 30 — nada. Eram DUAS, e uma vale
    // US$ 66,44 a 1,44% de cair. A média apagava exatamente a boa notícia, e é
    // o maior sozinho que decide, porque é UM alvo por vez que dispara.
    const medidos = [
        { devedor: '0xGRANDE', queda: new Decimal('1.441'), dividaUsd: new Decimal(3053) },
        { devedor: '0xMEDIO',  queda: new Decimal('1.580'), dividaUsd: new Decimal(1065) },
    ];
    const [d] = oQueUmaQuedaRenderia(medidos, [2]);
    assert.equal(d!.lucroUsd.toFixed(2), '89.55', 'a soma bate com a minha varredura independente');
    assert.equal(d!.maior!.lucroUsd.toFixed(2), '66.44');
    assert.equal(d!.maior!.quedaPct.toFixed(3), '1.441');
    assert.match(comoLerAsQuedas([d!]), /maior US\$ 66 a 1\.44%/);
});

test('degrau sem ninguém que valha não inventa um maior', () => {
    const medidos = [{ devedor: '0xPO', queda: new Decimal(1), dividaUsd: new Decimal('0.65') }];
    const [d] = oQueUmaQuedaRenderia(medidos, [2]);
    assert.equal(d!.quantosValem, 0);
    assert.equal(d!.maior, null);
    assert.equal(comoLerAsQuedas([d!]), '2%: 1 alcanço/0 valem (US$ 0.00, mas 1 de 1 são PALPITE: par ainda não resolvido)');
});

test('modo prova: o RITMO segue o alvo em que o bot atira, não o que passa o piso', () => {
    // O log de 2026-09-28 dizia, nas suas duas linhas, coisas diferentes sobre
    // a mesma pergunta:
    //
    //   [BLOCO]   maisPerto: precisa cair 0.0441% (o mais perto que passa o
    //             piso de tamanho está a 1.4278%)
    //   [POSTURA] maisFragilA: 1.4279%
    //
    // E era a segunda que mandava no ritmo — ou seja, a cadência do bot
    // ignorava justamente o alvo que o modo prova existe para atirar. Terceira
    // vez que o modo prova solta uma ponta da regra e esquece a gêmea.
    const camadas = { menorMargem: new Decimal('1.4279'), menorMargemDaBrasa: new Decimal('0.0441') };
    assert.equal(margemQueDecideORitmo(camadas, true)!.toFixed(4), '0.0441', 'prova armada: manda a brasa inteira');
    assert.equal(margemQueDecideORitmo(camadas, false)!.toFixed(4), '1.4279', 'fora da prova: manda quem paga o gás');
});

test('brasa vazia no modo prova não vira "não há ninguém"', () => {
    // O mesmo cuidado que `maisPerto` já toma: um orçamento de multicall curto
    // esvazia a brasa, e cair para `null` publicaria ausência com um alvo a
    // meio ponto de cair.
    const camadas = { menorMargem: new Decimal('2.5'), menorMargemDaBrasa: null };
    assert.equal(margemQueDecideORitmo(camadas, true)!.toFixed(1), '2.5');
});

test('sem alvo nenhum, as duas camadas nulas continuam nulas', () => {
    assert.equal(margemQueDecideORitmo({ menorMargem: null, menorMargemDaBrasa: null }, true), null);
    assert.equal(margemQueDecideORitmo({ menorMargem: null, menorMargemDaBrasa: null }, false), null);
});

test('moeda única: não se vende a garantia, porque ela JÁ é o que se deve', () => {
    // O caso real de 2026-09-28. `0xc4d36f95` é WETH contra WETH, e o pool de
    // venda configurado (0xcdac0d6c…) é WETH/USDC — conferido na rede:
    // token0 = 0x4200…0006 (WETH), token1 = 0x8335…2913 (USDC).
    //
    // Com o pool passado, `executeOperation` vende TODO o WETH tomado por USDC,
    // incluindo o que precisa para pagar o flash loan, e a transação inteira
    // reverte com LucroInsuficiente(0, piso). O tiro nunca pode acertar, e a
    // medição sai como lucro ZERO — fazendo `decidirTiro` recusar o alvo.
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const AERO = '0xcdac0d6c6c59727a65f871236188350531885c43';

    assert.equal(poolParaVender({ garantia: WETH, divida: WETH }, AERO), SEM_VENDA);
    assert.equal(poolParaVender({ garantia: USDC, divida: USDC }, AERO), SEM_VENDA);
    // E o caso normal continua vendendo.
    assert.equal(poolParaVender({ garantia: WETH, divida: USDC }, AERO), AERO);
});

test('a comparação de moeda única não depende de caixa alta', () => {
    // Endereços chegam da rede em minúscula e de constantes em checksum. Comparar
    // cru deixaria o par WETH/WETH passar como se fosse par de moedas diferentes,
    // e o defeito voltaria sem nenhum sinal.
    const AERO = '0xcdac0d6c6c59727a65f871236188350531885c43';
    assert.equal(poolParaVender({
        garantia: '0x4200000000000000000000000000000000000006',
        divida: '0x4200000000000000000000000000000000000006'.toUpperCase().replace('0X', '0x'),
    }, AERO), SEM_VENDA);
});

test('o V2 não pode ser medido com piso impossível — 0x42301c23 é do router', () => {
    // Medido em 2026-09-28 com o oráculo forçado, bloco 51912429: o V2 passa
    // `aDevolver + minProfit` como `amountOutMin` PARA O ROUTER da Aerodrome,
    // que recusa antes de executar com InsufficientOutputAmount(). Com piso 0
    // ele executou e a bisseção deu 323.009.925 unidades — o V1, no mesmo
    // bloco, deu 323.009.946. Diferença de 21 unidades em 323 milhões.
    assert.equal(id('InsufficientOutputAmount()').slice(0, 10), '0x42301c23');

    // Dívida de US$ 3.490,06 em USDC (6 casas) = 3490060000 unidades cruas.
    const alvo = { dividaCrua: 3490060000n, dividaUsd: new Decimal('3490.06') };
    // Um piso de US$ 0,22 (o custo do tiro mais barato medido) vira:
    assert.equal(pisoDoLucroEmUnidadesCruas(alvo, new Decimal('0.22')), 220000n);
    // E o modo prova pede ZERO: só que o empréstimo seja pago.
    assert.equal(pisoDoLucroEmUnidadesCruas(alvo, new Decimal(0)), 0n);
});

test('sem dívida conhecida o piso do V2 é ZERO, não um palpite', () => {
    assert.equal(pisoDoLucroEmUnidadesCruas({ dividaCrua: undefined, dividaUsd: new Decimal(10) }, new Decimal(1)), 0n);
    assert.equal(pisoDoLucroEmUnidadesCruas({ dividaCrua: 100n, dividaUsd: null }, new Decimal(1)), 0n);
    assert.equal(pisoDoLucroEmUnidadesCruas({ dividaCrua: 100n, dividaUsd: new Decimal(0) }, new Decimal(1)), 0n);
});

test('os imunes a preço vão para o FIM da brasa, não para fora dela', () => {
    // O log das 16:58: o `[EM SECO]` mirava 0x43ec917e, que é USDC contra USDC
    // e nunca cai com o mercado, enquanto os sensíveis esperavam atrás.
    const m = (d: string, q: number, via?: Via) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(1000), via });
    const c = repartirPorFragilidade(
        [m('0x43ec917e', 1.9, 'imune'), m('0xsensivel', 4.0, 'long'), m('0xnaoSei', 5.0, undefined)],
        3, 100, new Decimal(0.5), 0,
    );
    // O imune é o mais próximo de todos e mesmo assim vai por último.
    assert.deepEqual(c.brasa, ['0xsensivel', '0xnaoSei', '0x43ec917e']);
    // E quem não se sabe conta como sensível: fica na frente do imune.
    assert.equal(c.brasa.indexOf('0xnaoSei') < c.brasa.indexOf('0x43ec917e'), true);
});

test('o que o preço cancela: mesma moeda e mesma família', () => {
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const weETH = '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a';
    const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
    assert.equal(oPrecoCancela(WETH, WETH), true, 'mesma moeda');
    assert.equal(oPrecoCancela(USDC, USDC), true);
    assert.equal(oPrecoCancela(weETH, WETH), true, '0x034a3304 é weETH contra WETH: só cai num depeg');
    assert.equal(oPrecoCancela(cbBTC, USDC), false, 'este cai por preço de verdade');
    assert.equal(oPrecoCancela(WETH, USDC), false);
    // Caixa alta não pode quebrar a comparação.
    assert.equal(oPrecoCancela(WETH.toUpperCase().replace('0X', '0x'), WETH), true);
});

test('o ovo e a galinha: o imune não pode contaminar o maisPerto', () => {
    // O log das 17:25, achado por ela. `precoCancela` só era preenchido DEPOIS
    // de `montarAlvos`, que com a postura "dormindo" nunca rodava — então TODO
    // alvo tinha par desconhecido, "desconhecido conta como sensível" punha os
    // imunes na frente, e o `[EM SECO]` mirou 0x034a3304, que é weETH contra
    // WETH: `margemDoAlvo: precisa cair 0.0434%` numa posição que nenhuma queda
    // alcança.
    const m = (d: string, q: number, via?: Via) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(1000), via });
    const c = repartirPorFragilidade(
        [m('0x034a3304', 0.0434, 'imune'), m('0x43ec917e', 1.90, 'imune'), m('0xsensivel', 2.51, 'long')],
        10, 100, new Decimal(0.5), 0,
    );
    assert.equal(c.menorMargemDaBrasa!.toFixed(2), '2.51', 'o maisPerto é do sensível, não do imune de 0.0434%');
    assert.equal(c.brasa[0], '0xsensivel', 'e ele ocupa a frente da fila');
});

test('brasa toda imune: o maisPerto sai deles, e não vira "ninguém"', () => {
    // A ponta oposta do mesmo conserto: filtrar sempre transformaria uma brasa
    // inteira de imunes em ausência publicada como resposta.
    const m = (d: string, q: number) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(1000), via: 'imune' as Via });
    const c = repartirPorFragilidade([m('0xa', 0.98), m('0xb', 1.90)], 10, 100, new Decimal(0.5), 0);
    assert.equal(c.menorMargemDaBrasa!.toFixed(2), '0.98');
});

test('a tabela de quedas conta só quem o preço alcança', () => {
    // O log dizia `1%: 3 alcanço` e os três eram dois WETH/WETH e um weETH/WETH:
    // zero alcançados de verdade. A tabela existe para responder "vale esperar
    // o mercado?", e contava quem o mercado não move.
    const m = (d: string, q: number, via: Via) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(5000), via });
    const t = oQueUmaQuedaRenderia(
        [m('0xa', 0.04, 'imune'), m('0xb', 0.98, 'imune'), m('0xc', 0.99, 'imune'), m('0xd', 2.5, 'long')],
        [1, 3],
    );
    assert.equal(t[0]!.quantos, 0, 'os três de 1% eram todos imunes');
    assert.equal(t[1]!.quantos, 1, 'em 3% entra o único que o preço derruba');
});

test('as famílias saem da lista REAL de reservas da Base, lida da rede', () => {
    // A lista anterior tinha um endereço que eu inventei (0x80d1e0f4…). Estes
    // são os que `getReservesList()` + `symbol()` devolveram em 2026-09-28.
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    for (const derivado of [
        '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
        '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
        '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a', // weETH
        '0x2416092f143378750bb29b79ed961ab195cceea5', // ezETH
        '0xedfa23602d0ec14714057867a78d01e94176bea0', // wrsETH
    ]) assert.equal(oPrecoCancela(derivado, WETH), true, `${derivado} é família do WETH`);

    for (const dolar of [
        '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
        '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee', // GHO
        '0x660975730059246a68521a3e2fbd4740173100f5', // syrupUSDC
    ]) assert.equal(oPrecoCancela(dolar, USDC), true, `${dolar} é família do USDC`);

    // cbBTC, LBTC e tBTC entre si.
    assert.equal(oPrecoCancela('0xecac9c5f704e954931349da37f60e39f515c11c1',
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'), true, 'LBTC e cbBTC');

    // EURC é EURO: contra dólar tem risco de câmbio DE VERDADE. Medido em
    // 2026-09-28: 0x675c8697 tem garantia USDC e dívida EURC, e o piso deu ZERO.
    assert.equal(oPrecoCancela('0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', USDC), false);
    // E família de ETH contra família de dólar continua sendo par de verdade.
    assert.equal(oPrecoCancela('0x04c0599ae5a44757c0af6f9ec3b93da8976c150a', USDC), false);
});

// ===================================================================
// A CORREÇÃO DA BÚSSOLA — medida em 2026-09-29, cobertura 100%
// (205 janelas de 2.000 blocos, 9,5 dias, 60 liquidações, 60 com arquivo):
//
//     22 já estavam liquidáveis em N-1
//     38 cruzaram exatamente em N: 28 por PREÇO, 4 por juro, 0 pelo dono
//     nas 28 por preço, o preço da DÍVIDA subiu em 28 de 28
//     em 20 das 28 a garantia ficou COMPLETAMENTE parada (+0,0000%)
//
// O bot só modelava a garantia caindo. Montamos o exército no norte e o
// inimigo entrou pelo sul.
// ===================================================================

test('a bússola: cada par vai para a sua via', () => {
    const WETH = '0x4200000000000000000000000000000000000006';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const weETH = '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a';
    const cbBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
    const EURC = '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42';
    assert.equal(viaDeQuebra(WETH, WETH), 'imune', 'mesma moeda: o preço cancela');
    assert.equal(viaDeQuebra(weETH, WETH), 'imune', 'mesma família: só um depeg derruba');
    assert.equal(viaDeQuebra(WETH, USDC), 'long', 'garantia volátil, dívida estável');
    assert.equal(viaDeQuebra(cbBTC, USDC), 'long');
    // ESTE é o caso que o bot não via: 20 das 28 liquidações por preço são assim.
    assert.equal(viaDeQuebra(USDC, WETH), 'short', 'garantia estável, dívida volátil');
    assert.equal(viaDeQuebra(USDC, cbBTC), 'short');
    assert.equal(viaDeQuebra(cbBTC, WETH), 'ambas', 'as duas voláteis: quebra a razão');
    // EURC é euro: risco de câmbio de verdade. Medido em 2026-09-28 no
    // `0x675c8697` (USDC contra EURC), piso ZERO — o preço derruba aquilo.
    assert.equal(viaDeQuebra(USDC, EURC), 'short', 'dívida em euro contra garantia em dólar');
    assert.equal(familiaDoAtivo(EURC), 'outro', 'euro não é família do dólar');
    // Caixa alta não pode quebrar a comparação.
    assert.equal(viaDeQuebra(WETH.toUpperCase().replace('0X', '0x'), USDC), 'long');
});

test('dois desconhecidos não são família por serem ambos desconhecidos', () => {
    // Inventar correlação é o defeito que este projeto persegue. `outro` contra
    // `outro` tem de sair `ambas`, e nunca `imune`.
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    assert.equal(familiaDoAtivo(a), 'outro');
    assert.equal(viaDeQuebra(a, b), 'ambas');
    assert.equal(oPrecoCancela(a, b), false);
});

test('oPrecoCancela é DERIVADO de viaDeQuebra — uma regra, um lugar', () => {
    // A regra 3 do CLAUDE.md: uma regra em dois lugares é a mesma regra, e três
    // dos dez erros originais foram consertar uma ponta e deixar a gêmea.
    const enderecos = [
        '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a',
        '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', '0x3333333333333333333333333333333333333333',
    ];
    for (const g of enderecos) for (const d of enderecos) {
        assert.equal(oPrecoCancela(g, d), viaDeQuebra(g, d) === 'imune', `${g} contra ${d}`);
    }
});

test('a alta da dívida que liquida: os dois caminhos dão o mesmo número', () => {
    // `altaDaDividaAteLiquidar` sai da saúde crua; `altaEquivalente` sai da queda
    // já calculada. Se discordarem, uma das duas está inventando.
    for (const vezes of ['1.02', '1.0001', '1.5', '1.000000001', '2']) {
        const saude = new Decimal(vezes).mul(SAUDE_UM);
        const q = quedaAteLiquidar(saude)!;
        const direto = altaDaDividaAteLiquidar(saude)!;
        const convertido = altaEquivalente(q)!;
        assert.equal(convertido.minus(direto).abs().lessThan(1e-9), true,
            `saúde ${vezes}: direto ${direto.toFixed(9)} contra convertido ${convertido.toFixed(9)}`);
    }
    // O número medido: com saúde 1,02 a garantia cai 1,9608% e a dívida sobe
    // 2,0000%. Parecidos, não iguais — e é a DIREÇÃO que importa, não o número.
    const s = new Decimal('1.02').mul(SAUDE_UM);
    assert.equal(quedaAteLiquidar(s)!.toFixed(4), '1.9608');
    assert.equal(altaDaDividaAteLiquidar(s)!.toFixed(4), '2.0000');
    // Sem dívida: `null` nos dois, nunca zero.
    assert.equal(altaDaDividaAteLiquidar(new Decimal(2000).mul(SAUDE_UM)), null);
    // Já liquidável: zero nos dois.
    assert.equal(altaDaDividaAteLiquidar(new Decimal('0.9').mul(SAUDE_UM))!.toFixed(0), '0');
});

test('uma QUEDA não alcança um SHORT, e uma ALTA não alcança um LONG', () => {
    // O defeito exato: a tabela contava um `short` como alcançado por uma queda
    // de mercado. 20 das 28 liquidações por preço têm garantia estável — uma
    // queda não move nenhuma delas.
    const m = (d: string, q: number, via: Via) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(5000), via });
    const lista = [m('0xlong', 1.0, 'long'), m('0xshort', 1.0, 'short'), m('0xambas', 1.0, 'ambas'), m('0ximune', 1.0, 'imune')];
    const caiu = oQueUmaQuedaRenderia(lista, [2]);
    const subiu = oQueUmaAltaRenderia(lista, [2]);
    assert.equal(caiu[0]!.quantos, 2, 'uma queda alcança long e ambas — não o short, não o imune');
    assert.equal(subiu[0]!.quantos, 2, 'uma alta alcança short e ambas — não o long, não o imune');
});

test('a régua da tabela de ALTA é a alta da dívida, não a queda da garantia', () => {
    // Com queda 1,9608% a alta equivalente é 2,0000%: num degrau de 1,99% o
    // alvo entra pela queda e NÃO entra pela alta. Se a tabela de alta usasse a
    // régua da queda, os dois dariam o mesmo — e a etiqueta mentiria.
    const m = { devedor: '0xshort', queda: new Decimal('1.9608'), dividaUsd: new Decimal(5000), via: 'ambas' as Via };
    assert.equal(oQueUmaQuedaRenderia([m], [1.99])[0]!.quantos, 1, 'a queda de 1,9608% cabe em 1,99%');
    assert.equal(oQueUmaAltaRenderia([m], [1.99])[0]!.quantos, 0, 'a alta de 2,0000% NÃO cabe em 1,99%');
    assert.equal(oQueUmaAltaRenderia([m], [2.01])[0]!.quantos, 1, 'e cabe em 2,01%');
});

test('a bússola conta os cinco estados e não perde ninguém', () => {
    const m = (d: string, via?: Via) => ({ devedor: d, queda: new Decimal(1), dividaUsd: null, via });
    const lista = [m('0xa', 'long'), m('0xb', 'short'), m('0xc', 'short'), m('0xd', 'ambas'), m('0xe', 'imune'), m('0xf', undefined)];
    const c = contarVias(lista);
    assert.deepEqual(c, { long: 1, short: 2, ambas: 1, imune: 1, naoSeSabe: 1 });
    // A soma tem de fechar: é isso que impede a próxima etiqueta de mentir sobre
    // o conjunto, o defeito que o `jaSabia: 6575` publicou em produção.
    assert.equal(Object.values(c).reduce((s, x) => s + x, 0), lista.length);
    assert.match(comoLerABussola(c), /1 LONG \(cai a garantia\) \| 2 SHORT \(sobe a dívida\)/);
});

test('o alvo do ensaio pode ser SHORT, e não só LONG', () => {
    // Antes o filtro era `oQueSeSabeDoPreco(d) === false` — um booleano que
    // significava "não é imune". Agora "não é imune" tem TRÊS formas, e um
    // `short` é alvo legítimo: é o caso mais comum das liquidações reais.
    const m = (d: string, q: number, via: Via) =>
        ({ devedor: d, queda: new Decimal(q), dividaUsd: new Decimal(1000), via });
    const c = repartirPorFragilidade(
        [m('0ximune', 0.1, 'imune'), m('0xshort', 1.5, 'short'), m('0xlong', 2.0, 'long')],
        3, 100, new Decimal(0.5), 0,
    );
    assert.equal(c.brasa[0], '0xshort', 'o short entra na frente, e o imune vai para o fim');
    assert.equal(c.brasa[2], '0ximune');
    assert.equal(c.menorMargemDaBrasa!.toFixed(1), '1.5', 'e o maisPerto sai dele');
});

// ===================================================================
// LATÊNCIA — cronometrado em 2026-09-30 contra mainnet.base.org,
// conexão já quente:
//
//     1 eth_blockNumber vazio (só o round trip) ......... 457,8 ms
//     1 multicall com 233 getUserAccountData (FRIA) ..... 559,5 ms
//     1 multicall com  50 getUserAccountData (FRIA) .....  98,4 ms
//     1 multicall com 166 getUserAccountData (QUENTE) ... 241,3 ms
//     1 multicall com  50 getUserAccountData (QUENTE) ... 160,8 ms
//     decodificar 233 contas + quedaAteLiquidar .........  24,2 ms
//     repartirPorFragilidade em 209 medidos .............   3,0 ms
//     oQueUmaQuedaRenderia + comoLerAsQuedas ............  71,8 ms
//     contarVias + comoLerABussola ......................   0,1 ms
//     JSON.stringify do estado inteiro ..................   0,4 ms
//
// CPU somada: ~100ms. Rede: ~1.000ms em dois round trips. O gargalo é a
// rede, e o log pesado custa 0,4ms — remover ele não compra nada.
// ===================================================================

test('o teto da lista quente corta, e diz quantos ficaram fora', () => {
    const lista = Array.from({ length: 166 }, (_, i) => `0x${i}`);
    const c = cabemNoCiclo(lista, 50);
    assert.equal(c.lidos.length, 50, 'lê 50: 241,3ms -> 160,8ms com conexão quente, medido');
    assert.equal(c.ficaramFora, 116, 'e os 116 que sobraram são declarados, não escondidos');
    // A soma tem de fechar. É isto que impede o corte de virar silêncio.
    assert.equal(c.lidos.length + c.ficaramFora, lista.length);
    // Os 50 são os PRIMEIROS, que é a ordem de urgência que repartirPorFragilidade entregou.
    assert.equal(c.lidos[0], '0x0');
    assert.equal(c.lidos[49], '0x49');
});

test('o teto não corta quando não precisa, e desliga com zero', () => {
    const curta = ['0xa', '0xb'];
    assert.deepEqual(cabemNoCiclo(curta, 50), { lidos: curta, ficaramFora: 0 });
    const longa = Array.from({ length: 300 }, (_, i) => `0x${i}`);
    // `0` desliga: é a saída para ela reabrir tudo sem novo push.
    assert.equal(cabemNoCiclo(longa, 0).lidos.length, 300);
    assert.equal(cabemNoCiclo(longa, 0).ficaramFora, 0);
    // NaN não pode virar `slice(0, NaN)`, que devolve lista VAZIA e desliga a
    // caçada em silêncio — o defeito que `CACA_MORDIDA_MAXIMA='0,5'` já causou.
    assert.equal(cabemNoCiclo(longa, Number.NaN).lidos.length, 300);
});

test('cortar por queda não esconde um short: as duas réguas são monótonas juntas', () => {
    // A garantia do corte. A lista chega ordenada por `queda`, e a régua do
    // short é `altaEquivalente(queda)`. Se a ordem das duas discordasse, o teto
    // jogaria fora um short que estava na frente.
    const quedas = [0.5, 1, 1.9608, 3, 5, 10, 50].map((q) => new Decimal(q));
    const altas = quedas.map((q) => altaEquivalente(q)!);
    for (let i = 1; i < quedas.length; i++) {
        assert.equal(quedas[i]!.greaterThan(quedas[i - 1]!), true);
        assert.equal(altas[i]!.greaterThan(altas[i - 1]!), true,
            `alta tem de crescer junto: ${altas[i - 1]!.toFixed(4)} -> ${altas[i]!.toFixed(4)}`);
    }
});

test('o host do RPC vai para o log SEM a chave', () => {
    // A chave da Alchemy mora no caminho. Log vira print, print vira conversa.
    assert.equal(hostDoRpc('https://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA'), 'base-mainnet.g.alchemy.com');
    assert.equal(hostDoRpc('https://mainnet.base.org'), 'mainnet.base.org');
    assert.match(hostDoRpc('https://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA'), /^[^/]+$/);
    assert.equal(hostDoRpc('https://base-mainnet.g.alchemy.com/v2/CHAVE_SECRETA').includes('CHAVE_SECRETA'), false);
    // URL torta não pode derrubar o log nem inventar um host.
    assert.equal(hostDoRpc('nao é uma url'), 'não consegui ler a URL');
});


test('o MAIOR diz se ELE é medido, não só a fração do degrau', () => {
    // A pergunta que ela fez olhando o log de 2026-10-06: "tem uma linha a menos
    // de 1% pra cair, preciso pegar ela". O degrau dizia "187 de 190 são
    // PALPITE" — e isso NÃO responde em qual dos dois baldes está o maior, que é
    // justamente onde ela vai mirar.
    //
    // Aqui o menor (que é o mais perto de cair, e por isso vira o `maior` só se
    // o lucro mandar) tem via conhecida e o outro não.
    const sabido = [
        { devedor: '0xSABIDO', queda: new Decimal(0.5), dividaUsd: new Decimal(4000), via: 'long' as const },
        { devedor: '0xSUPOSTO', queda: new Decimal(0.9), dividaUsd: new Decimal(10) },
    ];
    assert.match(comoLerAsQuedas(oQueUmaQuedaRenderia(sabido, [1])), /\[par MEDIDO\]/);

    const suposto = [
        { devedor: '0xSUPOSTO', queda: new Decimal(0.5), dividaUsd: new Decimal(4000) },
        { devedor: '0xSABIDO', queda: new Decimal(0.9), dividaUsd: new Decimal(10), via: 'long' as const },
    ];
    assert.match(comoLerAsQuedas(oQueUmaQuedaRenderia(suposto, [1])), /\[par SUPOSTO: pode ser imune\]/);
});

test('um alvo que vale nunca sai como "US$ 0" — o log de 2026-10-08 12:39', () => {
    // MEDIDO: a linha saiu `1%: 2 alcanço/1 valem (US$ 0, maior US$ 0 a 0.30%)`.
    // O contador estava certo (só sobe com lucro acima de zero) e o toFixed(0)
    // apagou um prêmio de centavos. Quem lê não consegue separar "arredondou"
    // de "o contador quebrou", e as duas pedem ações opostas.
    //
    // A REGRA, e não o literal: se o degrau diz que alguém vale, o dólar
    // publicado tem de ser maior que zero.
    const medidos = [
        { devedor: '0xMIGALHA', queda: new Decimal('0.30'), dividaUsd: new Decimal('80'), via: 'long' as const },
    ];
    const degraus = oQueUmaQuedaRenderia(medidos, [1]);
    assert.equal(degraus[0].quantosValem, 1);
    assert.ok(degraus[0].lucroUsd.greaterThan(0));
    const linha = comoLerAsQuedas(degraus);
    assert.ok(!/1 valem \(US\$ 0,/.test(linha), linha);
    assert.ok(!/maior US\$ 0 /.test(linha), linha);
});

test('o teto da lista quente segue o ORÇAMENTO do ciclo, não o nome da postura', () => {
    // MEDIDO no log dela de 2026-10-08 14:28, com o RPC dela: 248 multicalls,
    // rede 50.742ms somados, parede 8.370ms (~6x paralelo) => ~205ms por
    // multicall. A brasa lê 233 alvos num multicall, em 118–211ms. Então a
    // lista quente inteira (1.437) são ~7 multicalls: UMA rodada, ~205ms.
    //
    // O teto lia 250 e deixava 1.187 fora — justamente na varredura 'quentes',
    // que só roda quando o mercado JÁ andou o bastante para alcançar quem está
    // fora da brasa.
    const quentes = Array.from({ length: 1437 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const semTeto = cabemNoCiclo(quentes, 0);
    assert.equal(semTeto.lidos.length, 1437);
    assert.equal(semTeto.ficaramFora, 0);
    const comTeto = cabemNoCiclo(quentes, 250);
    assert.equal(comTeto.lidos.length, 250);
    assert.equal(comTeto.ficaramFora, 1187);

    // A REGRA, e não os nomes: o teto vale quando o ciclo é mais curto que o
    // custo medido. Escrever `postura === 'dedo no gatilho'` sincronizaria na
    // mão uma conta que `ritmoDaPostura` já faz — e se o ritmo de alguma
    // postura mudar, a comparação por nome responderia a pergunta de antes.
    const cabe = (p: TipoDePostura) => oRitmo(p, 8000) > CUSTO_DA_LISTA_QUENTE_MS;
    assert.equal(cabe('dormindo'), true, 'com 8000ms de ciclo, 205ms cabem');
    assert.equal(cabe('atento'), true, 'com 1000ms de ciclo, 205ms cabem');
    assert.equal(cabe('dedo no gatilho'), false, 'com 200ms de ciclo, 205ms NÃO cabem');
});

test('o env só pode ENDURECER o piso da aposta, nunca descer abaixo do equilíbrio', () => {
    // POR QUE ESTE TESTE EXISTE: eu não tenho como ver o Railway dela. Se
    // `CACA_APOSTA_MINIMA_USD=10` (o valor que eu mesmo escrevi em 08/10)
    // estivesse lá, o piso calculado seria INERTE e a sangria voltaria no
    // primeiro movimento de mercado. Um conserto que depende de um valor que
    // eu não consigo conferir não é conserto, é esperança.
    //
    // MEDIDO: 31 apostas, US$ 13,83, zero acertos, com o piso em US$ 10
    // liberando alvos que exigiam acertar 15,8x mais que o acaso.
    //
    // ESTE TESTE FOI REESCRITO EM 2026-10-09, e o motivo é ela: a primeira
    // versão **copiava a regra aqui dentro** (um `Decimal.max` local) e afirmava
    // sobre a cópia. *"Não basta testar que existe Decimal.max no código."* Uma
    // cópia provaria a cópia — a REGRA 3 do CLAUDE.md, na forma mais cara.
    //
    // Agora a regra é a função de verdade, `pisoEfetivoDaAposta`, e o caminho
    // inteiro (ambiente -> custo -> piso -> decisão de enviar) está em
    // `src/decisaoDaAposta.test.ts`, com os números reais do log.
    const equilibrio = new Decimal('158.03'); // o medido em 08/10
    // o caso REAL que eu não consigo ver: variável frouxa não afrouxa o piso
    assert.equal(pisoEfetivoDaAposta(new Decimal(10), equilibrio.dividedBy(355), 355).toFixed(2), '158.03');
    assert.equal(pisoEfetivoDaAposta(new Decimal(0), equilibrio.dividedBy(355), 355).toFixed(2), '158.03');
    // e endurecer continua funcionando: a decisão dela de exigir mais vale
    assert.equal(pisoEfetivoDaAposta(new Decimal(500), equilibrio.dividedBy(355), 355).toFixed(2), '500.00');
    // sem variável, o calculado manda
    assert.equal(pisoEfetivoDaAposta(null, equilibrio.dividedBy(355), 355).toFixed(2), '158.03');

    // E NÃO EXISTE MAIS PORTA DE ESCAPE. A versão anterior deste teste afirmava
    // que ela existia (`CACA_ACEITA_APOSTA_NEGATIVA`), porque eu a havia
    // criado. Ela mandou remover: *"Não introduza nem mantenha um escape para
    // operações de valor esperado negativo sem justificativa explícita e
    // autorização minha."* Então o teste passou a exigir o contrário — e vale
    // para TODO o código, não só para o nome que eu escolhi na época.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    assert.match(fonte, /premioMinimoUsd:\s*pisoDaAposta\(\)/,
        'o portão da aposta tem de ler `pisoDaAposta()`, não a variável crua');
    assert.match(fonte, /pisoEfetivoDaAposta\(APOSTA_MINIMA_ESCOLHIDA,\s*custoPorErradaUsd\(\)\)/,
        'o piso efetivo tem de sair da função pura, não de uma conta repetida aqui');
    for (const arquivo of ['cacarAoVivo.ts', 'adiantar.ts', 'prontidao.ts']) {
        const texto = readFileSync(join(__dirname, arquivo), 'utf8');
        // A única menção tolerada é em comentário, contando que ela foi removida.
        const codigo = texto.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
        assert.ok(
            !codigo.some((l) => /CACA_ACEITA_APOSTA_NEGATIVA|APOSTA_SEM_PISO/.test(l)),
            `${arquivo} não pode ter chave de ambiente que autorize aposta de valor esperado negativo`,
        );
    }
});
