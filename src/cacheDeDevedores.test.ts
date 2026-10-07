// Arquivo: src/cacheDeDevedores.test.ts
//
// O que estes testes defendem: o cache é a única peça do bot cujo defeito é
// SILENCIOSO E PERMANENTE. Um buraco gravado no `ultimoBloco` não aparece em
// nenhum log — o próximo boot simplesmente começa depois dele, e ninguém volta
// nunca. Então as duas fronteiras (`ateOndeSemBuraco` e `deOndeSemBuraco`) são
// testadas contra falha na primeira faixa, no meio e no fim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NASCIMENTO_DO_POOL, VERSAO_DO_CACHE, CacheDeDevedores,
    cacheServe, pareceCache, ateOndeSemBuraco, deOndeSemBuraco,
    juntarDevedoresDoCache, esquecerQuemNaoDeveMais, deOndeComecar,
    comoEstaACobertura, lerCache, gravarCache, juntarVias, viasQueAindaImportam,
} from './cacheDeDevedores';

const POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

function cacheDeMentira(parcial: Partial<CacheDeDevedores> = {}): CacheDeDevedores {
    return {
        versao: VERSAO_DO_CACHE,
        rede: 'base',
        pool: POOL,
        blocoInicial: 1000,
        ultimoBloco: 2000,
        devedores: { '0xaaa': 1500 },
        ...parcial,
    };
}

test('o nascimento do Pool na Base é o bloco medido, não o bloco 0', () => {
    // Varrer do bloco 0 ao nascimento são 236 chamadas em blocos onde o
    // contrato não existia: custo com cara de rigor.
    assert.equal(NASCIMENTO_DO_POOL.base, 2_357_134);
});

test('ateOndeSemBuraco: tudo contíguo devolve a última ponta', () => {
    assert.equal(ateOndeSemBuraco(100, [[100, 199], [200, 299], [300, 399]]), 399);
});

test('ateOndeSemBuraco: faixas fora de ordem são ordenadas antes', () => {
    assert.equal(ateOndeSemBuraco(100, [[300, 399], [100, 199], [200, 299]]), 399);
});

test('ateOndeSemBuraco: buraco no meio para a fronteira ANTES do buraco', () => {
    // [200,299] falhou. Avançar para 399 gravaria o buraco para sempre.
    assert.equal(ateOndeSemBuraco(100, [[100, 199], [300, 399]]), 199);
});

test('ateOndeSemBuraco: a PRIMEIRA faixa falhando não avança nada', () => {
    assert.equal(ateOndeSemBuraco(100, [[200, 299], [300, 399]]), 99);
});

test('ateOndeSemBuraco: nenhuma faixa lida devolve inicio - 1', () => {
    assert.equal(ateOndeSemBuraco(100, []), 99);
});

test('deOndeSemBuraco: tudo contíguo desce até a ponta mais velha', () => {
    assert.equal(deOndeSemBuraco(399, [[100, 199], [200, 299], [300, 399]]), 100);
});

test('deOndeSemBuraco: buraco no meio para a descida DEPOIS do buraco', () => {
    // [200,299] falhou: desci de 399 até 300 e não posso dizer que cobri 100.
    assert.equal(deOndeSemBuraco(399, [[100, 199], [300, 399]]), 300);
});

test('deOndeSemBuraco: a faixa do topo falhando não desce nada', () => {
    assert.equal(deOndeSemBuraco(399, [[100, 199], [200, 299]]), 400);
});

test('deOndeSemBuraco: nenhuma faixa lida devolve fim + 1', () => {
    assert.equal(deOndeSemBuraco(399, []), 400);
});

test('as duas fronteiras concordam sobre a mesma cobertura contígua', () => {
    // A mesma lista lida nos dois sentidos tem de descrever o mesmo intervalo.
    const faixas: Array<[number, number]> = [[500, 599], [600, 699], [700, 799]];
    assert.equal(ateOndeSemBuraco(500, faixas), 799);
    assert.equal(deOndeSemBuraco(799, faixas), 500);
});

