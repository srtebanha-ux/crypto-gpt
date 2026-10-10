import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ControleDeCapacidade, Inventario, sanitizar, oQuePausar, SECUNDARIAS,
    ENTRE_SONDAGENS_MS, SONDAGENS_POR_JANELA, JANELA_DE_SONDAGEM_MS, CU_ESTIMADO_POR_METODO,
} from './capacidade';
import { classificarRecusa } from './cobertura';
import { readFileSync } from 'fs';
import { join } from 'path';

const relogio = () => { let t = 0; return { agora: () => t, andar: (ms: number) => { t += ms; } }; };

test('`Monthly capacity limit exceeded` era tratado como LIMITE DE TAXA, e não é', () => {
    // A LISTA ANTIGA de `ehLimiteDoProvedor`, copiada: ela tinha 'capacity', e
    // 'Monthly capacity limit exceeded' CONTEM 'capacity'. Então o esgotamento
    // mensal era absorvido pela escada de espera como se fosse rajada: o bot
    // esperava 1s, 2s, 4s e repetia contra uma cota que não volta, queimando o
    // que sobrou dela para receber a mesma resposta.
    const antiga = (m: string) => ['rate limit', '429', 'too many requests', 'timeout', 'capacity']
        .some((p) => m.toLowerCase().includes(p));
    assert.equal(antiga('Monthly capacity limit exceeded'), true,
        'a lista antiga a absorvia esperando — era este o defeito');

    // A mensagem exata que o provedor devolveu.
    const c = classificarRecusa('Monthly capacity limit exceeded');
    assert.equal(c.tipo, 'cota');
    assert.equal(c.absorveEsperando, false,
        'esperar não resolve, e repetir gasta o que sobrou da cota');
    assert.match(c.oQueFazer, /NÃO resolve/);
    // E NAO e nenhuma das outras tres.
    for (const outra of ['taxa', 'tempo', 'outra']) assert.notEqual(c.tipo, outra);
});

test('o provedor esgotado NÃO volta por tempo — e a frase diz as três recuperações', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    assert.equal(k.estaEsgotado('alchemy'), true);
    // Uma hora depois, um dia depois: continua esgotado. Era isto que
    // `talvezVoltarAoPrimario` quebrava — ele devolve o tráfego por TEMPO.
    r.andar(60 * 60_000);
    assert.equal(k.estaEsgotado('alchemy'), true, 'uma hora não devolve cota');
    r.andar(23 * 60 * 60_000);
    assert.equal(k.estaEsgotado('alchemy'), true, 'um dia também não');
    const frase = k.comoLer('alchemy');
    assert.match(frase, /CAPACIDADE ESGOTADA/);
    assert.match(frase, /NÃO é falha transitória/);
    assert.match(frase, /sondagem que passe/);
    assert.match(frase, /troca de configuração/);
    assert.match(frase, /sondagem espaçada de 30 min/);
});

test('RECUPERAÇÃO 1: uma leitura que passa libera o provedor', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    assert.equal(k.confirmou('alchemy'), true);
    assert.equal(k.estaEsgotado('alchemy'), false);
    assert.equal(k.confirmou('alchemy'), false, 'confirmar quem não estava esgotado não é evento');
});

test('RECUPERAÇÃO 3: a sondagem é espaçada e tem TETO explícito', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');

    // Pode sondar logo (a primeira), depois espera 30 min entre sondagens.
    assert.equal(k.podeSondar('alchemy'), true);
    k.sondou('alchemy');
    assert.equal(k.podeSondar('alchemy'), false, 'não sonda duas vezes seguidas');
    r.andar(ENTRE_SONDAGENS_MS - 1);
    assert.equal(k.podeSondar('alchemy'), false);
    r.andar(1);
    assert.equal(k.podeSondar('alchemy'), true);

    // O TETO: gastar as seis da janela e parar.
    for (let i = 1; i < SONDAGENS_POR_JANELA; i += 1) {
        assert.equal(k.podeSondar('alchemy'), true, `sondagem ${i + 1} de ${SONDAGENS_POR_JANELA}`);
        k.sondou('alchemy');
        r.andar(ENTRE_SONDAGENS_MS);
    }
    assert.equal(k.podeSondar('alchemy'), false, 'teto da janela: sondar contra cota zerada é gastar o que não existe');
    assert.match(k.comoLer('alchemy'), /0 de 6 restam/);
});

