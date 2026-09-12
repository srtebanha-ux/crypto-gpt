// Arquivo: src/excursao.test.ts
//
// O erro que estes testes existem para impedir é o que faz backtest bonito
// virar conta vazia: avaliar por FECHAMENTO em vez de por máxima/mínima.
// Avaliado por fechamento, todo stop que foi tocado e voltou desaparece — e
// com ele some justamente a perda que a conta real paga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
    acasoDaCelula,
    avaliarGrade,
    desfechoDetalhado,
    desfechoNoCaminho,
    excursoes,
    gradePadrao,
    melhorDaGrade,
    TaxasDaOperacao,
    vantagemExigida,
} from './excursao';
import { Vela1m } from './volumeSpike';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

const TAXAS = { entrada: new Decimal('0.00045'), alvo: new Decimal('0.00018'), stop: new Decimal('0.00045') };

function vela(abertura: string, maxima: string, minima: string, fechamento: string): Vela1m {
    return {
        aberturaMs: 0,
        abertura: new Decimal(abertura),
        maxima: new Decimal(maxima),
        minima: new Decimal(minima),
        fechamento: new Decimal(fechamento),
        volume: new Decimal(1),
    };
}

test('o stop conta pela MÍNIMA, não pelo fechamento — o toque que volta ainda custa', () => {
    // Fecha ACIMA da entrada, mas a mínima furou o stop no meio do caminho.
    const d = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.1', '99.5', '100.05')],
    });
    assert.equal(d, 'stop');
});

test('o alvo conta pela MÁXIMA — simétrico', () => {
    const d = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.35', '99.9', '100.0')],
    });
    assert.equal(d, 'alvo');
});

test('alvo e stop na MESMA vela contam como stop — a suposição que não inventa lucro', () => {
    const d = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.5', '99.5', '100.0')],
    });
    assert.equal(d, 'stop');
    // Com dados de 1 minuto é impossível saber a ordem. A 30x, o erro de
    // otimismo é o caro — então a dúvida vira perda.
});

test('a ORDEM das velas decide: mesmo par de extremos, desfechos opostos', () => {
    const alvoPrimeiro = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.4', '99.95', '100.3'), vela('100.3', '100.3', '99.5', '99.6')],
    });
    const stopPrimeiro = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.05', '99.5', '99.6'), vela('99.6', '100.4', '99.6', '100.3')],
    });
    assert.equal(alvoPrimeiro, 'alvo');
    assert.equal(stopPrimeiro, 'stop');
    // MFE e MAE são idênticos nos dois. Só o caminho separa — é por isso que
    // olhar extremos não basta.
});

test('na VENDA os lados invertem sozinhos', () => {
    const d = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'baixa',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.05', '99.6', '99.7')],
    });
    assert.equal(d, 'alvo'); // caiu 0,4% => alvo de venda batido
});

test('caminho que não resolve devolve "aberto", não um chute', () => {
    const d = desfechoNoCaminho({
        entrada: new Decimal(100),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.1', '99.9', '100.0')],
    });
    assert.equal(d, 'aberto');
});

test('velas vazias devolvem aberto em vez de lançar', () => {
    assert.equal(
        desfechoNoCaminho({
            entrada: new Decimal(100),
            direcao: 'alta',
            alvo: new Decimal('0.003'),
            stop: new Decimal('0.004'),
            velas: [],
        }),
        'aberto',
    );
});

test('excursoes mede o TETO do capturável, dos dois lados', () => {
    const e = excursoes({
        entrada: new Decimal(100),
        direcao: 'alta',
        velas: [vela('100', '101', '99', '100')],
    });
    assert.equal(e.favoravel.toString(), '0.01');
    assert.equal(e.adversa.toString(), '0.01');
});

test('a grade cobre todas as combinações e o EV sai líquido de taxa', () => {
    const caminhos = [
        { symbol: 'A', direcao: 'alta' as const, entrada: new Decimal(100), velas: [vela('100', '101', '99.9', '100.9')] },
    ];
    const celulas = avaliarGrade({
        caminhos,
        alvos: [new Decimal('0.003')],
        stops: [new Decimal('0.004')],
        taxas: TAXAS,
    });
    assert.equal(celulas.length, 1);
    const c = celulas[0];
    assert.equal(c.alvos, 1);
    assert.equal(c.taxaDeAcerto.toString(), '1');
    // ganho = 0,3% − 0,045% − 0,018% = 0,237%
    assert.equal(c.evPorOperacao.toFixed(5), '0.00237');
});

