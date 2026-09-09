// Arquivo: src/opportunitySniffer.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { evaluateTriangle } from './opportunitySniffer';
import { brutoNecessario, montarTabelaDeTaxas, retencaoDoTriangulo } from './taxaPorPar';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_DOWN });

// A descoberta de topologia (buildTriangles/buildEnginePairTriangles) mudou
// para src/triangleTopology.ts (compartilhada com o engine) — ver
// triangleTopology.test.ts. Este arquivo cobre só o que continua local ao
// sniffer: avaliação de triângulo e a fórmula de spread mínimo exigido.
const triangle = { id: 'USDT-BTC-ETH', leg1: 'BTCUSDT', leg2: 'ETHBTC', leg3: 'ETHUSDT' };
const retentionCubed = new Decimal(1).minus('0.001').pow(3);
const requiredGrossSpread = new Decimal(1).plus('0.0002').dividedBy(retentionCubed);

function tick(bid: string, ask: string): { bid: Decimal; ask: Decimal; timestamp: number } {
    return { bid: new Decimal(bid), ask: new Decimal(ask), timestamp: Date.now() };
}

test('evaluateTriangle detecta a mesma ineficiência clássica usada nos testes do RiskManager', () => {
    const result = evaluateTriangle(
        triangle,
        tick('60000', '60010'), // BTC/USDT
        tick('0.0500', '0.0501'), // ETH/BTC
        tick('3050', '3060'), // ETH/USDT (distorcido)
        retentionCubed,
        requiredGrossSpread
    );
    assert.ok(result);
    assert.equal(result!.isOpportunity, true);
    assert.ok(result!.netProfitPct.greaterThan(0));
});

test('evaluateTriangle não marca oportunidade quando o triângulo está em equilíbrio', () => {
    const p1 = new Decimal('60000');
    const p2 = new Decimal('0.05');
    const p3 = p1.mul(p2); // sem distorção
    const result = evaluateTriangle(triangle, tick('59990', p1.toString()), tick('0.0499', p2.toString()), tick(p3.toString(), '3001'), retentionCubed, requiredGrossSpread);
    assert.ok(result);
    assert.equal(result!.isOpportunity, false);
});

test('evaluateTriangle retorna null para preço não positivo (kill switch de sanidade)', () => {
    const result = evaluateTriangle(triangle, tick('0', '0'), tick('0.0500', '0.0501'), tick('3050', '3060'), retentionCubed, requiredGrossSpread);
    assert.equal(result, null);
});

test('requiredGrossSpread usa a fórmula exata (1+alvo)/retenção³, não a aproximação aditiva alvo+atrito', () => {
    // Fórmula exata: (1 + 0.0002) / (1 - 0.001)^3 - 1 ≈ 0.320661% (verificado também
    // de forma independente em Python: (1.0002/0.997002999 - 1) * 100).
    // A aproximação aditiva ingênua (0.02% + 0.2997% de atrito ≈ 0.3197%) SUBESTIMA
    // o valor real por ignorar o termo de segunda ordem da composição — a diferença é
    // pequena aqui, mas é exatamente o tipo de arredondamento que se acumula em produção.
    assert.equal(requiredGrossSpread.minus(1).mul(100).toFixed(4), '0.3206');
});

// ---------------------------------------------------------------------------
// Taxa por par: o mesmo desalinhamento, dois veredictos
// ---------------------------------------------------------------------------

test('o MESMO desalinhamento é recusado com taxa cheia e aceito com pernas isentas', () => {
    // Este é o teste que registra a virada. A conclusão anterior deste projeto
    // — arbitragem triangular morta — vinha de cobrar a mesma taxa nas três
    // pernas. Com FDUSD isento, o ciclo paga uma perna só, e o desalinhamento
    // que era descartado passa a valer.
    //
    // Os preços abaixo produzem um retorno bruto de ~1,0012 (0,12% de
    // desalinhamento), que é a ordem de grandeza do MELHOR caso encontrado nas
    // 232 mil avaliações reais deste projeto.
    const fdusd = { id: 'USDT-BTC-FDUSD', leg1: 'BTCUSDT', leg2: 'BTCFDUSD', leg3: 'FDUSDUSDT' };

    const tabelaCheia = montarTabelaDeTaxas({ padrao: new Decimal('0.00075'), isentos: [] });
    const tabelaIsenta = montarTabelaDeTaxas({
        padrao: new Decimal('0.00075'),
        isentos: ['BTCFDUSD', 'FDUSDUSDT'],
    });
    const pernas: [string, string, string] = [fdusd.leg1, fdusd.leg2, fdusd.leg3];
    const alvo = new Decimal('0.0002');

    // Um ciclo cujo retorno bruto é 1,0012 — desalinhamento de 0,12%.
    const bruto = new Decimal('1.0012');
    const leg1Ask = new Decimal('100000');
    const leg2Ask = new Decimal('1');
    const leg3Bid = bruto.mul(leg1Ask).mul(leg2Ask);

    const comTaxaCheia = evaluateTriangle(
        fdusd,
        tick('99990', leg1Ask.toString()),
        tick('0.9999', leg2Ask.toString()),
        tick(leg3Bid.toString(), leg3Bid.plus(1).toString()),
        retencaoDoTriangulo(pernas, tabelaCheia),
        brutoNecessario({ pernas, tabela: tabelaCheia, lucroAlvo: alvo }),
    );

    const comIsencao = evaluateTriangle(
        fdusd,
        tick('99990', leg1Ask.toString()),
        tick('0.9999', leg2Ask.toString()),
        tick(leg3Bid.toString(), leg3Bid.plus(1).toString()),
        retencaoDoTriangulo(pernas, tabelaIsenta),
        brutoNecessario({ pernas, tabela: tabelaIsenta, lucroAlvo: alvo }),
    );

    assert.ok(comTaxaCheia && comIsencao);
    assert.equal(comTaxaCheia!.isOpportunity, false, 'com as três pernas taxadas, 0,12% não paga 0,225%');
    assert.equal(comIsencao!.isOpportunity, true, 'com duas pernas isentas, 0,12% paga 0,075% com folga');
    assert.ok(
        comIsencao!.netProfitPct.greaterThan(comTaxaCheia!.netProfitPct),
        'o lucro líquido tem que subir quando o custo cai',
    );
});

test('o lucro líquido de um ciclo TOTALMENTE isento é o desalinhamento inteiro', () => {
    // Sem taxa nenhuma, retenção 1: o que o book oferece é o que sobra.
    const t = { id: 'ISENTO', leg1: 'AFDUSD', leg2: 'BFDUSD', leg3: 'CFDUSD' };
    const pernas: [string, string, string] = [t.leg1, t.leg2, t.leg3];
    const tabela = montarTabelaDeTaxas({
        padrao: new Decimal('0.00075'),
        isentos: ['AFDUSD', 'BFDUSD', 'CFDUSD'],
    });
    const leg3Bid = new Decimal('1.0012').mul(100000);
    const result = evaluateTriangle(
        t,
        tick('99990', '100000'),
        tick('0.9999', '1'),
        tick(leg3Bid.toString(), leg3Bid.plus(1).toString()),
        retencaoDoTriangulo(pernas, tabela),
        brutoNecessario({ pernas, tabela, lucroAlvo: new Decimal('0.0002') }),
    );
    assert.ok(result);
    assert.equal(result!.netProfitPct.toFixed(2), '0.12', 'sem taxa, o líquido é o bruto');
});