test('a sondagem que FALHA também conta: senão o teto é letra morta', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    for (let i = 0; i < SONDAGENS_POR_JANELA; i += 1) {
        k.sondou('alchemy');       // falhou, e continua esgotado
        r.andar(ENTRE_SONDAGENS_MS);
    }
    assert.equal(k.podeSondar('alchemy'), false);
    assert.equal(k.estaEsgotado('alchemy'), true);
});

test('a janela de 24h vira e a cota de sondagens volta', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    for (let i = 0; i < SONDAGENS_POR_JANELA; i += 1) { k.sondou('alchemy'); r.andar(ENTRE_SONDAGENS_MS); }
    assert.equal(k.podeSondar('alchemy'), false);
    r.andar(JANELA_DE_SONDAGEM_MS);
    assert.equal(k.podeSondar('alchemy'), true, 'a cota mensal pode ter virado: meio dia descobre');
});

test('RECUPERAÇÃO 2: trocar a configuração esquece o que se sabia', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    k.esgotou('outro', 'Monthly capacity limit exceeded');
    assert.deepEqual(k.esgotados().sort(), ['alchemy', 'outro']);
    k.esquecer();
    assert.deepEqual(k.esgotados(), []);
});

test('esgotar duas vezes NÃO reinicia o relógio do esgotamento', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    r.andar(60 * 60_000);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    assert.match(k.comoLer('alchemy'), /há 60 min/, 'senão o log diria "há 0 min" para sempre');
});

test('nenhuma credencial entra na frase do log', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    k.esgotou('alchemy',
        'Monthly capacity limit exceeded at https://base-mainnet.g.alchemy.com/v2/abcdefGHIJ1234567890xyz');
    const f = k.comoLer('alchemy');
    assert.ok(!f.includes('abcdefGHIJ1234567890xyz'), 'a chave mora no caminho da URL');
    assert.match(f, /base-mainnet\.g\.alchemy\.com/, 'o host serve ao diagnóstico e não é segredo');
});

test('sanitizar tira URL completa e palavra longa aleatória', () => {
    assert.match(sanitizar('erro em https://x.com/v2/CHAVE_SECRETA_MUITO_LONGA_AQUI_123'), /x\.com\/…/);
    assert.ok(!sanitizar('key=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345').includes('ABCDEFGHIJKLMNOPQRST'));
    assert.equal(sanitizar('execution reverted'), 'execution reverted', 'o que não é segredo passa inteiro');
});

// --- LIMITAÇÃO TEMPORÁRIA é coisa diferente, e o teste separa as duas ---

test('limitação temporária NÃO marca esgotamento', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    const taxa = classificarRecusa('request limit reached');
    assert.equal(taxa.tipo, 'taxa');
    assert.equal(taxa.absorveEsperando, true, 'esta SIM passa esperando');
    // E quem decide marcar é o TIPO, não a existência de um erro. O TypeScript
    // já sabe que esta mensagem não é 'cota', então o portão é o tipo em si.
    const tipo: string = taxa.tipo;
    if (tipo === 'cota') k.esgotou('alchemy', 'request limit reached');
    assert.equal(k.estaEsgotado('alchemy'), false,
        'tratar limitação temporária como esgotamento cegaria o bot por 30 min a cada rajada');
});

// --- INVENTÁRIO: observado contra estimado ---

test('o inventário conta chamadas OBSERVADAS por tarefa e método', () => {
    const i = new Inventario();
    i.contar('monitoramento', 'eth_call', 240);
    i.contar('varreduraCompleta', 'eth_call', 248);
    i.contar('historico', 'eth_getLogs', 205);
    i.contar('reconexao', 'net_version', 8);
    assert.equal(i.totalObservado(), 701);
    const linhas = i.chamadasObservadas();
    assert.equal(linhas[0]!.chamadas, 248, 'ordenado pela maior');
    assert.deepEqual(
        linhas.find((l) => l.tarefa === 'historico'),
        { tarefa: 'historico', metodo: 'eth_getLogs', chamadas: 205 },
    );
});

