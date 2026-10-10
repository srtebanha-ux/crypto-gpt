import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ControleDeCapacidade, Inventario, sanitizar, oQuePausar, SECUNDARIAS,
    ENTRE_SONDAGENS_MS, SONDAGENS_POR_JANELA, JANELA_DE_SONDAGEM_MS, CU_ESTIMADO_POR_METODO,
    decidirSobreRecusa, OrcamentoDaTarefa, veredictoDaVarredura,
} from './capacidade';
import { classificarRecusa } from './cobertura';
import { EscadaDeRpc, ehFalhaDeTransporte } from './escadaDeRpc';
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

    // A PRIMEIRA também espera 30 min, contados do esgotamento. Esta asserção
    // mudou por instrução dela: antes a primeira passava na hora, e com o
    // castigo de 300s da escada a sondagem efetiva saía a 5 min, não a 30.
    assert.equal(k.podeSondar('alchemy'), false, 'no instante do esgotamento, não');
    r.andar(ENTRE_SONDAGENS_MS);
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
    r.andar(ENTRE_SONDAGENS_MS);
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

// ---------------------------------------------------------------------------
// O LOG DE 2026-10-10 20:02:15: a escada trocou de provedor imprimindo
// `Monthly capacity limit exceeded` e o ciclo seguinte continuou dizendo
// `capacidade: "nenhum provedor esgotado"`.
// ---------------------------------------------------------------------------

test('a mensagem de cota casa com `ehFalhaDeTransporte`, e era isso que a engolia', () => {
    const { ehFalhaDeTransporte } = require('./escadaDeRpc');
    const msg = 'Monthly capacity limit exceeded. Visit https://dashboard.alchemy.com/settings/'
        + 'billing to upgrade your scaling policy for';
    assert.equal(ehFalhaDeTransporte(msg), true,
        'ela casa com `capacity` E com `exceeded` — então `aEscadaAbsorve` dava `continue` e o '
        + 'ramo da cota, logo abaixo, era CÓDIGO MORTO para a única mensagem que ele trata');
    // E continua casando, de propósito: trocar de degrau ESTÁ certo. O que
    // estava errado era trocar e esquecer o motivo.
    assert.equal(classificarRecusa(msg).tipo, 'cota');
});

test('a classificação vem ANTES da escada, senão o ramo da cota é inalcançável', () => {
    // A regra, não o lugar: a decisão (que marca a capacidade) tem de acontecer
    // antes de `aEscadaAbsorve` poder dar `continue`. Ela mora em
    // `registrarRecusa`, e cada caminho a chama antes de absorver.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const nome of ['async function chamar<T>', 'async function chamarCruComPaciencia']) {
        const i = codigo.indexOf(nome);
        assert.ok(i > 0, nome);
        const corpo = codigo.slice(i, i + 3000);
        const posRegistra = corpo.indexOf('registrarRecusa(');
        const posEscada = corpo.indexOf('aEscadaAbsorve(msg)');
        assert.ok(posRegistra > 0, `${nome} tem de registrar a recusa`);
        assert.ok(posEscada > 0 && posRegistra < posEscada,
            `${nome}: absorver antes de registrar é não registrar`);
    }
    // E a marcação de capacidade existe no portão.
    const g = codigo.indexOf('function registrarRecusa');
    assert.ok(/CAPACIDADE\.esgotou\(/.test(codigo.slice(g, g + 1200)),
        'o portão é quem marca a capacidade');
});

test('DESCONHECIDO não é DISPONÍVEL: os três estados por provedor', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    const configurados = ['base-mainnet.g.alchemy.com', 'mainnet.base.org', 'terceiro.exemplo'];

    // Nada consultado ainda: TODOS desconhecidos. A frase antiga diria
    // "nenhum provedor esgotado", que lê como "está tudo bem".
    let linhas = k.porProvedorConfigurado(configurados);
    assert.deepEqual(linhas.map((l) => l.condicao), ['desconhecido', 'desconhecido', 'desconhecido']);
    assert.match(linhas[0]!.detalhe, /DESCONHECIDO, e desconhecido NÃO é disponível/);

    // O primário esgota, o secundário responde, o terceiro nunca foi chamado.
    k.esgotou('base-mainnet.g.alchemy.com', 'Monthly capacity limit exceeded');
    k.confirmou('mainnet.base.org');
    r.andar(90_000);
    linhas = k.porProvedorConfigurado(configurados);
    assert.deepEqual(linhas.map((l) => l.condicao), ['esgotado', 'disponivel', 'desconhecido']);
    assert.match(linhas[1]!.detalhe, /uma leitura passou há 1\.5 min: disponibilidade CONFIRMADA/);
    assert.match(linhas[2]!.detalhe, /DESCONHECIDO/);
    // E o provedor que nunca foi chamado NÃO desaparece da lista: faltar leria
    // como "está tudo bem com ele".
    assert.equal(linhas.length, 3);
});

