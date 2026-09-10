// Arquivo: src/excursao.test.ts
//
// O erro que estes testes existem para impedir é o que faz backtest bonito
// virar conta vazia: avaliar por FECHAMENTO em vez de por máxima/mínima.
// Avaliado por fechamento, todo stop que foi tocado e voltou desaparece — e
// com ele some justamente a perda que a conta real paga.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { acasoDaCelula, avaliarGrade, desfechoNoCaminho, excursoes, gradePadrao, melhorDaGrade } from './excursao';
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
    const base = { alvos: 30, stops: 20, abertos: 0, taxaDeAcerto: new Decimal('0.6'), evPorOperacao: new Decimal('0.001'), acertoDeEquilibrio: new Decimal('0.5'), acaso: new Decimal('0.5'), z: new Decimal('5') };
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

test('a grade padrão tem 126 combinações — 14 alvos x 9 stops', () => {
    const g = gradePadrao();
    assert.equal(g.alvos.length, 14);
    assert.equal(g.stops.length, 9);
    assert.equal(g.alvos[0].toString(), '0.002');
    assert.equal(g.alvos[13].toString(), '0.015');
});