test('cacheServe: versão, rede e pool diferentes invalidam', () => {
    assert.equal(cacheServe(cacheDeMentira(), 'base', POOL), true);
    // Maiúsculas no endereço não mudam o endereço.
    assert.equal(cacheServe(cacheDeMentira(), 'base', POOL.toLowerCase()), true);
    assert.equal(cacheServe(cacheDeMentira(), 'arbitrum', POOL), false);
    assert.equal(cacheServe(cacheDeMentira({ versao: 99 }), 'base', POOL), false);
    assert.equal(
        cacheServe(cacheDeMentira({ pool: '0x0000000000000000000000000000000000000001' }), 'base', POOL),
        false,
    );
});

test('pareceCache rejeita o que JSON.parse aceita mas o bot não pode usar', () => {
    assert.equal(pareceCache(cacheDeMentira()), true);
    assert.equal(pareceCache(null), false);
    assert.equal(pareceCache('{}'), false);
    assert.equal(pareceCache({}), false);
    // Faltando campos: um arquivo cortado no meio da gravação.
    assert.equal(pareceCache({ versao: 1, rede: 'base', pool: POOL }), false);
    // `ultimoBloco` abaixo do `blocoInicial` é intervalo invertido.
    assert.equal(pareceCache(cacheDeMentira({ blocoInicial: 2000, ultimoBloco: 1000 })), false);
    // NaN passa por `typeof === 'number'` e envenenaria toda conta de bloco.
    assert.equal(pareceCache(cacheDeMentira({ ultimoBloco: Number.NaN })), false);
    assert.equal(pareceCache(cacheDeMentira({ devedores: null as never })), false);
});

test('juntarDevedoresDoCache guarda o bloco MAIS RECENTE de cada endereço', () => {
    const fora = juntarDevedoresDoCache({ '0xaaa': 100, '0xbbb': 900 }, ['0xAAA', '0xccc'], 500);
    assert.equal(fora['0xaaa'], 500, 'subiu de 100 para 500');
    assert.equal(fora['0xbbb'], 900, 'não desceu de 900 para 500');
    assert.equal(fora['0xccc'], 500, 'entrou agora');
    // Minúsculas sempre: o mesmo endereço em dois caixas seria duas leituras.
    assert.deepEqual(Object.keys(fora).sort(), ['0xaaa', '0xbbb', '0xccc']);
});

test('juntarDevedoresDoCache não altera o objeto que recebeu', () => {
    const antes = { '0xaaa': 100 };
    juntarDevedoresDoCache(antes, ['0xbbb'], 500);
    assert.deepEqual(antes, { '0xaaa': 100 });
});

test('esquecerQuemNaoDeveMais tira só quem está na lista, e conta quantos', () => {
    const r = esquecerQuemNaoDeveMais(
        { '0xaaa': 1, '0xbbb': 2, '0xccc': 3 },
        ['0xAAA', '0xccc', '0xnaoexiste'],
    );
    assert.deepEqual(Object.keys(r.devedores), ['0xbbb']);
    assert.equal(r.esquecidos, 2, 'o endereço que não estava lá não conta como esquecido');
});

test('deOndeComecar: sem cache começa no nascimento; com cache, no bloco seguinte', () => {
    const semCache = { usavel: false as const, cache: null, porque: 'não existe' };
    assert.equal(deOndeComecar(semCache, 2_357_134), 2_357_134);
    const comCache = { usavel: true as const, cache: cacheDeMentira(), porque: 'ok' };
    assert.equal(deOndeComecar(comCache, 1000), 2001);
    // Um cache que diga um bloco ABAIXO do nascimento não puxa a varredura para
    // antes de o contrato existir.
    const velho = { usavel: true as const, cache: cacheDeMentira({ blocoInicial: 1, ultimoBloco: 2 }), porque: 'ok' };
    assert.equal(deOndeComecar(velho, 5000), 5000);
});