test('confirmar disponibilidade NÃO devolve o provedor a desconhecido', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    k.esgotou('alchemy', 'Monthly capacity limit exceeded');
    assert.equal(k.confirmou('alchemy'), true, 'foi recuperação');
    assert.equal(k.condicao('alchemy'), 'disponivel',
        'apagar o estado diria "nunca perguntei", que é outra coisa');
    assert.equal(k.confirmou('alchemy'), false, 'a segunda leitura não é recuperação');
    assert.equal(k.condicao('alchemy'), 'disponivel');
});

// ---------------------------------------------------------------------------
// INTEGRACAO: primario devolve EXATAMENTE a recusa do log, secundario responde.
//
// Usa a ESCADA de verdade, o ControleDeCapacidade de verdade e a MESMA
// `decidirSobreRecusa` que `chamar` obedece. O unico fingimento e o transporte.
// ---------------------------------------------------------------------------

const RECUSA_REAL = 'Monthly capacity limit exceeded. Visit '
    + 'https://dashboard.alchemy.com/settings/billing to upgrade your scaling policy for';

/**
 * Um `chamar` reduzido ao que esta sob teste: a decisao, a escada e a
 * capacidade. A ordem das tres linhas e a MESMA de producao, e um teste de
 * codigo (abaixo) exige que continue sendo.
 */
function chamarComEscada(
    metodo: string,
    transporte: (url: string) => string,
    esc: InstanceType<typeof EscadaDeRpc>,
    cap: ControleDeCapacidade,
    hostDe: (u: string) => string,
    tentativas = 4,
): { resultado: string; provedorQueRespondeu: string; trocas: number } {
    let trocas = 0;
    for (let i = 0; ; i += 1) {
        const url = esc.url();
        try {
            const r = transporte(url);
            esc.deuCerto();
            cap.confirmou(hostDe(url));
            return { resultado: r, provedorQueRespondeu: hostDe(url), trocas };
        } catch (e) {
            const msg = (e as Error).message;
            if (i >= tentativas - 1) throw e;
            const d = decidirSobreRecusa({ mensagem: msg, ehTransporte: ehFalhaDeTransporte(msg) });
            if (d.marcarEsgotado) cap.esgotou(hostDe(url), msg);
            if (d.trocarDeProvedor) {
                const antes = esc.url();
                esc.falhou();
                if (esc.url() !== antes) trocas += 1;
                continue;
            }
            if (d.lancar || !d.esperarERepetir) throw e;
        }
    }
}

