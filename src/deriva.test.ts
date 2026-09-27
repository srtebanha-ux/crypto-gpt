import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { SAUDE_UM } from './posicoes';
import {
    registrar, esquecerQuemSaiu, projetar, oQueVemPorAi, emQuantoTempo,
    INTERVALO_DA_AMOSTRA_MS, MINIMO_DE_AMOSTRAS, type Amostra,
} from './deriva';

const MIN = 60_000;
const HORA = 3_600_000;
const DIA = 86_400_000;
const saude = (vezes: number | string) => new Decimal(vezes).mul(SAUDE_UM);

/** Uma serie que decai exponencialmente a `taxaAnual`, como juro faz. */
function serieDeJuro(s0: number, taxaAnual: number, quantas: number, passoMs: number): Amostra[] {
    const k = -taxaAnual / (365 * 24 * 3600 * 1000);
    return Array.from({ length: quantas }, (_, i) => ({
        em: 1_000_000 + i * passoMs,
        saude: saude(new Decimal(s0).mul(new Decimal(Math.E).pow(k * i * passoMs)).toString()),
    }));
}

// ---------------------------------------------------------------------------
// A medicao que originou o arquivo.
// ---------------------------------------------------------------------------

test('a taxa medida nos dois ensaios em seco é 4,911% ao ano', () => {
    // 45869907 -> 45869948 em 9,566 minutos. É a dívida, não a saúde, mas a
    // ordem de grandeza é a mesma e é ela que define o teto do plausível.
    const cresceu = (45869948 - 45869907) / 45869907;
    const aoAno = cresceu * ((365 * 24 * 60) / 9.566);
    assert.equal((aoAno * 100).toFixed(3), '4.911');
    // E é juro de stablecoin: cabe folgado dentro do teto de 100% ao ano.
    assert.ok(aoAno < 1);
});

test('uma posição a 5% ao ano com saúde 1,05 cruza em cerca de um ano', () => {
    const s = serieDeJuro(1.05, 0.05, 4, 10 * MIN);
    const p = projetar(s);
    assert.ok(p.cruza, p.cruza ? '' : p.porque);
    if (!p.cruza) return;
    assert.equal(p.taxaAnual.toFixed(3), '0.050');
    // ln(1,05)/0,05 = 0,976 ano.
    assert.equal((p.emMs / (365 * DIA)).toFixed(2), '0.98');
});

test('saúde mais apertada chega muito antes, na mesma taxa', () => {
    const p = projetar(serieDeJuro(1.001, 0.05, 4, 10 * MIN));
    assert.ok(p.cruza);
    if (!p.cruza) return;
    // ln(1,001)/0,05 = 0,02 ano = 7,3 dias. É ESTE o alvo que vale vigiar.
    assert.equal((p.emMs / DIA).toFixed(1), '7.3');
});

// ---------------------------------------------------------------------------
// As tres guardas. Metade do arquivo é isto, e é de propósito.
// ---------------------------------------------------------------------------

test('RECUSA extrapolar preço: 0,1% de queda em 30min daria 1.752% ao ano', () => {
    // O defeito que este arquivo existe para não cometer. Uma queda monótona
    // de preço passa a guarda 1 — e é a guarda do TETO que a pega.
    const s: Amostra[] = [
        { em: 0, saude: saude(1.05) },
        { em: 15 * MIN, saude: saude(1.0495) },
        { em: 30 * MIN, saude: saude(1.04895) },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /rápida demais para ser juro/);
});

test('RECUSA quando a saúde vai e volta: preço oscila, juro não', () => {
    const s: Amostra[] = [
        { em: 0, saude: saude(1.05) },
        { em: 10 * MIN, saude: saude(1.0499) },
        { em: 20 * MIN, saude: saude('1.04995') },   // subiu: o ETH recuperou
        { em: 30 * MIN, saude: saude(1.0498) },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /monótona/);
});