test('o acerto de equilíbrio cai quando o alvo passa do stop — o efeito que importa', () => {
    const caminhos = [
        { symbol: 'A', direcao: 'alta' as const, entrada: new Decimal(100), velas: [vela('100', '101', '99.9', '100.9')] },
    ];
    const [apertado] = avaliarGrade({ caminhos, alvos: [new Decimal('0.003')], stops: [new Decimal('0.004')], taxas: TAXAS });
    const [folgado] = avaliarGrade({ caminhos, alvos: [new Decimal('0.006')], stops: [new Decimal('0.003')], taxas: TAXAS });
    assert.equal(apertado.acertoDeEquilibrio.mul(100).toFixed(1), '67.4');
    assert.equal(folgado.acertoDeEquilibrio.mul(100).toFixed(1), '42.0');
    // 67,4% é uma exigência que quase nada entrega. 42,0% é rotina.
});

test('os abertos NÃO votam no acerto — nem como ganho nem como perda', () => {
    const caminhos = [
        { symbol: 'A', direcao: 'alta' as const, entrada: new Decimal(100), velas: [vela('100', '101', '99.9', '100.9')] },
        { symbol: 'B', direcao: 'alta' as const, entrada: new Decimal(100), velas: [vela('100', '100.05', '99.95', '100')] },
    ];
    const [c] = avaliarGrade({ caminhos, alvos: [new Decimal('0.003')], stops: [new Decimal('0.004')], taxas: TAXAS });
    assert.equal(c.alvos, 1);
    assert.equal(c.abertos, 1);
    assert.equal(c.taxaDeAcerto.toString(), '1'); // 1 de 1 resolvido, não 1 de 2
});

test('amostra pequena NÃO vira recomendação, por melhor que pareça', () => {
    const caminhos = [
        { symbol: 'A', direcao: 'alta' as const, entrada: new Decimal(100), velas: [vela('100', '102', '99.99', '101.9')] },
    ];
    const celulas = avaliarGrade({ caminhos, ...gradePadrao(), taxas: TAXAS });
    assert.equal(melhorDaGrade({ celulas, minimoResolvidos: 30 }), null);
    // Entre 126 combinações, alguma SEMPRE parece excelente por acaso.
});

test('sem nenhuma célula de EV positivo, devolve null em vez da "menos pior"', () => {
    // Todos os caminhos batem stop: nenhuma configuração salva.
    const caminhos = Array.from({ length: 50 }, (_, i) => ({
        symbol: `S${i}`,
        direcao: 'alta' as const,
        entrada: new Decimal(100),
        velas: [vela('100', '100.01', '90', '90.5')],
    }));
    const celulas = avaliarGrade({ caminhos, ...gradePadrao(), taxas: TAXAS });
    assert.equal(melhorDaGrade({ celulas, minimoResolvidos: 30 }), null);
});

test('empate de EV fica com o stop mais curto — menos capital em risco pela mesma expectativa', () => {
    const base = { alvos: 30, stops: 20, abertos: 0, ambiguos: 0, minutosParaResolver: [], taxaDeAcerto: new Decimal('0.6'), evPorOperacao: new Decimal('0.001'), acertoDeEquilibrio: new Decimal('0.5'), acaso: new Decimal('0.5'), z: new Decimal('5') };
    const celulas = [
        { ...base, alvo: new Decimal('0.005'), stop: new Decimal('0.005') },
        { ...base, alvo: new Decimal('0.005'), stop: new Decimal('0.003') },
    ];
    const melhor = melhorDaGrade({ celulas, minimoResolvidos: 30 });
    assert.equal(melhor?.stop.toString(), '0.003');
});

test('o acaso de uma célula é stop/(alvo+stop) — o acerto que a geometria já dá', () => {
    assert.equal(acasoDaCelula(new Decimal('0.003'), new Decimal('0.004')).mul(100).toFixed(1), '57.1');
    assert.equal(acasoDaCelula(new Decimal('0.008'), new Decimal('0.010')).mul(100).toFixed(1), '55.5');
    assert.equal(acasoDaCelula(new Decimal('0.010'), new Decimal('0.002')).mul(100).toFixed(1), '16.6');
    // Alvo curto com stop largo "acerta muito" sem valer nada: o acerto alto
    // já vem da geometria, e a taxa continua cobrando.
});