test('INTEGRAÇÃO: cota no primário, secundário responde, e as cinco provas', () => {
    const { EscadaDeRpc: E, ehFalhaDeTransporte: eft } = require('./escadaDeRpc');
    void eft;
    const r = relogio();
    const PRIM = 'https://base-mainnet.g.alchemy.com/v2/CHAVE';
    const SEC = 'https://mainnet.base.org';
    const host = (u: string) => new URL(u).host;
    const esc = new E([PRIM, SEC], { trocarApos: 1, castigoMs: 300_000, agora: r.agora });
    const cap = new ControleDeCapacidade(r.agora);
    let chamadasNoPrimario = 0;

    const transporte = (url: string) => {
        if (url === PRIM) { chamadasNoPrimario += 1; throw new Error(RECUSA_REAL); }
        return '0xdeadbeef';
    };

    // (1) A CHAMADA PROSSEGUE PELO SECUNDÁRIO.
    const saida = chamarComEscada('eth_call', transporte, esc, cap, host);
    assert.equal(saida.resultado, '0xdeadbeef');
    assert.equal(saida.provedorQueRespondeu, 'mainnet.base.org');
    assert.equal(saida.trocas, 1);

    // (2) O PRIMÁRIO PERMANECE MARCADO COMO ESGOTADO.
    assert.equal(cap.estaEsgotado('base-mainnet.g.alchemy.com'), true);
    assert.equal(cap.condicao('base-mainnet.g.alchemy.com'), 'esgotado');
    // E o sucesso no SECUNDÁRIO não limpa o primário — era este o risco de
    // chamar `confirmou` sem olhar de quem foi a leitura.
    assert.equal(cap.condicao('mainnet.base.org'), 'disponivel');

    // (3) O RELATÓRIO MOSTRA ESSA CONDIÇÃO, e por provedor.
    const linhas = cap.porProvedorConfigurado([host(PRIM), host(SEC)]);
    assert.deepEqual(linhas.map((l) => l.condicao), ['esgotado', 'disponivel']);
    assert.match(linhas[0]!.detalhe, /CAPACIDADE ESGOTADA/);
    assert.ok(!linhas[0]!.detalhe.includes('CHAVE'), 'sem credencial no relatório');

    // (4) O TRÁFEGO NÃO VOLTA PELO TEMPORIZADOR COMUM.
    r.andar(300_001);                       // o castigo de 300s venceu
    assert.equal(esc.deveVoltarAoPrimario(), true, 'a escada, por tempo, já liberaria');
    assert.equal(cap.estaEsgotado(host(PRIM)), true, 'mas a capacidade NÃO liberou');

    // (5) SÓ AS RECUPERAÇÕES PREVISTAS permitem nova tentativa.
    const antesDaSondagem = chamadasNoPrimario;
    assert.equal(cap.podeSondar(host(PRIM)), false,
        'aos 5 min do castigo da escada a sondagem AINDA não: ela conta 30 min do esgotamento');
    r.andar(25 * 60_000);
    assert.equal(cap.podeSondar(host(PRIM)), true, 'a sondagem espaçada é uma delas');
    cap.sondou(host(PRIM));
    assert.equal(cap.podeSondar(host(PRIM)), false, 'e só uma por 30 min');
    r.andar(29 * 60_000);
    assert.equal(cap.podeSondar(host(PRIM)), false, 'tempo menor que o intervalo não libera');
    assert.equal(chamadasNoPrimario, antesDaSondagem,
        'nenhuma chamada nova ao primário sem a sondagem autorizar');

    // Recuperação por CONFIRMAÇÃO: uma leitura que passa.
    cap.confirmou(host(PRIM));
    assert.equal(cap.condicao(host(PRIM)), 'disponivel');
});

test('a cota NÃO entra na espera progressiva: esperar não devolve cota', () => {
    const d = decidirSobreRecusa({ mensagem: RECUSA_REAL, ehTransporte: true });
    assert.equal(d.marcarEsgotado, true);
    assert.equal(d.trocarDeProvedor, true, 'trocar de degrau está certo');
    assert.equal(d.esperarERepetir, false, 'esperar e repetir gasta o que sobrou');
    assert.match(d.porque, /ESGOTAMENTO DE CAPACIDADE/);
});

test('limitação temporária espera; transporte troca; desconhecida lança', () => {
    const taxa = decidirSobreRecusa({ mensagem: 'request limit reached', ehTransporte: false });
    assert.deepEqual(
        [taxa.marcarEsgotado, taxa.esperarERepetir, taxa.trocarDeProvedor, taxa.lancar],
        [false, true, false, false],
    );
    const transp = decidirSobreRecusa({ mensagem: 'socket hang up', ehTransporte: true });
    assert.equal(transp.trocarDeProvedor, true);
    assert.equal(transp.marcarEsgotado, false);
    const ruim = decidirSobreRecusa({ mensagem: 'execution reverted', ehTransporte: false });
    assert.equal(ruim.lancar, true);
    assert.equal(ruim.marcarEsgotado, false);
});

test('produção OBEDECE `decidirSobreRecusa` em vez de decidir por conta', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const g = codigo.indexOf('function registrarRecusa');
    const portao = codigo.slice(g, g + 1200);
    assert.ok(/decidirSobreRecusa\(\{ mensagem: msg, ehTransporte: ehFalhaDeTransporte\(msg\) \}\)/.test(portao),
        'senão o teste de integração acima prova uma cópia');
    // A marcação vem ANTES da troca de degrau: trocar primeiro e marcar depois
    // perderia o nome do provedor que de fato recusou — `rpc` já seria o outro.
    assert.ok(portao.indexOf('CAPACIDADE.esgotou(') < portao.indexOf('return d;'),
        'o portão marca antes de devolver a decisão que autoriza a troca');
    assert.ok(!/aEscadaAbsorve/.test(portao), 'o portão não troca de degrau: quem chama troca');
});