test('RECUSA saúde parada: zero não é "cruza em zero"', () => {
    // A guarda 1 exige queda ESTRITA, então ela pega a série parada antes da
    // guarda do k. Dá no mesmo lugar (recusa) e diz uma coisa mais útil.
    const s: Amostra[] = [
        { em: 0, saude: saude(2) },
        { em: 10 * MIN, saude: saude(2) },
        { em: 20 * MIN, saude: saude(2) },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /monótona/);
});

test('RECUSA quando só o último passo empata: um empate no fim já delata', () => {
    const s: Amostra[] = [
        { em: 0, saude: saude(1.05) },
        { em: 10 * MIN, saude: saude('1.0499') },
        { em: 20 * MIN, saude: saude('1.0499') },
    ];
    assert.equal(projetar(s).cruza, false);
});

test('RECUSA saúde SUBINDO: quem está melhorando não chega nunca', () => {
    const s: Amostra[] = [
        { em: 0, saude: saude(1.05) },
        { em: 10 * MIN, saude: saude(1.06) },
        { em: 20 * MIN, saude: saude(1.07) },
    ];
    assert.equal(projetar(s).cruza, false);
});

test('RECUSA deriva de arredondamento: um wei de saúde por hora não é tendência', () => {
    const s: Amostra[] = [
        { em: 0, saude: new Decimal('2000000000000000002') },
        { em: HORA, saude: new Decimal('2000000000000000001') },
        { em: 2 * HORA, saude: new Decimal('2000000000000000000') },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /ruído de arredondamento/);
});

test('RECUSA com poucas amostras, e o porquê diz quantas faltam', () => {
    const s = serieDeJuro(1.05, 0.05, 2, 10 * MIN);
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /só 2 amostra\(s\); preciso de 3/);
    assert.equal(MINIMO_DE_AMOSTRAS, 3);
});

test('duas amostras NÃO viram tendência mesmo com a diferença certa', () => {
    // A armadilha: duas leituras sempre definem uma reta. Aceitá-las seria
    // transformar uma diferença qualquer numa previsão.
    assert.equal(projetar([
        { em: 0, saude: saude(1.05) },
        { em: 10 * MIN, saude: saude('1.0499999') },
    ]).cruza, false);
});

test('quem já está liquidável cruza em zero, não em número negativo', () => {
    const s: Amostra[] = [
        { em: 0, saude: saude(1.02) },
        { em: 10 * MIN, saude: saude(1.01) },
        { em: 20 * MIN, saude: saude('0.999') },
    ];
    const p = projetar(s);
    assert.ok(p.cruza);
    if (!p.cruza) return;
    assert.equal(p.emMs, 0);
});

test('amostras sem tempo entre elas não geram divisão por zero', () => {
    const s: Amostra[] = [
        { em: 500, saude: saude(1.05) },
        { em: 500, saude: saude(1.04) },
        { em: 500, saude: saude(1.03) },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /sem tempo entre elas/);
});

test('saúde zero não explode no logaritmo', () => {
    const s: Amostra[] = [
        { em: 0, saude: saude(1) },
        { em: 10 * MIN, saude: saude('0.5') },
        { em: 20 * MIN, saude: new Decimal(0) },
    ];
    const p = projetar(s);
    assert.equal(p.cruza, false);
    if (p.cruza) return;
    assert.match(p.porque, /zero ou negativa/);
});

// ---------------------------------------------------------------------------
// O histórico: amostrar sem encher a memória, e esquecer o que saiu.
// ---------------------------------------------------------------------------

test('não guarda duas amostras dentro do intervalo: 8s de ciclo não move juro', () => {
    const h = new Map<string, Amostra[]>();
    for (let t = 0; t < 10 * MIN; t += 8000) registrar(h, '0xA', saude(1.05), t);
    assert.equal(h.get('0xa')!.length, 1, 'mais de uma amostra em dez minutos é lixo');
    registrar(h, '0xA', saude(1.049), INTERVALO_DA_AMOSTRA_MS);
    assert.equal(h.get('0xa')!.length, 2);
});

