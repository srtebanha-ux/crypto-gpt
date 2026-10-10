// O livro dos episodios: as REGRAS que ela nomeou, nao os valores.
//
// Cada caso aqui existe porque ela apontou um jeito de a medicao mentir:
// contar ciclos em vez de tempo, transformar tentativa em oportunidade,
// embutir o corte de 0,20% na coleta, e inventar desfecho.
import test from 'node:test';
import assert from 'node:assert';
import {
    LivroDeEpisodios, comoLerOsEpisodios, faixaDaDistancia,
    FAIXAS_DE_DISTANCIA, LACUNA_QUE_AINDA_CONTA_MS,
} from './episodios';

const ler = (l: LivroDeEpisodios, devedor: string, agoraMs: number, faltaPct: number | null,
    extra: Record<string, unknown> = {}) =>
    l.ver({ devedor, mercado: 'aave-v3/WETH-USDC', agoraMs, bloco: Math.floor(agoraMs / 2000), faltaPct, ...extra });

test('o tempo é EFETIVO: o ritmo do ciclo não muda a disponibilidade', () => {
    // A MESMA meia hora, lida a cada 200ms e a cada 8000ms. Contar ciclos daria
    // 40x de diferença; contar tempo dá o mesmo. Era isso que ela corrigiu.
    const medir = (passo: number) => {
        const l = new LivroDeEpisodios();
        for (let t = 0; t <= 600_000; t += passo) ler(l, '0xaa', t, 0.12);
        return l.resumo();
    };
    const rapido = medir(200);
    const lento = medir(8000);
    assert.equal(rapido.episodios, 1, 'a mesma posição é UM episódio, não 3.000');
    assert.equal(lento.episodios, 1);
    // Dentro de 1%: os dois observaram os mesmos 10 minutos.
    const razao = rapido.observadoMs / lento.observadoMs;
    assert.ok(razao > 0.99 && razao < 1.01, `ritmo mudou a medida: ${razao}`);
    assert.ok(rapido.porFaixa.find((f) => f.atePct === 0.15)!.fracaoDoObservado > 0.99,
        'com alvo presente todo o tempo, a fração do observado é ~100%');
});

test('uma LACUNA de coleta não é tempo observado, e é declarada', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1);
    ler(l, '0xaa', 1000, 0.1);
    // Um buraco de 15 minutos: o container reiniciou, o RPC caiu, qualquer coisa.
    ler(l, '0xaa', 1000 + 900_000, 0.1);
    const r = l.resumo();
    assert.equal(r.lacunas.quantas, 1);
    assert.ok(r.lacunas.msPerdidos >= 899_000);
    // O tempo observado NÃO inclui a lacuna — senão a disponibilidade sairia
    // inflada por um período em que ninguém olhou nada.
    assert.ok(r.observadoMs < LACUNA_QUE_AINDA_CONTA_MS * 2,
        `a lacuna entrou como observação: ${r.observadoMs}ms`);
    assert.ok(r.janelaDeParedeMs > 900_000, 'a parede inclui a lacuna, de propósito');
    assert.match(comoLerOsEpisodios(r), /lacuna\(s\) descartada\(s\)/);
});

test('TENTATIVA não é oportunidade: quatro tiros no mesmo alvo são UM episódio', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.08, { premioEstimadoUsd: 190 });
    for (let i = 0; i < 4; i++) l.tentou('0xAA', 'aave-v3/WETH-USDC');
    ler(l, '0xaa', 2000, 0.07, { premioEstimadoUsd: 190 });
    const r = l.resumo();
    assert.equal(r.episodios, 1, 'quatro tentativas não são quatro prêmios de US$ 190');
    assert.equal(l.todos()[0]!.tentativas, 4, 'mas as tentativas são contadas');
});

