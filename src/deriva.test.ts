import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { SAUDE_UM } from './posicoes';
import {
    registrar, esquecerQuemSaiu, projetar, oQueVemPorAi, emQuantoTempo, blocosAteCruzar,
    INTERVALO_DA_AMOSTRA_MS, MINIMO_DE_AMOSTRAS, MAX_AMOSTRAS, type Amostra,
} from './deriva';
import { posturaPorChegada, posturaMaisForte, posturaPorMargem, valeArmar,
    atirarAntesDoCruzamento } from './adiantar';

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

test('o intervalo é respeitado, e agora ele é de segundos e não de dez minutos', () => {
    // O título deste teste dizia "8s de ciclo não move juro". MEDIDO em
    // 2026-09-28 e é falso: a deriva da posição 0x4015e52c foi 4,02e-10 de saúde
    // por bloco medida em 60 segundos, e 3,97e-10 medida em QUATRO segundos —
    // diferença de 1%. Com 18 casas, quatro segundos de juro são 1,6e-9, ou
    // 1.600.000.000 de unidades cruas. Não é ruído.
    //
    // O custo daquela suposição: três amostras a dez minutos deixavam o previsor
    // cego por vinte minutos depois de cada reinício do container.
    const h = new Map<string, Amostra[]>();
    // Dentro do intervalo, ainda não guarda: a regra continua de pé.
    registrar(h, '0xA', saude(1.05), 0);
    registrar(h, '0xA', saude(1.0499), INTERVALO_DA_AMOSTRA_MS - 1);
    assert.equal(h.get('0xa')!.length, 1);
    // Completado o intervalo, guarda.
    registrar(h, '0xA', saude(1.0498), INTERVALO_DA_AMOSTRA_MS);
    assert.equal(h.get('0xa')!.length, 2);
    // E o intervalo é de segundos, não de dez minutos — é isso que torna a
    // primeira projeção possível em menos de meio minuto.
    assert.ok(INTERVALO_DA_AMOSTRA_MS <= 30_000,
        `o intervalo é ${INTERVALO_DA_AMOSTRA_MS}ms: com 3 amostras isso é `
        + `${(3 * INTERVALO_DA_AMOSTRA_MS) / 1000}s de cegueira depois de cada reinício`);
});

test('o histórico é limitado: não cresce para sempre', () => {
    const h = new Map<string, Amostra[]>();
    const passo = INTERVALO_DA_AMOSTRA_MS;
    for (let i = 0; i < 50; i++) registrar(h, '0xA', saude(1.05 - i * 0.0001), i * passo);
    assert.equal(h.get('0xa')!.length, MAX_AMOSTRAS);
    // E o que sobrou são as MAIS NOVAS, não as primeiras.
    assert.equal(h.get('0xa')![MAX_AMOSTRAS - 1]!.em, 49 * passo);
    assert.equal(h.get('0xa')![0]!.em, (50 - MAX_AMOSTRAS) * passo);
});

test('a deriva REAL de 2026-09-28 é projetável em quatro segundos', () => {
    // Os números crus lidos na Base, blocos antes de 0x4015e52c ser liquidada.
    // Este teste existe para provar que a amostragem rápida enxerga o que a de
    // dez minutos enxergava — e enxerga vinte minutos mais cedo.
    const cru = (n: string) => new Decimal(n);
    const amostras: Amostra[] = [
        { em: 0,    saude: cru('1000000002834062669') },  // -8 blocos
        { em: 4000, saude: cru('1000000002023820565') },  // -6 blocos
        { em: 8000, saude: cru('1000000001213578466') },  // -4 blocos
    ];
    // `agora` = o instante da última amostra: a projeção conta DAQUI, não da
    // amostra. Sem passar isso, uma leitura de 8s atrás desloca a origem em quatro
    // blocos da Base — duas vezes a janela de disparo.
    const b = blocosAteCruzar(amostras, 2000, 8000);
    assert.ok(b !== null, 'três amostras de 4s têm de dar projeção');
    // Ela cruzou entre 3 e 4 blocos depois da última amostra. A conta tem de
    // cair nessa vizinhança, não em minutos nem em dias.
    assert.ok(b!.blocos > 1 && b!.blocos < 6, `projetou ${b!.blocos} blocos`);
    // E a taxa sai como juro plausível, não como preço: as guardas não barram.
    assert.ok(b!.taxaAnual.greaterThan(0), `taxa ${b!.taxaAnual}`);
    assert.ok(b!.taxaAnual.lessThan(1), 'abaixo do teto de 100%/ano, senão seria preço');
});