test('o histórico é limitado: não cresce para sempre', () => {
    const h = new Map<string, Amostra[]>();
    for (let i = 0; i < 50; i++) registrar(h, '0xA', saude(1.05 - i * 0.0001), i * 10 * MIN);
    assert.equal(h.get('0xa')!.length, 6);
    // E o que sobrou são as SEIS MAIS NOVAS, não as seis primeiras.
    assert.equal(h.get('0xa')![5]!.em, 49 * 10 * MIN);
    assert.equal(h.get('0xa')![0]!.em, 44 * 10 * MIN);
});

test('o devedor é normalizado: maiúscula e minúscula são a mesma pessoa', () => {
    const h = new Map<string, Amostra[]>();
    registrar(h, '0xAbC', saude(1.05), 0);
    registrar(h, '0xabc', saude(1.04), 10 * MIN);
    assert.equal(h.size, 1);
    assert.equal(h.get('0xabc')!.length, 2);
});

test('esquece quem saiu da brasa: reta em cima de dois regimes inventa previsão', () => {
    const h = new Map<string, Amostra[]>();
    registrar(h, '0xA', saude(1.05), 0);
    registrar(h, '0xB', saude(1.05), 0);
    assert.equal(esquecerQuemSaiu(h, ['0xA']), 1);
    assert.deepEqual([...h.keys()], ['0xa']);
});

test('esquecer aceita endereços em qualquer caixa', () => {
    const h = new Map<string, Amostra[]>();
    registrar(h, '0xabc', saude(1.05), 0);
    assert.equal(esquecerQuemSaiu(h, ['0xABC']), 0, 'não pode apagar quem continua vivo');
    assert.equal(h.size, 1);
});

// ---------------------------------------------------------------------------
// A fila de chegada.
// ---------------------------------------------------------------------------

test('a fila de chegada sai ORDENADA pelo tempo, não pela ordem do Map', () => {
    const h = new Map<string, Amostra[]>();
    h.set('0xtarde', serieDeJuro(1.05, 0.05, 4, 10 * MIN));   // ~1 ano
    h.set('0xcedo', serieDeJuro(1.0005, 0.05, 4, 10 * MIN));  // ~3,6 dias
    h.set('0xmeio', serieDeJuro(1.01, 0.05, 4, 10 * MIN));    // ~73 dias
    const fila = oQueVemPorAi(h, 2 * 365 * DIA);
    assert.deepEqual(fila.map((c) => c.devedor), ['0xcedo', '0xmeio', '0xtarde']);
});

test('a janela corta quem chega depois dela', () => {
    const h = new Map<string, Amostra[]>();
    h.set('0xcedo', serieDeJuro(1.0005, 0.05, 4, 10 * MIN));
    h.set('0xtarde', serieDeJuro(1.05, 0.05, 4, 10 * MIN));
    const fila = oQueVemPorAi(h, 7 * DIA);
    assert.deepEqual(fila.map((c) => c.devedor), ['0xcedo']);
});

test('quem não dá projeção simplesmente não entra na fila — não entra como zero', () => {
    const h = new Map<string, Amostra[]>();
    h.set('0xpreco', [
        { em: 0, saude: saude(1.05) },
        { em: 15 * MIN, saude: saude(1.0495) },
        { em: 30 * MIN, saude: saude(1.04895) },
    ]);
    h.set('0xpoucas', serieDeJuro(1.05, 0.05, 2, 10 * MIN));
    assert.deepEqual(oQueVemPorAi(h, 365 * DIA), []);
});

test('emQuantoTempo fala português em cada escala', () => {
    assert.equal(emQuantoTempo(45_000), '45s');
    assert.equal(emQuantoTempo(30 * MIN), '30min');
    assert.equal(emQuantoTempo(5 * HORA), '5.0h');
    assert.equal(emQuantoTempo(7.3 * DIA), '7.3 dias');
});