test('TODO caminho que trata recusa passa pelo mesmo portão (REGRA 3)', () => {
    // O conserto de `chamar` deixou a gêmea solta: `chamarCruComPaciencia` —
    // a medição do tiro — chamava `aEscadaAbsorve` direto, sem classificar.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Toda chamada de `aEscadaAbsorve` tem de estar guardada por uma decisão.
    const linhas = codigo.split('\n').filter((l) => l.includes('aEscadaAbsorve(msg)'));
    assert.ok(linhas.length >= 2, 'há dois caminhos de recusa; se virar um, reveja este teste');
    for (const l of linhas) {
        assert.match(l, /(decisao|d)\.trocarDeProvedor && aEscadaAbsorve\(msg\)/,
            `absorver sem decidir é o defeito: ${l.trim()}`);
    }
    // E a marcação mora em UMA função, não copiada nos dois lugares.
    assert.equal((codigo.match(/CAPACIDADE\.esgotou\(/g) ?? []).length, 1,
        'duas cópias da marcação voltariam a divergir');
    // A definição mais os TRÊS caminhos de recusa: `chamar`, a medição do tiro
    // (`chamarCruComPaciencia`) e a sondagem do primário. Se aparecer um
    // caminho novo sem passar aqui, esta conta denuncia.
    assert.equal((codigo.match(/registrarRecusa\(/g) ?? []).length, 4,
        'a definição e os três caminhos que a chamam');
});

test('a PRIMEIRA sondagem também espera os 30 min: 5 não liberava', () => {
    // A contradição que ela mediu: o castigo da escada é 300s, e
    // `ultimaSondagemEm === null` deixava a primeira passar na hora — então a
    // sondagem efetiva acontecia a 5 MINUTOS, não aos 30 anunciados.
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', RECUSA_REAL);
    assert.equal(k.podeSondar('alchemy'), false, 'no instante do esgotamento, não');
    r.andar(5 * 60_000);
    assert.equal(k.podeSondar('alchemy'), false, '5 min: era aqui que ela passava');
    r.andar(24 * 60_000 + 59_999);
    assert.equal(k.podeSondar('alchemy'), false, '29min59,999s ainda não');
    r.andar(1);
    assert.equal(k.podeSondar('alchemy'), true, '30 min exatos: o que a frase anuncia');
});

test('uma sequência de sondagens malsucedidas NÃO libera nada nem se repete', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', RECUSA_REAL);
    const horarios: number[] = [];
    // Um dia inteiro, minuto a minuto, sondando sempre que for permitido.
    for (let min = 0; min <= 24 * 60; min += 1) {
        if (k.podeSondar('alchemy')) { horarios.push(min); k.sondou('alchemy'); }
        r.andar(60_000);
    }
    // Seis de 30 em 30 min; o teto da janela fecha o resto do dia; e em 1440
    // min a janela de 24h vira e a cota de sondagens volta — a cota MENSAL
    // pode ter virado, e meio dia cego seria pior que uma chamada.
    assert.deepEqual(horarios, [30, 60, 90, 120, 150, 180, 1440],
        'seis por janela, e a janela de 24h renova');
    assert.equal(k.estaEsgotado('alchemy'), true, 'nenhuma passou: continua esgotado');
    assert.equal(k.condicao('alchemy'), 'esgotado');
});

test('disponibilidade é POR MÉTODO: eth_getBalance não libera eth_getLogs', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.confirmou('mainnet.base.org', 'eth_getBalance');
    assert.equal(k.condicao('mainnet.base.org', 'eth_getBalance'), 'disponivel');
    assert.equal(k.condicao('mainnet.base.org', 'eth_getLogs'), 'desconhecido',
        'nunca foi perguntado por este método: desconhecido, não disponível');
    // E o provedor, no geral, respondeu algo — as duas respostas convivem.
    assert.equal(k.condicao('mainnet.base.org'), 'disponivel');
    k.confirmou('mainnet.base.org', 'eth_getLogs');
    assert.equal(k.condicao('mainnet.base.org', 'eth_getLogs'), 'disponivel');
    assert.deepEqual(
        k.metodosConfirmados('mainnet.base.org').map((m) => m.metodo).sort(),
        ['eth_getBalance', 'eth_getLogs'],
    );
});