test('comoEstaACobertura diz o que FALTA, não só o que tem', () => {
    const texto = comoEstaACobertura(
        cacheDeMentira({ blocoInicial: 3_000_000, ultimoBloco: 10_000_000 }),
        2_357_134, 12_000_000,
    );
    assert.match(texto, /para trás/, 'tem de nomear o que falta para trás');
    assert.match(texto, /na frente/, 'e o que falta na frente');
    assert.match(texto, /%/, 'e a fração da história');

    const completa = comoEstaACobertura(
        cacheDeMentira({ blocoInicial: 2_357_134, ultimoBloco: 12_000_000 }),
        2_357_134, 12_000_000,
    );
    assert.match(completa, /TOTAL para trás/);

    // Sem cache nenhum, o texto não pode parecer cobertura parcial.
    assert.match(comoEstaACobertura(null, 10, 20), /NADA ainda/);
});

test('lerCache distingue "não existe" de "corrompido" de "é de outra pool"', async () => {
    const naoExiste = await lerCache('/x/y.json', 'base', POOL, async () => {
        const e = new Error('ENOENT') as Error & { code: string };
        e.code = 'ENOENT';
        throw e;
    });
    assert.equal(naoExiste.usavel, false);
    assert.match(naoExiste.porque, /primeira varredura/);

    const semPermissao = await lerCache('/x/y.json', 'base', POOL, async () => {
        const e = new Error('EACCES: permission denied') as Error & { code: string };
        e.code = 'EACCES';
        throw e;
    });
    assert.equal(semPermissao.usavel, false);
    assert.match(semPermissao.porque, /não consegui ler/);

    const cortado = await lerCache('/x/y.json', 'base', POOL, async () => '{"versao":1,"dev');
    assert.equal(cortado.usavel, false);
    assert.match(cortado.porque, /não é JSON válido/);

    const forma = await lerCache('/x/y.json', 'base', POOL, async () => '{"versao":1}');
    assert.equal(forma.usavel, false);
    assert.match(forma.porque, /não tem a forma do cache/);

    const outraRede = await lerCache('/x/y.json', 'arbitrum', POOL,
        async () => JSON.stringify(cacheDeMentira()));
    assert.equal(outraRede.usavel, false);
    assert.match(outraRede.porque, /NÃO uso/);

    const bom = await lerCache('/x/y.json', 'base', POOL,
        async () => JSON.stringify(cacheDeMentira()));
    assert.equal(bom.usavel, true);
    assert.equal(bom.cache!.ultimoBloco, 2000);
});

test('gravarCache escreve no temporário e só depois renomeia', async () => {
    // Afirma a REGRA, não o nome: cria a pasta, escreve num temporário dentro
    // dela, e renomeia ESSE temporário para o destino. O nome exato mudou em
    // 2026-10-07 (passou a ser único por gravação) e a versão anterior deste
    // teste quebrou por ter o literal `.tmp` cravado — a armadilha que o
    // CLAUDE.md deste projeto já registra.
    const passos: string[] = [];
    const r = await gravarCache('/app/data/devedores.json', cacheDeMentira(), {
        mkdir: async (p) => { passos.push(`mkdir ${p}`); },
        escrever: async (p) => { passos.push(`escrever ${p}`); },
        renomear: async (a, b) => { passos.push(`renomear ${a} -> ${b}`); },
    });
    assert.equal(r.gravou, true);
    assert.equal(passos.length, 3);
    assert.equal(passos[0], 'mkdir /app/data');
    const escrito = passos[1]!.replace('escrever ', '');
    assert.ok(escrito.startsWith('/app/data/devedores.json.'), escrito);
    assert.ok(escrito.endsWith('.tmp'), escrito);
    // O renomeado tem de ser EXATAMENTE o que foi escrito: renomear outro
    // arquivo publicaria conteúdo que ninguém gravou.
    assert.equal(passos[2], `renomear ${escrito} -> /app/data/devedores.json`);
});

