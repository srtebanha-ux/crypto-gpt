/**
 * OS DEZ CENARIOS QUE ELA LISTOU, e o que cada um protege.
 *
 * O incidente de 2026-10-14 nao foi um valor errado: foi um portao olhando o
 * provedor errado. Entao os testes aqui afirmam as REGRAS, e varios leem o
 * CODIGO — porque um portao que consulta a fonte errada nao e pego por teste de
 * valor, e foi assim que isto passou por 1.714 testes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    DisponibilidadeReal, autorizarVarredura, PROVA_VENCE_EM_MS, BLOCOS_DE_UMA_SONDAGEM,
    RECUO_BASE_MS,
} from './disponibilidadeReal';
import { oQuePausar, Inventario, OrcamentoDaTarefa } from './capacidade';
import { disponibilidadeDoCanal } from './canais';

const ALCHEMY = 'base-mainnet.g.alchemy.com';
const PUBLICNODE = 'base-rpc.publicnode.com';

test('1. Alchemy esgotada e PublicNode respondendo: o censo NÃO pausa', () => {
    // O INCIDENTE, exatamente como o log de 2026-10-14 o mostra.
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.recusa(ALCHEMY, 'eth_getLogs', 'Monthly capacity limit exceeded', true);
    d.sucesso(PUBLICNODE, 'eth_getLogs', 10_000);

    // O provedor ATIVO é o PublicNode: ele pode varrer.
    const ativo = d.veredicto(PUBLICNODE, 'eth_getLogs');
    assert.equal(ativo.estado, 'disponivel');
    assert.equal(ativo.podeVarrer, true);
    assert.equal(ativo.limiteConhecido, 10_000);
    // E a Alchemy continua indisponível — sem contaminar o outro.
    assert.equal(d.veredicto(ALCHEMY, 'eth_getLogs').estado, 'indisponivel');

    // E a decisão de pausa segue QUEM ATENDE, não "algum esgotado".
    const pausa = oQuePausar({
        algumEsgotado: true, noFallback: false, oAtivoEstaEsgotado: false,
    });
    assert.deepEqual(pausa.pausar, [], 'o esgotamento da Alchemy pausou o que o PublicNode faz');
    assert.match(pausa.porque, /não atende não bloqueia/);
});

test('2. eth_call funcionando mas eth_getLogs recusado: não herda disponibilidade', () => {
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.sucesso(PUBLICNODE, 'eth_call');
    d.recusa(PUBLICNODE, 'eth_getLogs', 'eth_getLogs is not available on this tier', true);

    assert.equal(d.veredicto(PUBLICNODE, 'eth_call').estado, 'disponivel');
    assert.equal(d.veredicto(PUBLICNODE, 'eth_getLogs').estado, 'indisponivel');
    // Um método ausente do registro é DESCONHECIDO, nunca herdado do vizinho.
    assert.equal(d.veredicto(PUBLICNODE, 'eth_blockNumber').estado, 'desconhecido');
    // E DESCONHECIDO não varre: sonda.
    const v = d.veredicto(PUBLICNODE, 'eth_blockNumber');
    assert.equal(v.podeVarrer, false);
    assert.equal(v.podeSondar, true);
});

test('3. eth_getLogs voltando depois de indisponível: a volta vem de uma leitura', () => {
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.recusa(PUBLICNODE, 'eth_getLogs', 'Monthly capacity limit exceeded', true);
    assert.equal(d.veredicto(PUBLICNODE, 'eth_getLogs').estado, 'indisponivel');
    // Passar o tempo NÃO devolve disponibilidade: cota não volta com o relógio.
    t += 10 * PROVA_VENCE_EM_MS;
    assert.equal(d.veredicto(PUBLICNODE, 'eth_getLogs').estado, 'indisponivel');
    // Uma leitura que PASSA é a única forma de voltar.
    d.sucesso(PUBLICNODE, 'eth_getLogs', 500);
    const v = d.veredicto(PUBLICNODE, 'eth_getLogs');
    assert.equal(v.estado, 'disponivel');
    assert.equal(v.limiteConhecido, 500, 'o teto novo manda, não o antigo');
});

test('4. o RPC ativo recebendo 429: EM RECUO, e o recuo cresce', () => {
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.sucesso(PUBLICNODE, 'eth_getLogs', 10_000);
    d.recusa(PUBLICNODE, 'eth_getLogs', 'rate limited', false);

    const v = d.veredicto(PUBLICNODE, 'eth_getLogs');
    assert.equal(v.estado, 'emRecuo');
    assert.equal(v.podeVarrer, false);
    assert.equal(v.podeSondar, false, 'em recuo não se insiste nem sondando');

    // O recuo passa, e aí volta a DESCONHECIDO ou disponível — nunca direto a
    // "pode varrer" por decurso de prazo sem prova fresca.
    t += RECUO_BASE_MS + 1;
    assert.equal(d.veredicto(PUBLICNODE, 'eth_getLogs').estado, 'disponivel');

    // Recusas seguidas aumentam o recuo: 2ª espera mais que a 1ª.
    d.recusa(PUBLICNODE, 'eth_getLogs', 'rate limited', false);
    d.recusa(PUBLICNODE, 'eth_getLogs', 'rate limited', false);
    t += RECUO_BASE_MS + 1;
    assert.equal(
        d.veredicto(PUBLICNODE, 'eth_getLogs').estado, 'emRecuo',
        'o recuo não cresceu com as recusas seguidas',
    );
});

test('a prova VENCE: um eth_getLogs que passou não prova disponibilidade contínua', () => {
    // A terceira frase dela, e a regra que não existia em lugar nenhum deste
    // projeto: disponibilidade era um booleano sem data.
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.sucesso(PUBLICNODE, 'eth_getLogs', 10_000);
    assert.equal(d.veredicto(PUBLICNODE, 'eth_getLogs').podeVarrer, true);

    t += PROVA_VENCE_EM_MS;
    const v = d.veredicto(PUBLICNODE, 'eth_getLogs');
    assert.equal(v.estado, 'desconhecido', 'prova vencida continuou autorizando varredura');
    assert.equal(v.podeVarrer, false);
    assert.equal(v.podeSondar, true, 'prova vencida tem de autorizar SONDAGEM');
    assert.equal(v.tetoDeBlocos, BLOCOS_DE_UMA_SONDAGEM);
    assert.match(v.porque, /não prova disponibilidade contínua/);
    // E o TETO medido também vence: um teto velho produz janela que falha
    // inteira, e o resultado — lista vazia — leria como "não há devedores".
    assert.equal(v.limiteConhecido, null);
});

test('9. orçamento esgotado impede varredura pesada, mesmo com RPC disponível', () => {
    // A condição dela: disponibilidade NÃO devolve orçamento.
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.sucesso(PUBLICNODE, 'eth_getLogs', 10_000);
    const v = d.veredicto(PUBLICNODE, 'eth_getLogs');

    const semRequisicao = autorizarVarredura({
        veredicto: v, requisicoesRestantes: 0, msRestantes: 60_000, blocosDesejados: 10_000,
    });
    assert.equal(semRequisicao.pode, false);
    assert.match(semRequisicao.porque, /orçamento de requisições/);

    const semTempo = autorizarVarredura({
        veredicto: v, requisicoesRestantes: 50, msRestantes: 0, blocosDesejados: 10_000,
    });
    assert.equal(semTempo.pode, false);
    assert.match(semTempo.porque, /orçamento de tempo/);

    // Com orçamento, autoriza — e o teto sai do MEDIDO, não do desejado.
    const ok = autorizarVarredura({
        veredicto: v, requisicoesRestantes: 50, msRestantes: 60_000, blocosDesejados: 50_000,
    });
    assert.equal(ok.pode, true);
    assert.equal(ok.blocosPorChamada, 10_000, 'pediu 50.000 e o medido era 10.000');
});

test('teto NÃO medido não autoriza varredura: uma consulta não prova todas', () => {
    // *"Se o PublicNode aceitar 10.000 blocos, isso comprova aquela consulta,
    // não que todas as consultas de 10.000 blocos sejam viáveis."*
    let t = 1_000_000;
    const d = new DisponibilidadeReal(() => t);
    d.sucesso(PUBLICNODE, 'eth_getLogs'); // sucesso SEM teto medido
    const v = d.veredicto(PUBLICNODE, 'eth_getLogs');
    assert.equal(v.estado, 'disponivel');
    assert.equal(v.limiteConhecido, null);

    const a = autorizarVarredura({
        veredicto: v, requisicoesRestantes: 50, msRestantes: 60_000, blocosDesejados: 10_000,
    });
    assert.equal(a.pode, false, 'varreu sem teto medido');
    assert.equal(a.blocosPorChamada, BLOCOS_DE_UMA_SONDAGEM, 'devia cair para sondagem');
    assert.match(a.porque, /não prova que todas as desse tamanho passam/);
});

test('DESCONHECIDO autoriza sondagem pequena e NUNCA varredura sem limite', () => {
    const d = new DisponibilidadeReal(() => 1_000_000);
    const v = d.veredicto('provedor.novo', 'eth_getLogs');
    assert.equal(v.estado, 'desconhecido');
    assert.equal(v.tetoDeBlocos, BLOCOS_DE_UMA_SONDAGEM);
    const a = autorizarVarredura({
        veredicto: v, requisicoesRestantes: 999, msRestantes: 999_999, blocosDesejados: 100_000,
    });
    assert.equal(a.pode, false);
    assert.equal(a.blocosPorChamada, BLOCOS_DE_UMA_SONDAGEM);
    // Nenhum caminho devolve um teto maior que a sondagem num estado que não é
    // `disponivel`: é essa a condição que ela pôs.
    assert.ok((a.blocosPorChamada ?? 0) <= BLOCOS_DE_UMA_SONDAGEM);
});

test('10. o monitoramento NUNCA passa pelo portão das secundárias', () => {
    // Lê o CÓDIGO: a garantia é estrutural. `monitoramento` não está em
    // SECUNDARIAS, então nenhuma combinação de pausa pode conter ele.
    for (const algumEsgotado of [false, true]) {
        for (const noFallback of [false, true]) {
            for (const ativo of [undefined, false, true]) {
                const p = oQuePausar({ algumEsgotado, noFallback, oAtivoEstaEsgotado: ativo });
                assert.ok(
                    !p.pausar.includes('monitoramento'),
                    `o monitoramento foi pausado com ${JSON.stringify({ algumEsgotado, noFallback, ativo })}`,
                );
            }
        }
    }
    // E o canal dele nunca fecha.
    assert.equal(disponibilidadeDoCanal('monitoramento', {
        provedoresEsgotados: [ALCHEMY, PUBLICNODE], noFallback: true, eventosRecusados: true,
    }).pode, true);
});

test('o historico protege o provedor ativo e o censo dedicado respeita orçamento e checkpoint',()=>{
    // A varredura de DEVEDORES utiliza o RPC do monitoramento: seu veredicto
    // deve ser por metodo e pelo provedor ATIVO, nao por outro esgotado.
    const fonte=readFileSync(join(__dirname,'cacarAoVivo.ts'),'utf8');
    const i=fonte.indexOf('async function lerFaixaPartindoSePreciso');
    assert.ok(i>0);
    const corpo=fonte.slice(i,i+3200);
    assert.ok(!/if \(VAZAO\.estaEmRecuo\(\) \|\| CAPACIDADE\.esgotados\(\)\.length > 0\)/.test(corpo));
    assert.ok(corpo.includes("DISPONIBILIDADE.veredicto(aqui, 'eth_getLogs')"),
      'devedores usam veredicto do RPC ativo');
    // O CENSO de nove dias passou para outro RPC, de proposito.
    // Verificar antigo autorizarVarredura seria forçar esse trafego pesado
    // novamente no monitoramento do Caçador.
    const j=fonte.indexOf('async function quandoFoiAUltimaLiquidacao');
    assert.ok(j>i);
    const censo=fonte.slice(j,j+11500);
    assert.match(censo,/new OrcamentoDaTarefa\('historico'/);
    assert.match(censo,/while\s*\(proximoAte>=menorBloco[\s\S]*?orcamento\.pedir\(\)\)/);
    assert.match(censo,/logsComRpcHistorico<LogRPC>/);
    assert.match(censo,/urlSecundaria:process\.env\.CACA_HISTORICO_RPC_URL/);
    assert.match(censo,/if\(proximoAte>=menorBloco\)[\s\S]*?return;/,
      'censo incompleto nao declara ausencia de liquidacoes');
    assert.match(censo,/proximoAte=de-1/,'falhas nunca pulam blocos no cursor');
    assert.ok(!/ADIADAS\s*=\s*\{[^}]*morpho/.test(fonte));
});
test('o inventário separa HTTP de RPC e NÃO cobra CU de HTTP', () => {
    // *"Não contabilize chamadas HTTP como unidades de consumo RPC."*
    const inv = new Inventario();
    inv.contar('morpho', 'eth_call', 3);
    inv.contarHttp('morpho', 'api.morpho.org', 5);

    assert.equal(inv.totalObservado(), 3, 'HTTP entrou na contagem de RPC');
    assert.equal(inv.totalHttp(), 5);
    // O CU sai SÓ do RPC: 3 eth_call, e nada das 5 requisições HTTP.
    const cu = inv.cuEstimadoTotal();
    assert.equal(cu.cu, 26 * 3, 'o CU foi calculado sobre chamadas HTTP');
    // E o host aparece, para a origem do gasto ser legível.
    assert.deepEqual(inv.requisicoesHttp(), [
        { tarefa: 'morpho', host: 'api.morpho.org', requisicoes: 5 },
    ]);
    // Nenhuma linha de RPC menciona o host da API.
    for (const l of inv.chamadasObservadas()) {
        assert.ok(!l.metodo.includes('morpho.org'), 'host HTTP virou método de RPC');
    }
});

test('o orçamento diz o que RESTA, e zera quando encerra', () => {
    let t = 0;
    const o = new OrcamentoDaTarefa('historico', 3, 1000, () => t);
    assert.equal(o.restamTentativas(), 3);
    assert.equal(o.restamMs(), 1000);
    assert.equal(o.pedir(), true);
    assert.equal(o.restamTentativas(), 2);
    t = 400;
    assert.equal(o.restamMs(), 600);
    o.encerrar('recusa de cota');
    assert.equal(o.restamTentativas(), 0, 'orçamento encerrado tem de restar ZERO');
    assert.equal(o.restamMs(), 0);
});
