import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priorizarCotacoes, MemoriaDeCotacoesNegativas, deveProcessarCotacoes } from './titanPriorizacao';
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
test('estado identico drena fila sem reabrir cooldown negativo antes do prazo',()=>{
 const m=new MemoriaDeCotacoesNegativas(120_000);
 const a={...candidata('a'),pernas:[{pool:'0xab'},{pool:'0xcd'}]} as CandidataMista;
 const b={...a,chave:'b'};
 const estado=new Map([['0xab','1'],['0xcd','2']]);
 m.registrar(a,estado,-1n,true,100);
 assert.equal(deveProcessarCotacoes(false,[a,b],new Set(['b']),m,estado,101),true);
 assert.equal(deveProcessarCotacoes(false,[a],new Set(['a']),m,estado,101),false);
 assert.equal(deveProcessarCotacoes(false,[a],new Set(),m,estado,120_100),true);
 assert.equal(deveProcessarCotacoes(false,[b],new Set(),m,estado,101),false);
 assert.equal(deveProcessarCotacoes(true,[a],new Set(),m,estado,101),true);
});
test('fila inteira recebe cotacao em snapshot constante sem elevar o teto',()=>{
 const m=new MemoriaDeCotacoesNegativas();
 const estado=new Map([['0xab','1'],['0xcd','2']]);
 const cs=Array.from({length:37},(_,i)=>({...candidata('q'+i),
   pernas:[{pool:'0xab'},{pool:'0xcd'}]} as CandidataMista));
 const t=triagem();t.valem=cs;
 for(const c of cs)comSpread(t,c,110n);
 const pendentes=new Set(cs.map(c=>c.chave)),vistas=new Set<string>();
 for(let rodada=1;rodada<=10;rodada++){
   if(!deveProcessarCotacoes(false,cs,pendentes,m,estado,100+rodada))break;
   const elegiveis=cs.filter(c=>pendentes.has(c.chave)&&m.deveCotar(c,estado,100+rodada));
   const escolhidas=priorizarCotacoes(elegiveis,t,8,rodada,true).selecionadas;
   assert.ok(escolhidas.length<=8);
   for(const c of escolhidas){vistas.add(c.chave);pendentes.delete(c.chave);
     m.registrar(c,estado,-1n,true,100+rodada);}
 }
 assert.equal(vistas.size,37);assert.equal(pendentes.size,0);
 assert.equal(deveProcessarCotacoes(false,cs,pendentes,m,estado,111),false);
});
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

test('justica: rotas de spread positivo fora do top nao ficam eternamente adiadas',()=>{
    const t=triagem(),cs=Array.from({length:44},(_,i)=>candidata('a'+i));
    for(let i=0;i<cs.length;i++)comSpread(t,cs[i]!,BigInt(100+i));
    const historico=new Set<string>();
    for(let rodada=0;rodada<12;rodada++){
        const x=priorizarCotacoes(cs,t,12,rodada,true);
        assert.equal(x.selecionadas.length,12);
        for(const c of x.selecionadas)historico.add(c.chave);
        assert.equal(new Set(x.selecionadas.map(x=>x.chave)).size,12);
        assert.deepEqual(x.selecionadas.slice(0,6).map(x=>x.chave),
            ['a43','a42','a41','a40','a39','a38']);
    }
    assert.equal(historico.size,44);
});

test('mesmo estado negativo nao repete cotacao; TTL e mudanca do pool reabrem',()=>{
 const m=new MemoriaDeCotacoesNegativas(120_000);
 const rota={...candidata('x'),pernas:[{pool:'0xAB'},{pool:'0xCD'}]} as CandidataMista;
 const velho=new Map([['0xab','v3:123/L456'],['0xcd','ae:1/2']]);
 assert.equal(m.deveCotar(rota,velho,0),true);
 assert.equal(m.registrar(rota,velho,-1n,true,100),true);
 assert.equal(m.deveCotar(rota,velho,101),false);
 assert.equal(m.venceu(rota,velho,119_000),false);
 assert.equal(m.deveCotar(rota,velho,120_100),true);
 assert.equal(m.venceu(rota,velho,120_100),true);
 const novo=new Map([['0xab','v3:124/L456'],['0xcd','ae:1/2']]);
 assert.equal(m.deveCotar(rota,novo,102),true);
 assert.equal(m.venceu(rota,novo,102),false);
});
test('lucro positivo, dados ausentes ou inconsistencia nunca suprimem validacao',()=>{
 const m=new MemoriaDeCotacoesNegativas();
 const rota={...candidata('z'),pernas:[{pool:'0xAB'},{pool:'0xCD'}]} as CandidataMista;
 const ok=new Map([['0xab','v3:123/L456'],['0xcd','ae:1/2']]);
 const desconhecido=new Map([['0xab',null],['0xcd','ae:1/2']]);
 assert.equal(m.registrar(rota,ok,-7n,false,100),false);
 assert.equal(m.deveCotar(rota,ok,101),true);
 assert.equal(m.registrar(rota,desconhecido,-7n,true,100),false);
 assert.equal(m.registrar(rota,ok,10n,true,100),false);
 assert.equal(m.deveCotar(rota,ok,101),true);
 assert.equal(m.registrar(rota,ok,0n,true,100),true);
 assert.equal(m.deveCotar(rota,ok,101),false);
 assert.equal(m.registrar(rota,ok,null,true,102),false);
 assert.equal(m.deveCotar(rota,ok,103),true);
});

test('oldest pending quotes progress even when rankings change each cycle',()=>{
    const cs=Array.from({length:120},(_,i)=>candidata('pendente-'+i));
    const ultima=new Map<string,number>(),vistas=new Set<string>();
    for(let rodada=1;rodada<=12;rodada++){
        const t=triagem();
        // Different state/ranking every cycle, so negative snapshot cache cannot help.
        for(let i=0;i<cs.length;i++)comSpread(t,cs[i]!,BigInt(101+(i+rodada*7)%120));
        const x=priorizarCotacoes([...cs].reverse(),t,16,rodada,true,ultima);
        assert.equal(x.selecionadas.length,16);
        assert.equal(new Set(x.selecionadas.map(c=>c.chave)).size,16);
        for(const c of x.selecionadas){vistas.add(c.chave);ultima.set(c.chave,rodada);}
    }
    assert.equal(vistas.size,120,'fresh high-spread routes cannot indefinitely displace older pending routes');
});