test('duas gravações NÃO disputam o mesmo temporário', async () => {
    // MEDIDO em produção, 2026-10-07 12:29. Com a gravação acontecendo a cada
    // tiro resolvido, dois tiros terminaram juntos e o log trouxe:
    //
    //   [CACHE] NÃO regravei. ENOENT: rename '/app/data/devedores.json.tmp' ->
    //
    // A segunda não achou o temporário porque a primeira já o renomeara. Perder
    // a gravação é o menor mal: duas escritas CONCORRENTES no mesmo arquivo
    // podem se intercalar e o `rename` publica um JSON cortado em cima de 3
    // anos de história.
    const escritos: string[] = [];
    const io = {
        mkdir: async () => {},
        escrever: async (p: string) => { escritos.push(p); },
        renomear: async () => {},
    };
    const [a, b] = await Promise.all([
        gravarCache('/app/data/devedores.json', cacheDeMentira(), io),
        gravarCache('/app/data/devedores.json', cacheDeMentira(), io),
    ]);
    assert.equal(a.gravou, true);
    assert.equal(b.gravou, true);
    assert.equal(escritos.length, 2);
    assert.notEqual(escritos[0], escritos[1], 'os dois temporários não podem ser o mesmo arquivo');
});

test('gravarCache NÃO lança quando o volume não está montado — e diz isso', async () => {
    const r = await gravarCache('/app/data/devedores.json', cacheDeMentira(), {
        mkdir: async () => { throw new Error('EROFS: read-only file system'); },
    });
    assert.equal(r.gravou, false);
    assert.match(r.porque, /volume está montado/);
    assert.match(r.porque, /varre a história inteira de novo/);
});

test('o cache é acelerador, não motor: uma falha de escrita não derruba a caça', async () => {
    // Se isto lançasse, o bot morreria no boot por causa de um volume faltando —
    // trocando "caça sem cache" por "não caça".
    await assert.doesNotReject(() => gravarCache('/nao/existe/x.json', cacheDeMentira(), {
        escrever: async () => { throw new Error('ENOENT'); },
    }));
});

test('JSON.parse de 50 mil devedores leva milissegundos, não segundos', () => {
    // A razão de ser JSON e não SQLite. Se isto custasse segundos, o boot
    // pagaria no silêncio o que o cache economizou em chamadas.
    const devedores: Record<string, number> = {};
    for (let i = 0; i < 50_000; i += 1) {
        devedores[`0x${i.toString(16).padStart(40, '0')}`] = 30_000_000 + i;
    }
    const texto = JSON.stringify(cacheDeMentira({ devedores }));
    const t0 = Date.now();
    const lido = JSON.parse(texto) as CacheDeDevedores;
    const ms = Date.now() - t0;
    assert.equal(Object.keys(lido.devedores).length, 50_000);
    // MEDIDO: 22ms e 2,70 MB. O teto de 1000ms é folga de máquina lenta, não a
    // medição — a medição está no comentário de cabeçalho do módulo.
    assert.ok(ms < 1000, `JSON.parse de 50 mil chaves levou ${ms}ms`);
    assert.ok(texto.length < 4_000_000, `o arquivo tem ${texto.length} bytes`);
});


// ---------------------------------------------------------------------------
// AS VIAS: o que o bot APRENDEU, e que morria a cada deploy.
//
// Medido em 2026-10-06, logo depois de um deploy: a bússola voltou com
// `57163 ainda não sei`, e dos 600 pares que o bot reresolveu, 589 eram IMUNES
// — 98%. Não é azar: ele resolve de cima para baixo da fila de fragilidade, e
// quem está no topo está lá PORQUE é imune (moeda única, o preço se cancela e a
// queda aparente some). Com o par desconhecido contando como sensível, eles
// ocupavam as 233 vagas da patrulha rápida.
// ---------------------------------------------------------------------------

test('juntarVias: o que foi lido AGORA manda sobre o que estava no disco', () => {
    // Uma posição troca de par quando o dono troca de garantia ou de dívida.
    // Nesse caso o disco está velho e a leitura de agora é a verdade.
    const fora = juntarVias({ '0xaaa': 'imune', '0xbbb': 'long' }, [['0xAAA', 'long']]);
    assert.equal(fora['0xaaa'], 'long');
    assert.equal(fora['0xbbb'], 'long');
});