test('provedor esgotado é esgotado para TODO método, inclusive o já confirmado', () => {
    const k = new ControleDeCapacidade(relogio().agora);
    k.confirmou('alchemy', 'eth_call');
    k.esgotou('alchemy', RECUSA_REAL);
    assert.equal(k.condicao('alchemy', 'eth_call'), 'esgotado',
        'a cota é da conta, não do método: uma confirmação antiga não a contradiz');
});

test('a tarefa viaja na REQUISIÇÃO, não num global restaurado em `finally`', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/let tarefaAtual/.test(codigo),
        'variável global não sobrevive a `await`: foi assim que um eth_getLogs do '
        + 'histórico saiu rotulado monitoramento');
    assert.ok(!/tarefaAtual\s*=/.test(codigo), 'nem atribuição a ela');
    // A tarefa é parâmetro de `chamar`, e o inventário conta por ele.
    assert.match(codigo, /tarefa: Tarefa = 'monitoramento'\): Promise<T>/);
    assert.match(codigo, /INVENTARIO\.contar\(tarefa, metodo\)/);
    // E a coleta de histórico a declara na própria chamada.
    assert.match(codigo, /\], 4, 'demorada', 'historico'\)/);
});

test('duas tarefas concorrentes não se sobrescrevem no inventário', async () => {
    // O defeito do global: a tarefa era lida DEPOIS de awaits. Com o valor
    // viajando na chamada, duas leituras intercaladas contam certo.
    const inv = new Inventario();
    const chamar = async (tarefa: 'historico' | 'monitoramento', metodo: string, atrasoMs: number) => {
        inv.contar(tarefa, metodo);
        await new Promise((r) => { setTimeout(r, atrasoMs); });
        return tarefa;
    };
    await Promise.all([
        chamar('historico', 'eth_getLogs', 20),
        chamar('monitoramento', 'eth_call', 1),
        chamar('historico', 'eth_getLogs', 5),
    ]);
    const linhas = inv.chamadasObservadas();
    assert.equal(linhas.find((l) => l.tarefa === 'historico')!.chamadas, 2);
    assert.equal(linhas.find((l) => l.tarefa === 'monitoramento')!.chamadas, 1);
});

test('sonda primeiro, promove depois: o tráfego não se move antes do sucesso', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const i = fonte.indexOf('async function talvezVoltarAoPrimario');
    const corpo = fonte.slice(i, fonte.indexOf('\nconst dormir', i))
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const posSonda = corpo.indexOf('await sondarProvedor(');
    const posPromove = corpo.indexOf('ESCADA.voltarAoPrimario()');
    assert.ok(posSonda > 0 && posPromove > 0);
    assert.ok(posSonda < posPromove, 'promover antes de sondar é descobrir depois de pagar');
    // E a sondagem é por FORA da escada, senão ela já teria promovido o tráfego.
    const sonda = fonte.slice(fonte.indexOf('async function sondarProvedor'),
        fonte.indexOf('async function talvezVoltarAoPrimario'));
    assert.ok(!/ESCADA\.|\brpc\b\s*=/.test(sonda.replace(/\/\*[\s\S]*?\*\//g, '')),
        'a sondagem não mexe na escada nem no rpc global');
    // Falha na sondagem -> nenhuma promoção naquele caminho.
    const ramoFalha = corpo.slice(corpo.indexOf('if (!r.ok)'), posPromove);
    assert.match(ramoFalha, /return;/, 'a falha volta sem promover');
});

test('o tamanho de eth_getLogs não medido é DESCONHECIDO, não o piso', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const i = codigo.indexOf('async function descobrirPedaco');
    const corpo = codigo.slice(i, codigo.indexOf('\nasync function juntarDevedores', i));
    assert.ok(!/pedacoMedido = PEDACO_MINIMO/.test(corpo),
        'gravar o piso como medido publicava "aceita 250 blocos" sem nenhuma sondagem aprovada');
    assert.match(corpo, /return \{ pedaco: null, tentativas \}/, 'desconhecido é `null`');
    // E a varredura NÃO começa com tamanho desconhecido.
    const v = codigo.indexOf('const medida = await descobrirPedaco(topo)');
    const depois = codigo.slice(v, v + 700);
    assert.match(depois, /if \(medida\.pedaco === null\)/);
    assert.ok(depois.indexOf('medida.pedaco === null') < depois.indexOf('faixasDeBlocos('),
        'o corte vem ANTES de montar as faixas, senão a varredura paralela já saiu');
});

