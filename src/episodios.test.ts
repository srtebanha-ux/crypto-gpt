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