test('juntarVias recusa via que o resto do código não sabe ler', () => {
    // Cache adulterado, ou gravado por uma versão futura. Um valor torto
    // viajaria pelas comparações sem ninguém notar; fora do mapa ele vira
    // "ainda não sei", que é o estado seguro.
    const fora = juntarVias({ '0xaaa': 'inventada', '0xbbb': 'imune' }, [['0xccc', '']]);
    assert.deepEqual(Object.keys(fora), ['0xbbb']);
});

test('juntarVias aceita os quatro valores conhecidos, e só eles', () => {
    const fora = juntarVias(undefined, [
        ['0x1', 'long'], ['0x2', 'short'], ['0x3', 'ambas'], ['0x4', 'imune'], ['0x5', 'IMUNE'],
    ]);
    assert.deepEqual(Object.keys(fora).sort(), ['0x1', '0x2', '0x3', '0x4']);
});

test('viasQueAindaImportam esquece quem saiu da lista de devedores', () => {
    // Sem esta poda o mapa cresceria para sempre, guardando o par de quem pagou
    // a dívida em 2024 — o mesmo vazamento que o esquecimento por estado
    // conserta do outro lado.
    const r = viasQueAindaImportam(
        { '0xaaa': 'long', '0xmorto': 'imune' },
        { '0xaaa': 100 },
    );
    assert.deepEqual(r, { '0xaaa': 'long' });
});

test('um cache SEM vias continua servindo — campo novo não invalida 3 anos', () => {
    const velho = cacheDeMentira();
    assert.equal(pareceCache(velho), true);
    assert.equal(velho.vias, undefined);
    // E juntar com `undefined` não estoura.
    assert.deepEqual(juntarVias(velho.vias, [['0xaaa', 'imune']]), { '0xaaa': 'imune' });
});

test('o ciclo inteiro: grava, lê e a bússola volta', async () => {
    // O teste que prova o conserto de ponta a ponta, e que teria pego o defeito
    // que eu cometi escrevendo-o: na primeira versão a gravação do boot
    // acontecia ANTES de `viasDoCache` existir, então o bot gravava um cache sem
    // as vias que tinha acabado de ler — apagando no disco o que recuperou.
    let noDisco = '';
    const comVias = cacheDeMentira({
        devedores: { '0xaaa': 1, '0xbbb': 2 },
        vias: { '0xaaa': 'imune', '0xbbb': 'long' },
    });
    const g = await gravarCache('/v/c.json', comVias, {
        mkdir: async () => {}, escrever: async (_p, c) => { noDisco = c; }, renomear: async () => {},
    });
    assert.equal(g.gravou, true);
    const lido = await lerCache('/v/c.json', 'base', POOL, async () => noDisco);
    assert.equal(lido.usavel, true);
    assert.deepEqual(lido.cache!.vias, { '0xaaa': 'imune', '0xbbb': 'long' });
});

test('a gravação do boot NÃO apaga as vias que o boot acabou de ler', async () => {
    // O caso exato do defeito: o bot lê 57 mil vias do disco, resolve 600 novas,
    // e grava. Se a gravação usar só as 600, as 57 mil somem — e o deploy
    // seguinte começa cego de novo, que é tudo o que isto existe para impedir.
    const doDisco = { '0xvelho1': 'imune', '0xvelho2': 'long' };
    const aprendidasAgora: Array<[string, string]> = [['0xnovo', 'short']];
    const devedores = { '0xvelho1': 1, '0xvelho2': 2, '0xnovo': 3 };
    const paraGravar = viasQueAindaImportam(juntarVias(doDisco, aprendidasAgora), devedores);
    assert.deepEqual(paraGravar, { '0xvelho1': 'imune', '0xvelho2': 'long', '0xnovo': 'short' });
    assert.equal(Object.keys(paraGravar).length, 3, 'as do disco não podem sumir');
});
