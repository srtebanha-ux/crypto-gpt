// O cronômetro: as REGRAS que ela nomeou sobre medir latência.
import test from 'node:test';
import assert from 'node:assert';
import {
    cronometrar, idDeAvaliacao, percentil, LivroDeTempos, comoLerOsTempos,
} from './cronometro';

const dormir = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

test('PARALELO não entra na soma sequencial — a parede do grupo entra uma vez', async () => {
    // Duas simulações (V1 e V2) correm juntas, ~60ms cada. Somar as duas daria
    // 120ms de "caminho crítico" para um bot que gastou 60.
    const c = cronometrar('x', 'real', '0xaa', 1);
    const f1 = c.etapa('simulacao', 'contratos');
    const f2 = c.etapa('simulacao', 'contratos');
    await dormir(60);
    f1(); f2();
    const a = c.fechar('ok');
    const livro = new LivroDeTempos();
    livro.guardar(a);
    const r = livro.resumo('real');
    assert.equal(a.marcas.filter((m) => m.paralelo).length, 2);
    // A soma das marcas é ~120; o caminho crítico tem de ser ~60.
    const somaCrua = a.marcas.reduce((s, m) => s + m.ms, 0);
    assert.ok(somaCrua > 110, `as duas marcas somam ${somaCrua}`);
    assert.ok(r.somaSequencialP50! < 100,
        `o caminho crítico somou paralelas: ${r.somaSequencialP50}ms`);
    assert.ok(r.paredeDosGrupos.contratos!.p50! >= 55);
});

test('o relógio é MONOTÔNICO: nenhuma duração negativa', () => {
    const c = cronometrar(idDeAvaliacao(), 'controlado');
    const f = c.etapa('leitura');
    const ms = f();
    assert.ok(ms >= 0, 'hrtime não anda para trás; Date.now() andaria');
    assert.ok(c.fechar('ok').totalMs! >= 0);
});

test('cada avaliação tem id PRÓPRIO, e os ids não repetem', () => {
    const ids = new Set(Array.from({ length: 200 }, () => idDeAvaliacao()));
    assert.equal(ids.size, 200);
});

test('esperas, retentativas, timeouts e recusas são REGISTRADOS', () => {
    const c = cronometrar('y', 'real');
    c.etapa('cotacao')({ comoCorreu: 'timeout', tentativas: 3, esperaMs: 400, detalhe: 'binance' });
    c.etapa('simulacao')({ comoCorreu: 'recusada', detalhe: '0xb629b0e4' });
    c.etapa('leitura')({ comoCorreu: 'falhou', tentativas: 2 });
    const livro = new LivroDeTempos();
    livro.guardar(c.fechar('recusada', 'a simulação reverteu'));
    const r = livro.resumo('real');
    const cot = r.etapas.find((e) => e.etapa === 'cotacao')!;
    assert.equal(cot.desfechos.timeout, 1);
    assert.equal(cot.tentativasExtras, 2, '3 tentativas = 2 extras');
    assert.equal(cot.esperaTotalMs, 400);
    assert.equal(r.etapas.find((e) => e.etapa === 'simulacao')!.desfechos.recusada, 1);
    assert.equal(r.etapas.find((e) => e.etapa === 'leitura')!.desfechos.falhou, 1);
    assert.match(comoLerOsTempos(r), /timeout/);
    assert.match(comoLerOsTempos(r), /retent\./);
});

test('CONTROLADO e REAL não se misturam', () => {
    const livro = new LivroDeTempos();
    const umDe = (cenario: 'real' | 'controlado', ms: number) => {
        const c = cronometrar(idDeAvaliacao(), cenario);
        const f = c.etapa('montagem');
        const ini = Date.now();
        while (Date.now() - ini < ms) { /* queima tempo de propósito */ }
        f();
        return c.fechar('ok');
    };
    livro.guardar(umDe('controlado', 30));
    livro.guardar(umDe('real', 1));
    assert.equal(livro.quantas(), 2);
    assert.equal(livro.quantas('real'), 1);
    assert.equal(livro.quantas('controlado'), 1);
    const real = livro.resumo('real'); const ctrl = livro.resumo('controlado');
    assert.equal(real.amostras, 1);
    assert.ok(ctrl.total.p50! > real.total.p50!, 'o controlado não contaminou o real');
});

test('amostras ZERO não viram "o bot é rápido"', () => {
    const r = new LivroDeTempos().resumo('real');
    assert.equal(r.amostras, 0);
    assert.equal(r.total.p50, null, 'percentil de lista vazia é null, não zero');
    assert.match(comoLerOsTempos(r), /não é "o bot é rápido"/);
});

test('o resumo DIZ o que não mede: inclusão', () => {
    const r = new LivroDeTempos().resumo('real');
    assert.match(r.oQueIssoNaoMede, /INCLUSÃO/);
    assert.match(r.oQueIssoNaoMede, /não prova captura/);
});

test('o gargalo é a etapa de maior mediana, e null sem amostra', () => {
    const livro = new LivroDeTempos();
    assert.equal(livro.gargalo('real'), null);
    const c = cronometrar('z', 'real');
    const lento = c.etapa('leitura');
    const ini = Date.now();
    while (Date.now() - ini < 25) { /* queima */ }
    lento();
    c.etapa('decisao')();
    livro.guardar(c.fechar('ok'));
    assert.equal(livro.gargalo('real')!.etapa, 'leitura');
});

test('percentil: vazio é null, e os cortes são os esperados', () => {
    assert.equal(percentil([], 0.5), null);
    assert.equal(percentil([5], 0.99), 5);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentil(v, 0.5), 50);
    assert.equal(percentil(v, 0.9), 90);
    assert.equal(percentil(v, 0.99), 99);
});

test('o livro tem TETO: medir não vaza memória', () => {
    const livro = new LivroDeTempos(10);
    for (let i = 0; i < 50; i++) livro.guardar(cronometrar(`i${i}`, 'real').fechar('ok'));
    assert.equal(livro.quantas(), 10);
});

test('marcarDuracao registra etapa medida FORA, e recusa número torto', () => {
    const c = cronometrar('s', 'real');
    c.marcarDuracao('sinal', 12.5, { detalhe: 'aviso de bloco' });
    c.marcarDuracao('sinal', -5);        // negativo não entra como negativo
    c.marcarDuracao('sinal', NaN);       // NaN não envenena o percentil
    const livro = new LivroDeTempos();
    livro.guardar(c.fechar('ok'));
    const e = livro.resumo('real').etapas.find((x) => x.etapa === 'sinal')!;
    assert.equal(e.amostras, 3);
    assert.equal(e.p50, 0, 'os tortos entraram como 0, não como NaN');
    assert.equal(e.max, 12.5);
    assert.ok(Number.isFinite(livro.resumo('real').somaSequencialP50!));
});

test('a frase NÃO chama a parede do ciclo de latência', () => {
    const livro = new LivroDeTempos();
    const c = cronometrar('p', 'real');
    c.marcarDuracao('leitura', 50);
    livro.guardar(c.fechar('ok'));
    const f = comoLerOsTempos(livro.resumo('real'));
    assert.match(f, /LATÊNCIA \(caminho crítico/);
    assert.match(f, /INCLUI o sono da postura/,
        'a parede do ciclo tem de DIZER que inclui o sono: 8000ms publicados como '
        + 'latência seriam um número que não descreve o que o nome diz');
});
