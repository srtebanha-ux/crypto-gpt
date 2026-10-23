/**
 * A MEMORIA DO UNIVERSO, e o que cada teste guarda.
 *
 * O defeito que ela conserta esta MEDIDO em 2026-10-16: os dois pools da
 * vencedora `0x6966a108…` nao emitiram `Swap` em 60 blocos anteriores
 * (cobertura 100% da varredura) e nasceram 14,5 milhoes de blocos antes. Sem
 * memoria, pool quieto desaparece do universo; com ela, continua conhecido.
 *
 * Os testes afirmam REGRAS, nao os numeros daquele dia — numero medido tem data
 * de validade, e este projeto ja quebrou cinco testes por cravar literal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    chaveDoPool, memoriaVazia, pareceMemoria, lerMemoria, gravarMemoria, juntar, paraRotas,
    deDescoberta, comoLerAMemoria, type PoolLembrado,
} from './memoriaDoUniverso';

const REDE = 8453;
const pasta = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'memuniv-'));
const pool = (over: Partial<PoolLembrado> = {}): PoolLembrado => ({
    endereco: '0x3e31de9d23a1c923e3b60b45c0a30d172f01b659',
    rede: REDE,
    protocolo: 'v3',
    token0: '0x4200000000000000000000000000000000000006',
    token1: '0xfb31f85a8367210b2e4ed2360d2da9dc2d2ccc95',
    taxa: 500,
    estavel: null,
    fabrica: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
    vistoNoBloco: 52632036,
    vezes: 1,
    ...over,
});

test('a memória atravessa a reinicialização do processo, com o metadado', async () => {
    const dir = pasta();
    const caminho = path.join(dir, 'universo.json');
    const { memoria } = juntar(memoriaVazia(REDE), [pool()]);
    await gravarMemoria(caminho, memoria);
    // RELEITURA, que é o que um processo novo faz: nada de estado em memória.
    const devolta = lerMemoria(caminho, REDE);
    assert.ok(devolta !== null, 'a memória gravada tem de voltar');
    assert.equal(devolta.pools.length, 1);
    const p = devolta.pools[0]!;
    assert.equal(p.endereco, pool().endereco);
    assert.equal(p.protocolo, 'v3');
    assert.equal(p.taxa, 500, 'a taxa é metadado verificado: tem de sobreviver');
    assert.equal(p.vistoNoBloco, 52632036);
    assert.equal(devolta.atualizadoNoBloco, 52632036);
});

test('memória AUSENTE ou TORTA devolve null — nunca uma memória vazia', () => {
    const dir = pasta();
    assert.equal(lerMemoria(path.join(dir, 'naoExiste.json'), REDE), null,
        'arquivo ausente é "não li", e null é o jeito de dizer isso');
    for (const lixo of [
        '{}', '[]', 'nao e json', '{"versao":2,"rede":8453,"pools":[]}',
        '{"versao":1,"rede":8453,"atualizadoNoBloco":1,"pools":[{"endereco":"0x12"}]}',
        '{"versao":1,"rede":8453,"atualizadoNoBloco":"x","pools":[]}',
    ]) {
        const c = path.join(dir, `lixo${Math.random()}.json`);
        fs.writeFileSync(c, lixo);
        assert.equal(lerMemoria(c, REDE), null, `${lixo.slice(0, 40)} passou pelo portão`);
    }
    // E o caso oposto: memória VÁLIDA e vazia é resposta, e não é null.
    const vazia = path.join(dir, 'vazia.json');
    fs.writeFileSync(vazia, JSON.stringify(memoriaVazia(REDE)));
    const lida = lerMemoria(vazia, REDE);
    assert.ok(lida !== null && lida.pools.length === 0,
        '"gravei e não conhecia nada" é diferente de "não li", e as duas têm de ser distinguíveis');
});

test('memória de OUTRA rede é ignorada: endereço de outra corrente não existe aqui', () => {
    const dir = pasta();
    const caminho = path.join(dir, 'outra.json');
    fs.writeFileSync(caminho, JSON.stringify({ ...memoriaVazia(1), pools: [pool({ rede: 1 })] }));
    assert.equal(lerMemoria(caminho, REDE), null);
    // E `juntar` recusa o pool de outra rede em vez de misturar.
    const j = juntar(memoriaVazia(REDE), [pool({ rede: 1 })]);
    assert.equal(j.memoria.pools.length, 0);
    assert.equal(j.recusadosPorRede, 1, 'recusa tem de ser CONTADA, não silenciosa');
});

test('a chave dedupe por rede, protocolo E endereço — e o maiúsculo não cria pool novo', () => {
    assert.equal(
        chaveDoPool({ rede: 8453, protocolo: 'v3', endereco: '0xABCdef0000000000000000000000000000000001' }),
        chaveDoPool({ rede: 8453, protocolo: 'v3', endereco: '0xabcdef0000000000000000000000000000000001' }),
    );
    assert.notEqual(
        chaveDoPool({ rede: 8453, protocolo: 'v3', endereco: '0xa'.padEnd(42, '1') }),
        chaveDoPool({ rede: 8453, protocolo: 'aerodrome', endereco: '0xa'.padEnd(42, '1') }),
        'o mesmo endereço com dois protocolos é leitura divergente: a conta de cada venue é outra',
    );
    assert.notEqual(
        chaveDoPool({ rede: 8453, protocolo: 'v3', endereco: '0xa'.padEnd(42, '1') }),
        chaveDoPool({ rede: 1, protocolo: 'v3', endereco: '0xa'.padEnd(42, '1') }),
    );
    // Duas descobertas do MESMO pool não viram dois pools.
    let m = memoriaVazia(REDE);
    const a = juntar(m, [pool()]);
    m = a.memoria;
    const b = juntar(m, [pool({ endereco: pool().endereco.toUpperCase(), vistoNoBloco: 52632100 })]);
    assert.equal(b.memoria.pools.length, 1, 'o mesmo pool entrou duas vezes');
    assert.equal(b.novas.length, 0, 'pool já conhecido não é novo');
    assert.equal(b.atualizadas, 1);
    assert.equal(b.memoria.pools[0]!.vistoNoBloco, 52632100, 'o visto mais RECENTE manda');
    assert.equal(b.memoria.pools[0]!.vezes, 2);
});

test('medição não é apagada por ausência: `null` que chega não sobrescreve `stable()` lido', () => {
    const { memoria } = juntar(memoriaVazia(REDE), [
        pool({ protocolo: 'aerodrome', taxa: null, estavel: false }),
    ]);
    const depois = juntar(memoria, [
        pool({ protocolo: 'aerodrome', taxa: null, estavel: null, vistoNoBloco: 52632100 }),
    ]);
    assert.equal(depois.memoria.pools[0]!.estavel, false,
        '`estavel: null` quer dizer "não li" — trocar a medição por ela é perder dado, e '
        + '`aeroEstavel !== false` muda a prova de monotonicidade');
});

test('o TETO corta o mais ANTIGO e diz quantos cortou', () => {
    const muitos: PoolLembrado[] = [];
    for (let i = 0; i < 10; i += 1) {
        muitos.push(pool({
            endereco: `0x${i.toString(16).padStart(40, '0')}`,
            vistoNoBloco: 52_632_000 + i,
        }));
    }
    const j = juntar(memoriaVazia(REDE), muitos, { teto: 4 });
    assert.equal(j.memoria.pools.length, 4);
    assert.equal(j.descartadosPorTeto, 6, 'memória cheia é causa de cobertura perdida: tem de '
        + 'aparecer, senão some sem ninguém notar');
    const blocos = j.memoria.pools.map((p) => p.vistoNoBloco);
    assert.deepEqual([...blocos].sort((a, b) => b - a), blocos, 'ficou o mais recente');
    assert.ok(Math.min(...blocos) > 52_632_000 + 5, 'cortou o mais antigo');
});

test('a memória NÃO guarda preço: nem reserva, nem sqrt, nem cotação', async () => {
    const dir = pasta();
    const caminho = path.join(dir, 'universo.json');
    const { memoria } = juntar(memoriaVazia(REDE), [pool()]);
    await gravarMemoria(caminho, memoria);
    const cru = fs.readFileSync(caminho, 'utf8');
    for (const proibido of [
        'sqrt', 'reserva', 'reserve', 'liquidez', 'liquidity', 'preco', 'sobra', 'cotacao',
        'lucro', 'slot0',
    ]) {
        assert.ok(!cru.toLowerCase().includes(proibido),
            `"${proibido}" apareceu no disco: decidir dinheiro com preço velho é o defeito que `
            + 'este projeto persegue — estado e cotação são lidos no bloco, sempre');
    }
    // E o CÓDIGO não pode passar a guardar: a interface é a fronteira.
    const fonte = fs.readFileSync(path.join(__dirname, 'memoriaDoUniverso.ts'), 'utf8');
    const corpo = fonte.slice(fonte.indexOf('export interface PoolLembrado'));
    const campos = corpo.slice(0, corpo.indexOf('}'));
    for (const proibido of ['sqrt', 'reserva', 'liquidez', 'preco']) {
        assert.ok(!campos.toLowerCase().includes(proibido),
            `o campo "${proibido}" entrou em PoolLembrado`);
    }
});

test('duas gravações concorrentes não disputam o mesmo temporário', async () => {
    const dir = pasta();
    const caminho = path.join(dir, 'universo.json');
    const a = juntar(memoriaVazia(REDE), [pool()]).memoria;
    const b = juntar(memoriaVazia(REDE), [pool({ endereco: `0x${'1'.repeat(40)}` })]).memoria;
    // Sem fila e sem nome único, o `rename` da segunda falha com ENOENT —
    // medido neste projeto em 2026-10-07, e custou uma gravação de cache.
    await Promise.all([gravarMemoria(caminho, a), gravarMemoria(caminho, b)]);
    const lida = lerMemoria(caminho, REDE);
    assert.ok(lida !== null, 'o arquivo publicado tem de ser JSON íntegro');
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0,
        'nenhum temporário ficou para trás');
});

test('`paraRotas` entrega o que `candidatasMistas` recebe, e só concentrado/Aerodrome', () => {
    const { memoria } = juntar(memoriaVazia(REDE), [
        pool(),
        pool({ endereco: `0x${'2'.repeat(40)}`, protocolo: 'aerodrome', taxa: null, estavel: true }),
        pool({ endereco: `0x${'3'.repeat(40)}`, protocolo: 'v2' }),
        pool({ endereco: `0x${'4'.repeat(40)}`, token1: '' }),
    ]);
    const rotas = paraRotas(memoria);
    assert.equal(rotas.length, 2, 'V2 não entra na rota mista, e pool sem os dois tokens miraria '
        + 'o par errado');
    const v3 = rotas.find((r) => r.venue === 'v3')!;
    assert.equal(v3.taxa, 500);
    assert.equal(rotas.find((r) => r.venue === 'aerodrome')!.estavel, true);
});

test('`deDescoberta` preserva o venue e marca o bloco em que viu', () => {
    const lembrados = deDescoberta([
        {
            endereco: '0xAAbb000000000000000000000000000000000001',
            token0: pool().token0,
            token1: pool().token1,
            venue: 'aerodrome',
            taxa: null,
            estavel: false,
            fabrica: '0x420dd381b31aef6683db6b902084cb0ffece40da',
        },
    ], REDE, 52_632_036);
    assert.equal(lembrados[0]!.protocolo, 'aerodrome');
    assert.equal(lembrados[0]!.estavel, false, '`false` é volatile COMPROVADO: não pode virar null');
    assert.equal(lembrados[0]!.vistoNoBloco, 52_632_036);
    assert.equal(lembrados[0]!.endereco, '0xaabb000000000000000000000000000000000001',
        'o endereço é guardado em minúsculo, senão a chave dedupe falha');
});

test('a frase da memória diz o que decide ação, e que não há preço nela', () => {
    const { memoria } = juntar(memoriaVazia(REDE), [pool()]);
    const f = comoLerAMemoria(memoria);
    assert.match(f, /1 pool\(s\) lembrado/);
    assert.match(f, /bloco 52632036/);
    assert.match(f, /preço nenhum/, 'quem lê o log tem de saber que estado é lido no bloco');
});

test('o caçador REDESCOBRE durante a execução e refaz as rotas — lido no código', () => {
    // Teste de CÓDIGO, e de propósito: o defeito era ESTRUTURAL — a descoberta
    // acontecia uma vez, no boot, e nenhum teste de valor pega isso. É a mesma
    // razão do teste que lê os gravadores do cache.
    const fonte = fs.readFileSync(path.join(__dirname, 'cacarArbitragem.ts'), 'utf8');
    const laco = fonte.slice(fonte.indexOf('    for (;;) {', fonte.indexOf('let ciclo = 0')));
    assert.match(laco, /universoPorAtividade\(/,
        'sem redescoberta DENTRO do laço, pool que começa a negociar depois do boot fica '
        + 'invisível até o próximo deploy');
    assert.match(laco, /MISTAS = candidatasMistas\(paraRotas\(memoria\)/,
        'pool novo sem rota refeita não produz oportunidade nenhuma');
    assert.match(laco, /gravarMemoria\(/,
        'aprender e não gravar perde tudo no próximo reinício — já aconteceu neste projeto');
    assert.match(laco, /metodoIndisponivel/,
        'nó sem `eth_getBlockReceipts` tem de DIZER, não publicar zero pool novo como medição');
    // E o estado NÃO pode vir da memória: a leitura é por ciclo.
    assert.match(laco, /lerEstadoMisto\(chamar, MISTAS/,
        'o estado de cada ciclo é lido no bloco, nunca reaproveitado da memória');
    assert.ok(!/paraRotas\(memoria\)[^]*?lerEstadoMisto\(memoria/.test(laco),
        'memória não pode servir de fonte de estado');
});