test('CU é ESTIMADO e cada linha diz isso; método sem peso é `null`, não zero', () => {
    const i = new Inventario();
    i.contar('monitoramento', 'eth_call', 100);
    i.contar('morpho', 'metodo_que_nao_existe', 5);
    const inv = i.inventarioComCU();
    const call = inv.find((l) => l.metodo === 'eth_call')!;
    assert.equal(call.chamadasObservadas, 100);
    assert.equal(call.cuEstimado, 100 * CU_ESTIMADO_POR_METODO.eth_call!);
    assert.match(call.origemDoCU, /ESTIMADO/);
    const desconhecido = inv.find((l) => l.metodo === 'metodo_que_nao_existe')!;
    assert.equal(desconhecido.cuEstimado, null, 'zero diria "não custa nada"');
    assert.match(desconhecido.origemDoCU, /NÃO SEI o peso/);
    assert.equal(i.cuEstimadoTotal().chamadasSemPeso, 5, 'e as sem peso são contadas à parte');
});

test('a projeção diária recusa janela curta — é a REGRA 4 do projeto', () => {
    const i = new Inventario();
    i.contar('monitoramento', 'eth_call', 100);
    assert.equal(i.porDia(60_000), null, 'um minuto não projeta um dia');
    assert.equal(i.porDia(9 * 60_000), null);
    const d = i.porDia(60 * 60_000)!;
    assert.equal(d.chamadas, 2400, '100/h = 2.400/dia');
    assert.equal(d.cuEstimado, 2400 * CU_ESTIMADO_POR_METODO.eth_call!);
});

// --- PAUSAR SECUNDÁRIAS antes de sobrecarregar o fallback ---

test('capacidade esgotada pausa TODAS as secundárias, e não o monitoramento', () => {
    const r = oQuePausar({ algumEsgotado: true, noFallback: true });
    assert.deepEqual(r.pausar.sort(), [...SECUNDARIAS].sort());
    assert.ok(!r.pausar.includes('monitoramento'),
        'o monitoramento é o único que precisa estar vivo no instante do alvo');
    assert.match(r.porque, /capacidade esgotada/);
});

test('no fallback sem esgotamento, só histórico e Morpho pausam', () => {
    const r = oQuePausar({ algumEsgotado: false, noFallback: true });
    assert.deepEqual(r.pausar.sort(), ['historico', 'morpho']);
    assert.ok(!r.pausar.includes('varreduraCompleta'), 'é ela que povoa a brasa');
});

test('no primário e sem esgotamento, nada pausa', () => {
    const r = oQuePausar({ algumEsgotado: false, noFallback: false });
    assert.deepEqual(r.pausar, []);
    assert.match(r.porque, /nada a pausar/);
});


test('o retorno ao primário NÃO pode depender só de tempo de castigo', () => {
    // O defeito estrutural: `talvezVoltarAoPrimario` decidia por
    // `deveVoltarAoPrimario()`, que mede TEMPO. Cota não volta com tempo.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const fn = fonte.slice(fonte.indexOf('function talvezVoltarAoPrimario'));
    const corpo = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(/CAPACIDADE\.estaEsgotado/.test(corpo),
        'o portão da capacidade tem de estar NESTA função, antes da troca de url');
    assert.ok(/CAPACIDADE\.podeSondar/.test(corpo),
        'e a única porta que abre é a sondagem espaçada com teto');
    // E a ordem importa: o portão vem ANTES de `voltarAoPrimario()`.
    assert.ok(corpo.indexOf('estaEsgotado') < corpo.indexOf('voltarAoPrimario'),
        'conferir depois de trocar a url seria conferir tarde');
});

test('a causa da falha do WebSocket é LIDA do evento, não descartada', () => {
    // `cair()` recebia o evento e não olhava nada dele: a frase era literal.
    const fonte = readFileSync(join(__dirname, 'gatilhoDeBloco.ts'), 'utf8');
    assert.ok(/const cair = \(ev\?: unknown\) =>/.test(fonte), 'o evento tem de entrar');
    assert.ok(/lerFalhaDeWs\(ev,/.test(fonte), 'e tem de ser LIDO');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/aoAviso\?\.\('conexão de blocos caiu/.test(codigo),
        'a frase literal sem código nem razão não voltou');
});

test('a cobertura NÃO mora numa variável de módulo que chamada auxiliar sobrescreve', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/export let ultimaCobertura/.test(codigo),
        'era isto: `resolverPares` e os símbolos das moedas sobrescreviam o contador do ciclo');
    assert.ok(/Promise<\{ dados: Array<string \| null>; cobertura: Cobertura \}>/.test(codigo),
        '`lerEmLote` devolve a cobertura junto com os dados, sem estado compartilhado');
});