test('62,9% em alvo 0,8/stop 1,0 NÃO passa: é 1,1 desvio, e escolhemos entre 126', () => {
    // Reproduz o número que apareceu em produção e que quase virou decisão.
    const caminhos = Array.from({ length: 54 }, (_, i) => ({
        symbol: `S${i}`,
        direcao: 'alta' as const,
        entrada: new Decimal(100),
        // 34 batem o alvo de 0,8%; 20 batem o stop de 1,0%.
        velas: i < 34 ? [vela('100', '100.9', '99.5', '100.8')] : [vela('100', '100.1', '98.9', '99')],
    }));
    const celulas = avaliarGrade({
        caminhos,
        alvos: [new Decimal('0.008')],
        stops: [new Decimal('0.010')],
        taxas: TAXAS,
    });
    assert.equal(celulas[0].taxaDeAcerto.mul(100).toFixed(1), '62.9');
    assert.equal(celulas[0].acaso.mul(100).toFixed(1), '55.5');
    assert.equal(celulas[0].z.lessThan(2), true);
    assert.equal(melhorDaGrade({ celulas, minimoResolvidos: 30 }), null);
});

test('vantagem GRANDE com amostra suficiente passa — o filtro não recusa tudo', () => {
    const caminhos = Array.from({ length: 100 }, (_, i) => ({
        symbol: `S${i}`,
        direcao: 'alta' as const,
        entrada: new Decimal(100),
        velas: i < 85 ? [vela('100', '100.9', '99.5', '100.8')] : [vela('100', '100.1', '98.9', '99')],
    }));
    const celulas = avaliarGrade({ caminhos, alvos: [new Decimal('0.008')], stops: [new Decimal('0.010')], taxas: TAXAS });
    assert.equal(celulas[0].z.greaterThan(5), true);
    assert.equal(melhorDaGrade({ celulas, minimoResolvidos: 30 }) !== null, true);
});

test('a grade cobre a faixa larga, onde a taxa para de mandar', () => {
    // Era 14x9=126, tudo abaixo de 1,5% de alvo — a escala de um scalp. A
    // medição de 11-12/09 reprovou o scalp com 170 operações, e a razão
    // estrutural é que ali a exigência de vantagem é 4,3 pontos. A grade
    // precisava enxergar a faixa onde ela cai para ~1 ponto, senão a busca
    // continuava acontecendo só no lugar mais difícil que existe.
    const g = gradePadrao();
    assert.equal(g.alvos.length, 21);
    assert.equal(g.stops.length, 16);
    assert.ok(g.alvos.some((a) => a.equals('0.03')), 'a hipótese nova precisa existir na grade');
    assert.ok(g.stops.some((st) => st.equals('0.04')), 'idem o stop dela');
    assert.ok(g.alvos[0].equals('0.002'), 'e a faixa fina continua inteira');
    assert.equal(g.alvos[0].toString(), '0.002');
    assert.equal(g.alvos[13].toString(), '0.015');
});

// ----------------------------------------------------------------------
// Ambiguidade: quando o desfecho vem da regra, não do mercado
// ----------------------------------------------------------------------

test('vela que toca os dois lados é stop E é marcada como ambígua', () => {
    const d = desfechoDetalhado({
        entrada: new Decimal('100'),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.5', '99.5', '100')], // atravessa +0,3% e -0,4%
    });
    assert.equal(d.desfecho, 'stop');
    assert.equal(d.ambiguo, true, 'o desfecho veio da convenção, não do preço');
});

test('stop limpo — só o stop foi tocado — NÃO é ambíguo', () => {
    const d = desfechoDetalhado({
        entrada: new Decimal('100'),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.1', '99.5', '99.6')], // máxima não alcança +0,3%
    });
    assert.equal(d.desfecho, 'stop');
    assert.equal(d.ambiguo, false);
});

test('alvo nunca é ambíguo: se o stop tivesse sido tocado, teria vencido', () => {
    const d = desfechoDetalhado({
        entrada: new Decimal('100'),
        direcao: 'alta',
        alvo: new Decimal('0.003'),
        stop: new Decimal('0.004'),
        velas: [vela('100', '100.5', '99.9', '100.4')],
    });
    assert.equal(d.desfecho, 'alvo');
    assert.equal(d.ambiguo, false);
});