test('o corte de prêmio NÃO está embutido na coleta', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1, { premioEstimadoUsd: 12 });
    ler(l, '0xbb', 0, 0.1, { premioEstimadoUsd: 200 });
    // Sem corte: a coleta guarda os dois. Era isso que o "0,20% universal"
    // violava — um limiar de uma amostra decidindo o que nem é gravado.
    const semCorte = l.resumo();
    assert.equal(semCorte.porFaixa.find((f) => f.atePct === 0.10)!.comPremioAcimaDoCorte, 2);
    assert.equal(semCorte.cortePremioUsd, null);
    // Com corte, ele é DECLARADO ao lado do número.
    const com = l.resumo(38.13);
    assert.equal(com.porFaixa.find((f) => f.atePct === 0.10)!.comPremioAcimaDoCorte, 1);
    assert.equal(com.cortePremioUsd, 38.13);
    assert.match(comoLerOsEpisodios(com), /prêmio ≥ US\$ 38\.13/);
});

test('as faixas cobrem qualquer distância, e acima da última é null', () => {
    assert.equal(faixaDaDistancia(0.03), 0.05);
    assert.equal(faixaDaDistancia(0.1838), 0.20);
    assert.equal(faixaDaDistancia(1.1849), null, 'o maisPerto do log das 22:46 fica FORA');
    assert.equal(faixaDaDistancia(-1), null);
    assert.equal(faixaDaDistancia(NaN), null);
    // As faixas são crescentes: uma faixa fora de ordem faria o `for` devolver
    // a errada e ninguém notaria.
    for (let i = 1; i < FAIXAS_DE_DISTANCIA.length; i++) {
        assert.ok(FAIXAS_DE_DISTANCIA[i]! > FAIXAS_DE_DISTANCIA[i - 1]!);
    }
});

test('os QUATRO estados são contados separados, e um não implica o outro', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1, { estados: ['alvoProximo'] });
    ler(l, '0xbb', 0, 0, { estados: ['alvoProximo', 'posicaoLiquidavel'] });
    ler(l, '0xcc', 0, 0, { estados: ['alvoProximo', 'posicaoLiquidavel', 'simulacaoComSucesso'] });
    const r = l.resumo();
    assert.deepEqual(r.estados, {
        alvoProximo: 3, posicaoLiquidavel: 2, simulacaoComSucesso: 1, potencialmenteCapturavel: 0,
    });
    // NINGUÉM é potencialmente capturável aqui, e é o estado que decide dinheiro.
    assert.equal(r.estados.potencialmenteCapturavel, 0,
        'simulação com sucesso NÃO é oportunidade capturável');
});

test('um estado alcançado uma vez não é contado duas', () => {
    const l = new LivroDeEpisodios();
    for (let t = 0; t < 10_000; t += 1000) ler(l, '0xaa', t, 0, { estados: ['posicaoLiquidavel'] });
    assert.equal(l.resumo().estados.posicaoLiquidavel, 1,
        'dez leituras da mesma posição liquidável são UMA');
});

test('quem desaparece fecha como perdiDeVista, NÃO como recuperou', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1);
    ler(l, '0xbb', 0, 0.1);
    const fechados = l.fecharOsAusentes(['0xBB'], 5000);
    assert.equal(fechados, 1);
    const r = l.resumo();
    assert.equal(r.desfechos.perdiDeVista, 1);
    assert.equal(r.desfechos.recuperou, undefined,
        'não se sabe se recuperou, foi paga ou liquidada: inventar isso é o defeito que o projeto persegue');
    assert.equal(r.abertos, 1, '0xbb continua aberto');
    // E o desfecho DECLARADO sobrescreve, quando se sabe.
    l.fechar('0xbb', 'aave-v3/WETH-USDC', 'liquidadaPorTerceiro', 9000);
    assert.equal(l.resumo().desfechos.liquidadaPorTerceiro, 1);
});

test('a frase diz AUSÊNCIA MEDIDA, e não confunde com falta de medição', () => {
    const vazio = new LivroDeEpisodios().resumo();
    assert.match(comoLerOsEpisodios(vazio), /NADA observado ainda/);
    assert.match(comoLerOsEpisodios(vazio), /não é "não houve alvo"/);
    // Observou e não achou: isso SIM é resposta.
    const l = new LivroDeEpisodios();
    for (let t = 0; t <= 600_000; t += 5000) l.bateuPonto(t);
    const r = l.resumo();
    assert.ok(r.observadoMs > 590_000);
    assert.match(comoLerOsEpisodios(r), /ausência MEDIDA/);
});