test('nada lido e sem cache anterior: NÃO grava fronteira', () => {
    // Achado na verificação desta rodada: com a varredura adiada o cache saía
    // com `ultimoBloco: 51142298` e ZERO devedores — cobertura afirmada sobre
    // blocos que ninguém leu.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const i = codigo.indexOf('const gravacao = await gravarCache(CAMINHO_DO_CACHE');
    const antes = codigo.slice(Math.max(0, i - 700), i);
    assert.match(antes, /varrido\.faixasLidas\.length === 0 && !estadoDoCache\.usavel/,
        'o portão tem de estar ANTES da gravação');
    assert.match(antes, /return;/, 'e tem de sair sem gravar');
});

test('"um quarto falhou" era 40 de 40: a fração sai do TOTAL, não dos sucessos', () => {
    // O caso real de 21:14:45: janelasLidas 0, janelasQueFalharam 40. A conta
    // antiga era `falharam > lidas / 4` -> `40 > 0` -> verdadeiro, e a frase
    // dizia "um quarto das janelas falhou".
    const antiga = (lidas: number, falharam: number) => falharam > lidas / 4;
    assert.equal(antiga(0, 40), true, 'a condição antiga disparava a frase do "um quarto"');

    const v = veredictoDaVarredura({ lidas: 0, falharam: 40, achados: 0 });
    assert.equal(v.disponivel, false);
    assert.equal(v.fracaoQueFalhou, 1, '40 de 40 é 100%, não 25%');
    assert.match(v.frase, /HISTÓRICO INDISPONÍVEL: 40 de 40 janelas falharam \(100\.0%\)/);
    assert.match(v.frase, /não é\s+"nenhuma liquidação"/);
    assert.ok(!/um quarto/.test(v.frase));
});

test('zero janelas lidas nunca é "nenhuma liquidação"', () => {
    for (const falharam of [1, 7, 40]) {
        const v = veredictoDaVarredura({ lidas: 0, falharam, achados: 0 });
        assert.equal(v.disponivel, false, `${falharam} falhas`);
        assert.match(v.frase, /ausência de leitura/);
    }
    // Com pelo menos uma lida, o resultado existe — e diz que é PISO.
    const parcial = veredictoDaVarredura({ lidas: 3, falharam: 37, achados: 2 });
    assert.equal(parcial.disponivel, true);
    assert.match(parcial.frase, /INCOMPLETA: 3 janelas lidas e 37 falharam \(92\.5% das tentativas\)/);
    assert.match(parcial.frase, /é PISO, não total/);
    // Completa é completa.
    assert.match(veredictoDaVarredura({ lidas: 40, falharam: 0, achados: 5 }).frase, /COMPLETA/);
});

test('o orçamento cobre a tarefa INTEIRA: janelas e retentativas no mesmo bolso', () => {
    const r = relogio();
    const o = new OrcamentoDaTarefa('historico', 5, 60_000, r.agora);
    for (let i = 0; i < 5; i += 1) assert.equal(o.pedir(), true, `tentativa ${i + 1}`);
    assert.equal(o.pedir(), false, 'a sexta não sai');
    assert.equal(o.esgotado(), true);
    assert.match(o.porqueAcabou()!, /teto de 5 tentativas/);
    assert.match(o.comoLer(), /5 de 5 tentativas/);
});

test('o orçamento também acaba por TEMPO, não só por contagem', () => {
    const r = relogio();
    const o = new OrcamentoDaTarefa('historico', 100, 10_000, r.agora);
    assert.equal(o.pedir(), true);
    r.andar(10_000);
    assert.equal(o.pedir(), false);
    assert.match(o.porqueAcabou()!, /10s de parede/);
});

test('uma recusa de cota ENCERRA o orçamento: não insiste nas 39 restantes', () => {
    const o = new OrcamentoDaTarefa('historico', 50, 60_000, relogio().agora);
    assert.equal(o.pedir(), true);
    o.encerrar(`o provedor recusou por capacidade: ${RECUSA_REAL.slice(0, 30)}`);
    assert.equal(o.pedir(), false);
    assert.match(o.porqueAcabou()!, /capacidade/);
    assert.equal(o.gastas(), 1, 'uma tentativa gasta, não quarenta');
});