test('a MESMA vela ambígua vira stop nas DUAS direções — a assimetria que engana', () => {
    // Este é o teste que explica por que inverter um sinal ruim não devolve
    // automaticamente um sinal bom: o caminho ambíguo é penalizado duas vezes.
    const velas = [vela('100', '100.5', '99.5', '100')];
    const seguindo = desfechoDetalhado({
        entrada: new Decimal('100'), direcao: 'alta',
        alvo: new Decimal('0.003'), stop: new Decimal('0.004'), velas,
    });
    const invertido = desfechoDetalhado({
        entrada: new Decimal('100'), direcao: 'baixa',
        alvo: new Decimal('0.004'), stop: new Decimal('0.003'), velas,
    });
    assert.equal(seguindo.desfecho, 'stop');
    assert.equal(invertido.desfecho, 'stop', 'inverter NÃO transforma este stop em alvo');
    assert.equal(seguindo.ambiguo && invertido.ambiguo, true);
});

test('avaliarGrade conta os ambíguos por célula', () => {
    const caminhos = Array.from({ length: 40 }, () => ({
        symbol: 'AUSDT', direcao: 'alta' as const, entrada: new Decimal('100'),
        velas: [vela('100', '100.5', '99.5', '100')],
    }));
    const celulas = avaliarGrade({ caminhos, ...gradePadrao(), taxas: TAXAS });
    const c = celulas.find((x) => x.alvo.equals('0.003') && x.stop.equals('0.004'));
    assert.equal(c?.stops, 40);
    assert.equal(c?.ambiguos, 40, 'todos resolvidos pela regra do empate');

    // Uma célula larga o bastante não é atravessada pela mesma vela.
    const largo = celulas.find((x) => x.alvo.equals('0.015') && x.stop.equals('0.010'));
    assert.equal(largo?.ambiguos, 0);
});

// ----------------------------------------------------------------------
// Tempo até resolver — o que limita as operações por dia
// ----------------------------------------------------------------------

test('velasAteResolver conta a partir de 1: resolver na primeira vela custa um minuto', () => {
    const d = desfechoDetalhado({
        entrada: new Decimal('100'), direcao: 'alta',
        alvo: new Decimal('0.003'), stop: new Decimal('0.004'),
        velas: [vela('100', '100.5', '99.9', '100.4')],
    });
    assert.equal(d.desfecho, 'alvo');
    assert.equal(d.velasAteResolver, 1, 'zero minutos seria uma operação instantânea, que não existe');
});

test('caminho que demora conta todas as velas percorridas', () => {
    const paradas = Array.from({ length: 4 }, () => vela('100', '100.1', '99.95', '100'));
    const d = desfechoDetalhado({
        entrada: new Decimal('100'), direcao: 'alta',
        alvo: new Decimal('0.003'), stop: new Decimal('0.004'),
        velas: [...paradas, vela('100', '100.5', '99.9', '100.4')],
    });
    assert.equal(d.velasAteResolver, 5);
});

test('caminho ABERTO não tem tempo de resolução', () => {
    const d = desfechoDetalhado({
        entrada: new Decimal('100'), direcao: 'alta',
        alvo: new Decimal('0.003'), stop: new Decimal('0.004'),
        velas: [vela('100', '100.1', '99.95', '100')],
    });
    assert.equal(d.desfecho, 'aberto');
    assert.equal(d.velasAteResolver, null, 'somar zero aqui puxaria a mediana para baixo e inflaria as ops/dia');
});

test('a célula acumula um tempo por caminho RESOLVIDO, não por caminho', () => {
    const rapido = { symbol: 'A', direcao: 'alta' as const, entrada: new Decimal('100'),
        velas: [vela('100', '100.5', '99.9', '100.4')] };
    const aberto = { symbol: 'B', direcao: 'alta' as const, entrada: new Decimal('100'),
        velas: [vela('100', '100.1', '99.95', '100')] };
    const celulas = avaliarGrade({ caminhos: [rapido, rapido, aberto], ...gradePadrao(), taxas: TAXAS });
    const c = celulas.find((x) => x.alvo.equals('0.003') && x.stop.equals('0.004'));
    assert.deepEqual(c?.minutosParaResolver, [1, 1], 'o aberto não entra');
    assert.equal(c?.abertos, 1);
});

// --------------------------------------------------------------------------
// vantagemExigida — o número que decide ONDE procurar
// --------------------------------------------------------------------------

const TAXAS_REAIS: TaxasDaOperacao = {
    entrada: new Decimal('0.00045'), // taker
    alvo: new Decimal('0.00018'), // maker
    stop: new Decimal('0.00045'), // taker
};