test('a maior lacuna de um episódio viaja com ele — a duração fica conferível', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1);
    ler(l, '0xaa', 20_000, 0.1);
    const e = l.todos()[0]!;
    assert.equal(e.maiorLacunaMs, 20_000);
    assert.equal(e.observadoMs, 20_000, '20s está dentro do teto, então conta');
    assert.equal(e.leituras, 2);
});

test('COBERTURA: sair e voltar à lista não é oportunidade nova', () => {
    // Ela mandou: "Teste cruzamentos entre amostras, saída e retorno à lista e
    // reinício do processo, evitando contar o mesmo episódio como uma
    // oportunidade nova."
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1, { premioEstimadoUsd: 200 });
    l.fecharOsAusentes([], 5000);          // saiu da brasa
    ler(l, '0xaa', 60_000, 0.1, { premioEstimadoUsd: 200 });  // voltou
    l.fecharOsAusentes([], 65_000);
    ler(l, '0xaa', 120_000, 0.1, { premioEstimadoUsd: 200 }); // voltou de novo
    const r = l.resumo();
    assert.equal(r.episodios, 3, 'três episódios, porque a observação foi interrompida');
    assert.equal(r.alvosDistintos, 1, 'mas UM alvo — e um prêmio, não três');
    assert.equal(r.reaberturas, 2, 'as duas voltas são reaberturas');
    assert.match(comoLerOsEpisodios(r), /1 alvo\(s\) distinto\(s\)/);
    assert.match(comoLerOsEpisodios(r), /não é oportunidade nova/);
    // E o contador viaja no episódio, para a análise poder agrupar.
    assert.deepEqual(l.todos().map((e) => e.reaberturaDe), [0, 1, 2]);
});

test('COBERTURA: a mesma posição vista por duas amostras é UM episódio', () => {
    // Cruzamento entre amostras: a varredura completa e o ciclo da brasa veem
    // o mesmo devedor. Se cada um abrisse episódio, a contagem dobraria.
    const l = new LivroDeEpisodios();
    l.ver({ devedor: '0xAA', mercado: 'aave-v3/long', agoraMs: 0, bloco: 1, faltaPct: 0.2 });
    l.ver({ devedor: '0xaa', mercado: 'aave-v3/long', agoraMs: 1000, bloco: 2, faltaPct: 0.18 });
    assert.equal(l.resumo().episodios, 1, 'maiúscula/minúscula não cria episódio novo');
    // Mercado DIFERENTE é episódio diferente, de propósito: a via de quebra faz
    // parte da identidade do que está sendo medido.
    l.ver({ devedor: '0xaa', mercado: 'morpho/cbBTC-USDC', agoraMs: 2000, bloco: 3, faltaPct: 0.3 });
    const r = l.resumo();
    assert.equal(r.episodios, 2);
    assert.equal(r.alvosDistintos, 2, 'alvo+mercado é a identidade');
});

test('COBERTURA: reinício do processo zera o livro, e a janela diz isso', () => {
    const antes = new LivroDeEpisodios();
    for (let t = 0; t <= 300_000; t += 5000) ler(antes, '0xaa', t, 0.1);
    assert.ok(antes.resumo().msEntreLeituras > 290_000);
    // O deploy: livro novo. Nada atravessa — e a janela de parede começa agora.
    const depois = new LivroDeEpisodios();
    const r = depois.resumo();
    assert.equal(r.episodios, 0);
    assert.equal(r.msEntreLeituras, 0);
    assert.equal(r.janelaDeParedeMs, 0, 'a janela não herda nada do boot anterior');
    assert.match(comoLerOsEpisodios(r), /NADA observado ainda/);
});

test('COBERTURA: tempo ESTIMADO e tempo SEM DADOS são campos separados', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1);
    ler(l, '0xaa', 8000, 0.1);        // 8s: estimado, conta
    ler(l, '0xaa', 8000 + 600_000, 0.1); // 10 min: sem dados, descartado
    const r = l.resumo();
    assert.equal(r.msEntreLeituras, 8000, 'só o intervalo abaixo do teto é observação');
    assert.ok(r.msSemDados >= 599_000, 'e a lacuna aparece como SEM DADOS, não como zero');
    // Somar os dois é a parede; confundir um com o outro infla a disponibilidade.
    assert.ok(r.janelaDeParedeMs >= r.msEntreLeituras + r.msSemDados - 1);
});