test('blocosAteCruzar devolve null quando não pode responder', () => {
    const cru = (n: string) => new Decimal(n);
    // Duas amostras não bastam.
    assert.equal(blocosAteCruzar([
        { em: 0, saude: cru('1000000002834062669') },
        { em: 4000, saude: cru('1000000002023820565') },
    ], 2000, 4000), null);
    // Saúde subindo não cruza nada.
    assert.equal(blocosAteCruzar([
        { em: 0, saude: cru('1000000001213578466') },
        { em: 4000, saude: cru('1000000002023820565') },
        { em: 8000, saude: cru('1000000002834062669') },
    ], 2000, 8000), null);
    // Bloco de duração zero ou negativa não é resposta, é divisão por zero.
    assert.equal(blocosAteCruzar([
        { em: 0,    saude: cru('1000000002834062669') },
        { em: 4000, saude: cru('1000000002023820565') },
        { em: 8000, saude: cru('1000000001213578466') },
    ], 0, 8000), null);
    // E NaN em msPorBloco não pode virar `{blocos: NaN}`: antes virava, e isso
    // desligava o tiro em silêncio enquanto o ensaio dizia LIGADO.
    assert.equal(blocosAteCruzar([
        { em: 0,    saude: cru('1000000002834062669') },
        { em: 4000, saude: cru('1000000002023820565') },
        { em: 8000, saude: cru('1000000001213578466') },
    ], Number('2,000'), 8000), null);
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

// ---------------------------------------------------------------------------
// A postura da chegada por juro.
//
// Existe por dois campos lado a lado no log de 2026-09-27 10:31:
//
//   margemDoAlvo: "precisa cair 1.1562% para virar alvo"
//   mercado:      "0.1007% abaixo do oráculo (dormindo)"
//
// O alvo mais próximo tem garantia USDC contra dívida USDC: o preço CANCELA na
// conta da saúde dele. Ele não precisa do mercado para cair. E toda a prontidão
// estava amarrada no mercado — ele chegaria com o bot dormindo e desarmado.
// ---------------------------------------------------------------------------

test('chegada longe não acorda ninguém: 283 dias é para dormir', () => {
    assert.equal(posturaPorChegada(283 * DIA), 'dormindo');
});

test('chegada dentro de uma hora deixa o bot atento', () => {
    assert.equal(posturaPorChegada(50 * MIN), 'atento');
});

test('chegada em dez minutos põe o dedo no gatilho', () => {
    assert.equal(posturaPorChegada(9 * MIN), 'dedo no gatilho');
    assert.equal(posturaPorChegada(0), 'dedo no gatilho', 'chegando agora é a hora de correr');
});

test('sem projeção NÃO vira urgência: null dorme', () => {
    // O oposto seria o pior caso possível: não saber quando o alvo chega e
    // tratar isso como "chega já", correndo a 200ms para sempre.
    assert.equal(posturaPorChegada(null), 'dormindo');
    assert.equal(posturaPorChegada(NaN), 'dormindo');
    assert.equal(posturaPorChegada(Infinity), 'dormindo');
    assert.equal(posturaPorChegada(-1), 'dormindo');
});

test('a postura combinada é a MAIS urgente, nunca a última calculada', () => {
    assert.equal(posturaMaisForte('dormindo', 'atento'), 'atento');
    assert.equal(posturaMaisForte('atento', 'dormindo'), 'atento');
    assert.equal(posturaMaisForte('atento', 'dedo no gatilho'), 'dedo no gatilho');
    assert.equal(posturaMaisForte('dedo no gatilho', 'atento'), 'dedo no gatilho');
    assert.equal(posturaMaisForte('dormindo', 'dormindo'), 'dormindo');
});

test('o caso exato do log: mercado dormindo + juro chegando = bot acordado', () => {
    // 0,1007% de queda não alcança o limiar de escrita do feed (0,5%), então o
    // mercado manda dormir. Com o juro a 40 minutos, o bot tem de estar atento.
    const doMercado = posturaPorMargem(new Decimal('0.1007'), new Decimal('1.1562'));
    assert.equal(doMercado, 'dormindo', 'é isso que o log mostrava');
    const combinada = posturaMaisForte(doMercado, posturaPorChegada(40 * MIN));
    assert.equal(combinada, 'atento', 'e é isso que ele passa a fazer');
    // E armar deixa de ser recusado, que era o buraco.
    assert.equal(valeArmar(doMercado, 10_000, 5_000), false, 'o defeito');
    assert.equal(valeArmar(combinada, 10_000, 5_000), true, 'o conserto');
});

test('juro chegando não estraga o ritmo quando o mercado já está correndo', () => {
    const combinada = posturaMaisForte('dedo no gatilho', posturaPorChegada(283 * DIA));
    assert.equal(combinada, 'dedo no gatilho');
});

test('a conta de CU de uma chegada: generoso e ainda assim desprezível', () => {
    // Uma hora a 1s mais dez minutos a 200ms, a 26 CUs por leitura.
    const cus = (3600 / 1) * 26 + (600 / 0.2) * 26;
    assert.equal(cus, 171_600);
    // Contra um teto de 38 milhões por mês, e chegadas separadas por MESES.
    assert.ok(cus < 38_000_000 * 0.005, `${cus} CUs é meio por cento do teto`);
});

test('atirar antes do cruzamento: a única forma de ganhar uma de juro', () => {
    // Medido em 2026-09-28: a posição 0x4015e52c ficou a 0,0000024% de liquidar
    // por mais de dois minutos e foi levada no bloco EXATO em que cruzou. O bot lê
    // o estado depois do bloco minerado, então quando ele vê "liquidável" já foi.
    const base = { modoProva: true, aceitaPrejuizo: true };

    // Dentro da janela: manda.
    const perto = atirarAntesDoCruzamento({ ...base, blocosAteCruzar: 1.4 });
    assert.equal(perto.atira, true);
    assert.match(perto.porque, /mando AGORA/);
    assert.match(perto.porque, /o gás é perdido/, 'o preço tem de sair escrito');

    // Longe: não manda.
    assert.equal(atirarAntesDoCruzamento({ ...base, blocosAteCruzar: 50 }).atira, false);

    // "Não sei" NÃO é "está perto" — é o defeito que este projeto mais comete.
    const naoSei = atirarAntesDoCruzamento({ ...base, blocosAteCruzar: null });
    assert.equal(naoSei.atira, false);
    assert.match(naoSei.porque, /"não sei" não é "está perto"/);

    // Sem modo prova a chave é inerte: é lá que mora a trava de um tiro só.
    assert.equal(atirarAntesDoCruzamento({ ...base, modoProva: false, blocosAteCruzar: 1 }).atira, false);
    // E sem ela ter aceitado pagar por um tiro que pode reverter, não sai.
    assert.equal(atirarAntesDoCruzamento({ ...base, aceitaPrejuizo: false, blocosAteCruzar: 1 }).atira, false);

    // Projeção inválida não vira tiro.
    for (const b of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(atirarAntesDoCruzamento({ ...base, blocosAteCruzar: b }).atira, false, `blocos ${b}`);
    }
    // Janela zero não pode virar "atira sempre".
    assert.equal(atirarAntesDoCruzamento({ ...base, blocosAteCruzar: 0, janelaDeBlocos: 0 }).atira, false);
});

test('o caso real inteiro: da leitura crua até a decisão de atirar', () => {
    // As três amostras de 4 segundos que a amostragem rápida agora consegue tirar,
    // com os números crus lidos na Base.
    const cru = (n: string) => new Decimal(n);
    const b = blocosAteCruzar([
        { em: 0,    saude: cru('1000000002834062669') },
        { em: 4000, saude: cru('1000000002023820565') },
        { em: 8000, saude: cru('1000000001213578466') },
    ], 2000, 8000);
    assert.ok(b !== null);
    // E com a janela de 2 blocos que é o padrão, isso vira tiro.
    const d = atirarAntesDoCruzamento({
        blocosAteCruzar: b!.blocos, modoProva: true, aceitaPrejuizo: true, janelaDeBlocos: 4,
    });
    assert.equal(d.atira, true, `${b!.blocos} blocos: ${d.porque}`);
});

test('a projeção conta de AGORA, não da última amostra', () => {
    // Este era o defeito que derrotava a coisa toda: `projetar` devolve
    // milissegundos a partir da ÚLTIMA AMOSTRA. Com a amostragem de 8s, a origem
    // podia estar QUATRO blocos da Base atrasada contra uma janela de disparo de
    // dois — uma posição que cruzava no próximo bloco lia "cruza em 5" e nunca era
    // atirada.
    const cru = (n: string) => new Decimal(n);
    const amostras: Amostra[] = [
        { em: 0,    saude: cru('1000000002834062669') },
        { em: 4000, saude: cru('1000000002023820565') },
        { em: 8000, saude: cru('1000000001213578466') },
    ];
    const naHora = blocosAteCruzar(amostras, 2000, 8000)!;
    // Ela cruza em ~3 blocos a partir da última amostra. DOIS segundos depois — um
    // bloco — a mesma série tem de projetar UM BLOCO MENOS.
    const umBlocoDepois = blocosAteCruzar(amostras, 2000, 10000)!;
    assert.ok(Math.abs((naHora.blocos - umBlocoDepois.blocos) - 1) < 0.01,
        `de ${naHora.blocos} para ${umBlocoDepois.blocos}: a diferença devia ser 1 bloco`);
    // E é isso que decide o tiro: com janela de 2 blocos, a leitura na hora NÃO
    // dispara (2.99 > 2) e um bloco depois DISPARA (1.99 <= 2). Sem descontar o
    // tempo, as duas diriam a mesma coisa e o bot atiraria na hora errada.
    const janelaDeBlocos = 2;
    assert.equal(atirarAntesDoCruzamento({
        blocosAteCruzar: naHora.blocos, modoProva: true, aceitaPrejuizo: true, janelaDeBlocos,
    }).atira, false);
    assert.equal(atirarAntesDoCruzamento({
        blocosAteCruzar: umBlocoDepois.blocos, modoProva: true, aceitaPrejuizo: true, janelaDeBlocos,
    }).atira, true);

    // E quando a projeção já passou, o resultado é zero — não um número negativo
    // nem "cruza agora" sobre uma leitura velha.
    const passou = blocosAteCruzar(amostras, 2000, 8000 + 60_000)!;
    assert.equal(passou.blocos, 0);

    // `agora` inválido não vira projeção.
    assert.equal(blocosAteCruzar(amostras, 2000, Number.NaN), null);
});