test('reproduz o 63,1% de empate que o motor mediu em produção', () => {
    // Âncora contra a realidade: em 11/09 o log imprimiu "precisa acertar
    // 63.1%" com alvo 0,7% e stop 1,0%. Se esta conta divergir daquela, uma
    // das duas está errada e a decisão de onde procurar sai envenenada.
    const exigida = vantagemExigida({
        alvo: new Decimal('0.007'),
        stop: new Decimal('0.010'),
        taxas: TAXAS_REAIS,
    });
    const acaso = acasoDaCelula(new Decimal('0.007'), new Decimal('0.010')).mul(100);
    assert.equal(acaso.toFixed(1), '58.8', 'o acaso medido no log');
    assert.equal(acaso.plus(exigida).toFixed(1), '63.1', 'o equilíbrio medido no log');
    assert.equal(exigida.toFixed(2), '4.29');
});

test('perseguir movimento maior derruba a exigência — o motivo de alargar a grade', () => {
    const exigir = (a: string, st: string) =>
        vantagemExigida({ alvo: new Decimal(a), stop: new Decimal(st), taxas: TAXAS_REAIS });

    const scalp = exigir('0.007', '0.010'); // a configuração reprovada
    const dia = exigir('0.03', '0.04'); // a hipótese nova
    const largo = exigir('0.05', '0.05');

    assert.ok(dia.lessThan(scalp), 'alvo maior exige menos vantagem');
    assert.ok(largo.lessThan(dia), 'e continua caindo');
    // Quatro vezes menos exigente, que é a razão inteira da mudança.
    assert.ok(scalp.dividedBy(dia).greaterThan(3.5), `esperava >3,5x, deu ${scalp.dividedBy(dia)}`);
});

test('quem manda é a SOMA; trocar alvo por stop quase não muda', () => {
    // Eu tinha afirmado que SÓ a soma importa. Este teste me desmentiu: 3+4
    // exige 1,06 e 4+3 exige 1,12. Não é idêntico, porque o lado que ganha
    // paga taxa de maker (0,018%) e o lado que perde paga taker (0,045%) —
    // então inverter alvo e stop move um pouco a conta.
    //
    // O que É verdade: a soma manda MUITO mais que a divisão. Trocar os dois
    // de lugar mexe 0,06 ponto; mudar a soma de 1,7% para 7% mexe 3,2 pontos.
    // Cinquenta vezes mais. A decisão de onde procurar continua de pé — só
    // não com a frase absoluta que eu tinha usado.
    const trocaDeLado = vantagemExigida({ alvo: new Decimal('0.03'), stop: new Decimal('0.04'), taxas: TAXAS_REAIS })
        .minus(vantagemExigida({ alvo: new Decimal('0.04'), stop: new Decimal('0.03'), taxas: TAXAS_REAIS }))
        .abs();
    const mudaASoma = vantagemExigida({ alvo: new Decimal('0.007'), stop: new Decimal('0.010'), taxas: TAXAS_REAIS })
        .minus(vantagemExigida({ alvo: new Decimal('0.03'), stop: new Decimal('0.04'), taxas: TAXAS_REAIS }));

    assert.ok(trocaDeLado.lessThan('0.1'), `troca de lado mexeu ${trocaDeLado}`);
    assert.ok(mudaASoma.greaterThan('3'), `mudar a soma mexeu ${mudaASoma}`);
    assert.ok(
        mudaASoma.dividedBy(trocaDeLado).greaterThan(20),
        `a soma tem de pesar >20x mais que a divisão, deu ${mudaASoma.dividedBy(trocaDeLado)}`,
    );
});

test('a derrapagem encarece a exigência, e é por isso que ela precisa ser medida', () => {
    const sem = vantagemExigida({ alvo: new Decimal('0.03'), stop: new Decimal('0.04'), taxas: TAXAS_REAIS });
    const com = vantagemExigida({
        alvo: new Decimal('0.03'),
        stop: new Decimal('0.04'),
        taxas: TAXAS_REAIS,
        derrapagem: new Decimal('0.001'), // 0,1% de escorregão
    });
    assert.ok(com.greaterThan(sem));
});

test('alvo menor que a taxa é impossível, não apenas ruim', () => {
    const exigida = vantagemExigida({
        alvo: new Decimal('0.0002'), // 0,02% — menor que a taxa de entrada
        stop: new Decimal('0.0002'),
        taxas: TAXAS_REAIS,
    });
    assert.ok(exigida.greaterThan(30), `exigência tem de ser enorme, deu ${exigida}`);
});