test('COBERTURA: imune e poeira são MARCADOS, não excluídos da coleta', () => {
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.05, { imune: true });
    ler(l, '0xbb', 0, 0, { poeira: true });
    ler(l, '0xcc', 0, 0.05);
    const r = l.resumo();
    assert.equal(r.episodios, 3, 'os três entram: excluir seria a coleta escolhendo o resultado');
    assert.equal(r.imunes, 1);
    assert.equal(r.poeiras, 1);
});

test('a cobertura está DECLARADA no módulo, com os quatro pontos dela', () => {
    const { COBERTURA_DO_REGISTRO } = require('./episodios');
    assert.ok(COBERTURA_DO_REGISTRO.entram.includes('BRASA'));
    assert.ok(COBERTURA_DO_REGISTRO.ficamFora.length >= 3);
    assert.match(COBERTURA_DO_REGISTRO.mudancaDeLista, /perdiDeVista/);
    assert.match(COBERTURA_DO_REGISTRO.reinicioDoProcesso, /MEMORIA/);
    assert.match(COBERTURA_DO_REGISTRO.tempoEstimado, /msSemDados/);
});

test('PERSISTÊNCIA: a identidade atravessa o reinício, o TEMPO não', () => {
    const { pareceLivro, VERSAO_DO_LIVRO } = require('./episodios');
    const antes = new LivroDeEpisodios();
    ler(antes, '0xaa', 0, 0.1, { premioEstimadoUsd: 200 });
    ler(antes, '0xaa', 10_000, 0.09, { premioEstimadoUsd: 200 });
    const disco = antes.paraDisco(10_000);
    assert.ok(pareceLivro(disco));
    assert.equal(disco.versao, VERSAO_DO_LIVRO);
    assert.deepEqual(disco.abertosAoGravar, ['0xaa|aave-v3/WETH-USDC']);
    // O JSON tem de sobreviver ao round-trip: `Set` virou lista.
    const relido = JSON.parse(JSON.stringify(disco));
    const depois = new LivroDeEpisodios();
    depois.doDisco(relido, 10_000 + 600_000); // 10 minutos de processo morto
    const r = depois.resumo();
    assert.equal(r.episodios, 1, 'a identidade atravessou: é o MESMO episódio');
    assert.equal(r.alvosDistintos, 1, 'e NÃO virou oportunidade nova');
    assert.equal(r.reaberturas, 0, 'reinício não é reabertura: o episódio nem fechou');
    assert.equal(r.msEntreLeituras, 10_000, 'o tempo observado é o de antes, sem herdar nada');
    assert.ok(r.msOffline >= 600_000, 'e os 10 minutos mortos são OFFLINE');
    assert.equal(r.pendentesDeReconciliacao, 1);
    assert.deepEqual(depois.aReconciliar(), ['0xaa|aave-v3/WETH-USDC']);
    assert.match(comoLerOsEpisodios(r), /OFFLINE \(desconhecido/);
    assert.match(comoLerOsEpisodios(r), /a reconciliar do reinício/);
});

test('PERSISTÊNCIA: o offline NÃO vira observação na primeira leitura', () => {
    const antes = new LivroDeEpisodios();
    ler(antes, '0xaa', 0, 0.1);
    const depois = new LivroDeEpisodios();
    depois.doDisco(JSON.parse(JSON.stringify(antes.paraDisco(1000))), 1000 + 900_000);
    // A posição reaparece: o episódio CONTINUA, e o buraco não é observação.
    ler(depois, '0xaa', 1000 + 900_000 + 5, 0.1);
    const r = depois.resumo();
    assert.equal(r.episodios, 1);
    assert.ok(r.msEntreLeituras < 1000, `o offline entrou como observação: ${r.msEntreLeituras}ms`);
    assert.equal(r.pendentesDeReconciliacao, 0, 'reapareceu: reconciliado');
    assert.equal(depois.todos()[0]!.reconciliado, true);
});

test('PERSISTÊNCIA: quem não reaparece fecha como perdiDeVista, não recuperou', () => {
    const antes = new LivroDeEpisodios();
    ler(antes, '0xaa', 0, 0.1);
    ler(antes, '0xbb', 0, 0.1);
    const depois = new LivroDeEpisodios();
    depois.doDisco(JSON.parse(JSON.stringify(antes.paraDisco(1000))), 60_000);
    ler(depois, '0xaa', 61_000, 0.1);          // só 0xaa volta
    const desistidos = depois.desistirDosPendentes(62_000);
    assert.equal(desistidos, 1, '0xbb não voltou');
    const r = depois.resumo();
    assert.equal(r.desfechos.perdiDeVista, 1);
    assert.equal(r.desfechos.recuperou, undefined, 'não se inventa desfecho num reinício');
    assert.equal(depois.todos().find((e) => e.devedor === '0xbb')!.reconciliado, false);
});

test('PERSISTÊNCIA: arquivo de versão ou forma errada é RECUSADO', () => {
    const { pareceLivro } = require('./episodios');
    assert.equal(pareceLivro(null), false);
    assert.equal(pareceLivro({}), false);
    assert.equal(pareceLivro({ versao: 999, gravadoEm: 1, episodios: [], jaFechados: {}, abertosAoGravar: [] }), false,
        'versão diferente não é lida torta');
    assert.equal(pareceLivro({ versao: 1, gravadoEm: 1, episodios: [], jaFechados: {} }), false,
        'campo ausente recusa: ausência não vira lista vazia');
});

test('PERSISTÊNCIA: o contador de reaberturas atravessa o disco', () => {
    const antes = new LivroDeEpisodios();
    ler(antes, '0xaa', 0, 0.1);
    antes.fecharOsAusentes([], 1000);
    ler(antes, '0xaa', 2000, 0.1);
    const depois = new LivroDeEpisodios();
    depois.doDisco(JSON.parse(JSON.stringify(antes.paraDisco(2000))), 3000);
    antes.fecharOsAusentes([], 4000);
    ler(depois, '0xaa', 5000, 0.1);
    depois.fecharOsAusentes([], 6000);
    ler(depois, '0xaa', 7000, 0.1);
    // O terceiro episódio sabe que é o terceiro, mesmo com o reinício no meio.
    assert.equal(depois.todos().at(-1)!.reaberturaDe, 2);
    assert.equal(depois.resumo().alvosDistintos, 1, 'e continua UM alvo');
});

test('GRAVAÇÃO: temporário ÚNICO por gravação, e rename depois', async () => {
    const { gravarLivro, lerLivro } = require('./episodios');
    const l = new LivroDeEpisodios();
    ler(l, '0xaa', 0, 0.1);
    const escritos: string[] = []; const renomeados: [string, string][] = [];
    const io = {
        mkdir: async () => {},
        escrever: async (p: string) => { escritos.push(p); },
        renomear: async (a: string, b: string) => { renomeados.push([a, b]); },
    };
    const r1 = await gravarLivro('/app/data/episodios.json', l.paraDisco(1000), io);
    const r2 = await gravarLivro('/app/data/episodios.json', l.paraDisco(1001), io);
    assert.equal(r1.gravou, true);
    assert.equal(r2.gravou, true);
    assert.notEqual(escritos[0], escritos[1], 'duas gravações NÃO disputam o mesmo temporário');
    for (const [de, para] of renomeados) {
        assert.ok(de.endsWith('.tmp'), 'escreve no temporário');
        assert.equal(para, '/app/data/episodios.json', 'e renomeia ESSE temporário');
    }
    // Falha de escrita NÃO estoura: devolve gravou=false com o motivo.
    const ruim = await gravarLivro('/x/y.json', l.paraDisco(1), {
        mkdir: async () => {}, escrever: async () => { throw new Error('disco cheio'); },
    });
    assert.equal(ruim.gravou, false);
    assert.match(ruim.porque, /disco cheio/);
    // Arquivo torto devolve null, não livro vazio.
    assert.equal(await lerLivro('/nao/existe.json'), null);
    assert.equal(await lerLivro('x', { ler: async () => 'nada disso' }), null);
    assert.equal(await lerLivro('x', { ler: async () => '{"versao":99}' }), null);
});

/**
 * O 533 -> 0 EM 239ms, reproduzido.
 *
 * Do log de producao de 2026-10-10: a varredura completa abriu 533 episodios e
 * 239ms depois o ciclo da brasa — que consulta 233 posicoes — fechou TODOS,
 * inclusive os 300 que ele nao tinha consultado. A varredura seguinte reabriu, e
 * foram 2.702 reaberturas e milhares de episodios de duracao ZERO.
 *
 * Este teste FALHA sem o `universoConsultado`.
 */
test('o ciclo da brasa NÃO fecha o que ele não consultou', () => {
    const l = new LivroDeEpisodios();
    const completa: string[] = [];
    for (let i = 0; i < 533; i += 1) completa.push(`0x${i.toString(16).padStart(40, '0')}`);
    for (const d of completa) ler(l, d, 1000, 0.3);
    assert.equal(l.resumo().abertos, 533);

    // O ciclo da brasa, 239ms depois: ele le 233 e ve 230 na faixa.
    const brasa = completa.slice(0, 233);
    const vistos = brasa.slice(0, 230);
    for (const d of vistos) ler(l, d, 1239, 0.28);
    const fechados = l.fecharOsAusentes(vistos, 1239, 'perdiDeVista', brasa);

    assert.equal(fechados, 3, 'só os 3 que ESTAVAM nas 233 e não apareceram');
    assert.equal(l.resumo().abertos, 530, 'os 300 fora da brasa continuam abertos');

    // E a reabertura em cadeia nao acontece: a varredura seguinte reve os 533 e
    // nenhum episodio novo nasce para quem nunca foi fechado.
    for (const d of completa) ler(l, d, 16_000, 0.3);
    assert.equal(l.resumo().reaberturas, 3, 'só os 3 de verdade fechados reabrem');
});

test('sem o universo, o defeito antigo ainda é visível — e é o que ele era', () => {
    // Guarda a DIFERENCA entre as duas chamadas, para ninguem "simplificar" de
    // volta: sem universo, fechar os ausentes fecha 303 de uma vez.
    const l = new LivroDeEpisodios();
    const todos = ['0xa', '0xb', '0xc'];
    for (const d of todos) ler(l, d, 0, 0.3);
    assert.equal(l.fecharOsAusentes(['0xa'], 100), 2, 'sem universo: fecha quem não foi visto');
    const l2 = new LivroDeEpisodios();
    for (const d of todos) ler(l2, d, 0, 0.3);
    assert.equal(l2.fecharOsAusentes(['0xa'], 100, 'perdiDeVista', ['0xa', '0xb']), 1,
        'com universo: só 0xb, porque 0xc não foi consultado');
});

test('episódio de duração ZERO é contado e nomeado, não escondido', () => {
    // Milhares deles apareceram no log, e a causa era o fechamento indevido.
    // A duracao zero em si nao e defeito — pode ser uma posicao vista uma vez
    // so — mas ela tem de ser CONTAVEL para a proxima sessao poder perguntar.
    const l = new LivroDeEpisodios();
    ler(l, '0xa', 0, 0.3);
    l.fecharOsAusentes([], 0);
    const r = l.resumo();
    assert.equal(r.episodios, 1);
    const zerados = l.todos().filter((e) => e.fechouEm !== null && e.fechouEm === e.abriuEm);
    assert.equal(zerados.length, 1, 'o livro guarda o que precisa para contá-los');
});

test('período com cobertura incompleta é marcado impróprio para inferência econômica', () => {
    const l = new LivroDeEpisodios();
    l.bateuPonto(0, true);
    l.bateuPonto(1000, true);          // 1s com cobertura completa
    l.bateuPonto(3000, false);         // 2s com buraco de leitura
    const r = l.resumo();
    assert.equal(r.msEntreLeituras, 3000, 'o bot estava vivo e olhando os 3s');
    assert.equal(r.msComCoberturaIncompleta, 2000, 'mas 2s deles foram olhados com buraco');
    const frase = comoLerOsEpisodios(r);
    assert.match(frase, /IMPRÓPRIO para inferência econômica/);
});

test('cobertura completa não marca nada: o padrão não contamina a medição', () => {
    const l = new LivroDeEpisodios();
    l.bateuPonto(0); l.bateuPonto(5000);
    assert.equal(l.resumo().msComCoberturaIncompleta, 0);
    assert.ok(!/IMPRÓPRIO/.test(comoLerOsEpisodios(l.resumo())));
});
