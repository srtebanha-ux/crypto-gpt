import test from 'node:test';
import assert from 'node:assert/strict';
import { GovernadorDeVazao, AgrupadorDeAvisos, TETO_DE_ESPERA_MS } from './vazaoDoProvedor';

/** Um relogio e um sono falsos: nada de tempo real num teste de tempo. */
function falso() {
    let t = 0;
    const dormiu: number[] = [];
    return {
        agora: () => t,
        andar: (ms: number) => { t += ms; },
        dormir: async (ms: number) => { dormiu.push(ms); t += ms; },
        dormiu,
    };
}

test('a concorrência tem teto, e a sétima chamada espera', async () => {
    const f = falso();
    const g = new GovernadorDeVazao(6, f.agora, f.dormir);
    const soltar: Array<() => void> = [];
    for (let i = 0; i < 6; i += 1) soltar.push(await g.vez('eth_call'));
    assert.equal(g.estado().emVoo, 6);
    let setimaEntrou = false;
    const setima = g.vez('eth_call').then((s) => { setimaEntrou = true; return s; });
    await new Promise((r) => { setImmediate(r); });
    assert.equal(setimaEntrou, false, 'a sétima espera na fila');
    assert.equal(g.estado().naFila, 1);
    soltar[0]!();
    await setima;
    assert.equal(setimaEntrou, true, 'e entra quando uma vaga sai');
});

test('o recuo é COMPARTILHADO: uma recusa recua todo mundo', async () => {
    const f = falso();
    const g = new GovernadorDeVazao(6, f.agora, f.dormir);
    const primeira = g.recuar(1000, 8000);
    assert.equal(primeira, 1000);
    assert.equal(g.recuoRestanteMs(), 1000, 'quem nem viu a recusa também recua');
    // Progressivo, com teto.
    assert.equal(g.recuar(1000, 8000), 2000);
    assert.equal(g.recuar(1000, 8000), 4000);
    assert.equal(g.recuar(1000, 8000), 8000);
    assert.equal(g.recuar(1000, 8000), 8000, 'o teto segura');
    // Uma chamada que passa volta o recuo ao chão.
    g.deuCerto();
    assert.equal(g.recuoRestanteMs(), 0);
    assert.equal(g.recuar(1000, 8000), 1000, 'e a escada recomeça de baixo');
});

test('ESSENCIAL atravessa o recuo; DEMORADA espera', async () => {
    const f = falso();
    const g = new GovernadorDeVazao(6, f.agora, f.dormir);
    g.recuar(8000, 8000);
    const soltarE = await g.vez('eth_call', 'essencial');
    soltarE();
    assert.equal(f.dormiu[0], TETO_DE_ESPERA_MS.essencial,
        'a brasa espera no máximo 250ms: o alvo cruza num bloco de 2s');
    const g2 = new GovernadorDeVazao(6, falso().agora, f.dormir);
    g2.recuar(8000, 8000);
    const soltarD = await g2.vez('eth_getLogs', 'demorada');
    soltarD();
    assert.ok(f.dormiu[1]! > TETO_DE_ESPERA_MS.essencial, 'o censo espera mais que a brasa');
});

test('a vaga é liberada mesmo quando a chamada estoura', async () => {
    const f = falso();
    const g = new GovernadorDeVazao(1, f.agora, f.dormir);
    const soltar = await g.vez('eth_call');
    try { throw new Error('a rede caiu'); } catch { soltar(); }
    assert.equal(g.estado().emVoo, 0, 'senão a vazão travaria para sempre');
    soltar();
    assert.equal(g.estado().emVoo, 0, 'liberar duas vezes não cria vaga do nada');
});

test('a contagem é por MÉTODO e por PRIORIDADE, que é fato — não por CU', async () => {
    const f = falso();
    const g = new GovernadorDeVazao(6, f.agora, f.dormir);
    (await g.vez('eth_call', 'essencial'))();
    (await g.vez('eth_call', 'essencial'))();
    (await g.vez('eth_getLogs', 'demorada'))();
    assert.deepEqual(g.contagem.porMetodo, { eth_call: 2, eth_getLogs: 1 });
    assert.deepEqual(g.contagem.porPrioridade, { essencial: 2, normal: 0, demorada: 1 });
    // E nao existe campo de CU: o provedor nao devolve credito consumido, e
    // inventa-lo a partir da contagem seria numero nao medido.
    // A asserção olha o campo INTEIRO, não um trecho dele: `recusasAbsorvidas`
    // contém as letras "cu" e reprovaria um nome correto. É a terceira vez neste
    // projeto que uma asserção por substring reprova a coisa certa.
    assert.deepEqual(
        Object.keys(g.contagem).filter((k) => /^(cu|cus|creditos?|cobranca)$/i.test(k)
            || /CU$/.test(k) || /Creditos?$|Cobranca$/i.test(k)),
        [],
        'o provedor não devolve crédito consumido; derivá-lo da contagem seria número não medido',
    );
});

test('o agrupador deixa o PRIMEIRO exemplo inteiro e conta o resto', () => {
    const f = falso();
    const a = new AgrupadorDeAvisos(10_000, f.agora);
    const p = a.registrar('request limit reached', { metodo: 'eth_getLogs', lote: 'completa#3' });
    assert.deepEqual(p, { primeira: true, quantos: 1, exemplo: { metodo: 'eth_getLogs', lote: 'completa#3' } });
    for (let i = 0; i < 213; i += 1) {
        assert.equal(a.registrar('request limit reached', {}), null, 'as repetidas não viram linha');
    }
    assert.deepEqual(a.pendentes(), [{ chave: 'request limit reached', quantos: 214 }],
        'mas nenhuma é perdida: as 214 do log real estão contadas');
});

test('passada a janela, a contagem SAI — silêncio não é resposta', () => {
    const f = falso();
    const a = new AgrupadorDeAvisos(10_000, f.agora);
    a.registrar('x', { exemplo: 1 });
    a.registrar('x', {});
    f.andar(10_001);
    const saida = a.registrar('x', {});
    assert.equal(saida?.primeira, false);
    assert.equal(saida?.quantos, 3);
    assert.deepEqual(saida?.exemplo, { exemplo: 1 }, 'o exemplo guardado é o primeiro, inteiro');
    assert.deepEqual(a.pendentes(), [], 'e a contagem zera depois de sair');
});

test('chaves diferentes não se misturam', () => {
    const f = falso();
    const a = new AgrupadorDeAvisos(10_000, f.agora);
    assert.equal(a.registrar('taxa', {})?.primeira, true);
    assert.equal(a.registrar('cota', {})?.primeira, true, 'cota pede ação oposta: linha própria');
});