test('o censo passa `tentativas: 1` e consome o orçamento — não 4 por janela', () => {
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const i = fonte.indexOf('async function quandoFoiAUltimaLiquidacao');
    const corpo = fonte.slice(i, i + 5000).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.match(corpo, /new OrcamentoDaTarefa\('historico'/, 'a tarefa tem orçamento');
    assert.match(corpo, /if \(!orcamento\.pedir\(\)\) break;/, 'cada janela sai do orçamento');
    assert.match(corpo, /\}\], 1, 'demorada', 'historico'\)/,
        '`tentativas: 1`: as retentativas internas multiplicavam o orçamento por quatro');
    assert.match(corpo, /orcamento\.encerrar\(/, 'cota encerra a tarefa');
    assert.match(corpo, /veredictoDaVarredura\(/, 'e o resultado sai dos contadores');
    // A frase do "um quarto" não voltou.
    assert.ok(!/janelasLidas \/ 4/.test(corpo));
});

test('sondagem que FALHA não promove nem restaura disponibilidade', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.esgotou('alchemy', RECUSA_REAL);
    r.andar(ENTRE_SONDAGENS_MS);
    assert.equal(k.podeSondar('alchemy'), true);
    k.sondou('alchemy');
    // A sondagem falhou: ninguém chama `confirmou`. O estado NÃO muda.
    assert.equal(k.estaEsgotado('alchemy'), true);
    assert.equal(k.condicao('alchemy'), 'esgotado');
    assert.equal(k.condicao('alchemy', 'eth_blockNumber'), 'esgotado',
        'uma sondagem gasta não é uma sondagem bem-sucedida');
    assert.deepEqual(k.metodosConfirmados('alchemy'), [],
        'nenhum método foi confirmado por uma falha');
});

test('o relatório por método diz provedor, última verificação e resultado', () => {
    const r = relogio();
    const k = new ControleDeCapacidade(r.agora);
    k.confirmou('mainnet.base.org', 'eth_call');
    r.andar(90_000);
    const m = k.metodosConfirmados('mainnet.base.org');
    assert.deepEqual(m, [{ metodo: 'eth_call', haQuantoMs: 90_000 }]);
    const linha = k.porProvedorConfigurado(['mainnet.base.org'])[0]!;
    assert.equal(linha.provedor, 'mainnet.base.org');
    assert.equal(linha.condicao, 'disponivel');
    assert.match(linha.detalhe, /uma leitura passou há 1\.5 min/);
    // E eth_getLogs, que nunca passou, continua desconhecido.
    assert.equal(k.condicao('mainnet.base.org', 'eth_getLogs'), 'desconhecido');
});

test('TODO `eth_getLogs` declara a tarefa: nenhum cai no padrão `monitoramento`', () => {
    // Ela avisou: *"Não suponha que corrigir um chamador corrige os demais."*
    // E o log de 23:31 mostrou um `eth_getLogs` ainda rotulado `monitoramento`
    // com a correção no ar: era a sondagem de tamanho, outro chamador.
    const fonte = readFileSync(join(__dirname, 'cacarAoVivo.ts'), 'utf8');
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Cada `chamar<...>(` cuja lista de argumentos comeca com 'eth_getLogs'.
    const inicios: number[] = [];
    for (let i = codigo.indexOf('chamar<'); i >= 0; i = codigo.indexOf('chamar<', i + 1)) {
        const cabeca = codigo.slice(i, i + 200);
        const abre = cabeca.indexOf('(');
        if (abre > 0 && cabeca.slice(abre, abre + 30).includes("'eth_getLogs'")) inicios.push(i);
    }
    assert.ok(inicios.length >= 3, `achei ${inicios.length} chamadas de eth_getLogs`);
    for (const i of inicios) {
        // A tarefa e o ultimo argumento: ela aparece antes do `;` que fecha.
        const trecho = codigo.slice(i, i + 900);
        const fim = trecho.indexOf(');');
        assert.ok(fim > 0, 'chamada sem fim legível');
        assert.match(trecho.slice(0, fim + 2), /'historico'\)/,
            `esta chamada de eth_getLogs não declara a tarefa: ${trecho.slice(0, 70)}`);
    }
});
