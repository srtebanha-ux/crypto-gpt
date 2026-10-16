import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorizarCotacoes } from './titanPriorizacao';
import type { CandidataMista, Triagem, VeredictoDoSpread } from './rotasMistas';

const candidata = (chave: string): CandidataMista => ({
    chave, token: '0x0000000000000000000000000000000000000001',
    pernas: [],
} as unknown as CandidataMista);
function triagem(): Triagem {
    return {
        valem: [], recusadasPorSpread: [], semDados: 0, semProvaDoInvariante: 0,
        veredictos: new Map<string, VeredictoDoSpread>(),
    };
}
function comSpread(t: Triagem, c: CandidataMista, num: bigint): void {
    t.veredictos.set(c.chave, {
        vale: true, porque: 'teto comprovado',
        razoes: { emprestimo: { num, den: 100n }, venda: { num: 1n, den: 1n } },
    });
}
test('se ha menos rotas que vagas nao omite nada', () => {
    const a = [candidata('a'), candidata('b')];
    assert.deepEqual(priorizarCotacoes(a, triagem(), 8, 0).selecionadas, a);
});
test('o teto usa comparacao exata entre inteiros e nao omite rota sem prova', () => {
    const t = triagem();
    const rotas = Array.from({ length: 20 }, (_, i) => candidata('c'+i));
    for (let i = 0; i < 16; i++) comSpread(t, rotas[i]!, BigInt(101+i));
    const r = priorizarCotacoes(rotas, t, 8, 0);
    assert.equal(r.selecionadas.length, 8);
    assert.equal(r.adiadas, 12);
    assert.equal(r.conhecidas, 6);
    assert.equal(r.semProva, 2);
    assert.deepEqual(r.selecionadas.slice(0, 6).map(x=>x.chave), [
        'c15','c14','c13','c12','c11','c10',
    ]);
    assert.deepEqual(r.selecionadas.slice(6).map(x=>x.chave), ['c16','c17']);
    const p1 = priorizarCotacoes(rotas,t,8,1);
    assert.deepEqual(p1.selecionadas.slice(6).map(x=>x.chave), ['c18','c19']);
});
test('rota sem prova e escalonada tambem quando so sobra uma vaga', () => {
    const t = triagem();
    const a = Array.from({length:12},(_,i)=>candidata('r'+i));
    for (let i=0;i<10;i++) comSpread(t,a[i]!,BigInt(110+i));
    const x=priorizarCotacoes(a,t,3,0);
    assert.equal(x.selecionadas.length,3);
    assert.equal(x.semProva,1);
    assert.equal(x.adiadas,9);
});
test('limites invalidos falham fechados', () => {
    assert.throws(()=>priorizarCotacoes([],triagem(),0,0),/ARB_COTAR_MAX_ROTAS/);
    assert.throws(()=>priorizarCotacoes([],triagem(),257,0),/ARB_COTAR_MAX_ROTAS/);
    assert.throws(()=>priorizarCotacoes([],triagem(),8,-1),/rodada/);
});
