/**
 * A MEMORIA DA DESCOBERTA: os cenarios 6, 7 e 8 da lista dela.
 *
 * O que estes testes protegem e a resposta a pergunta que eu nao pude responder
 * em 2026-10-14: *"A Morpho executou? Quantos mercados encontrou? Quantos foram
 * validados? Os dados estão atualizados?"* — sobre um log que comecava 15,7 min
 * depois do boot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    lerMemoria, juntar, frescor, resumoCurto, memoriaVazia, nomeTemporario,
    VERSAO_DA_MEMORIA, RESULTADO_ENVELHECE_EM_MS, type RegistroDaDescoberta,
} from './memoriaDaDescoberta';

const AGORA = 1_700_000_000_000;

const bom = (em: number, extra: Partial<RegistroDaDescoberta> = {}): RegistroDaDescoberta => ({
    em, desfecho: 'A API enumerou e a CORRENTE confirmou', tentou: true, statusHttp: [200],
    mercadosRecebidos: 40, mercadosEnumerados: 40, mercadosQuePagam: 9, mercadosConfirmados: 7,
    devedoresEncontrados: 120, devedoresValidados: 15,
    blocoIndexado: 52_600_000, coberturaCompleta: true, falha: null,
    requisicoesHttp: 4, chamadasRpc: 20, veioDoCache: false, oQueBloqueia: null, ...extra,
});

const ruim = (em: number): RegistroDaDescoberta => ({
    em, desfecho: 'A API FALHOU', tentou: true, statusHttp: [429],
    mercadosRecebidos: 0, mercadosEnumerados: 0, mercadosQuePagam: 0, mercadosConfirmados: 0,
    devedoresEncontrados: 0, devedoresValidados: 0,
    blocoIndexado: null, coberturaCompleta: false, falha: 'HTTP 429 na página 0',
    requisicoesHttp: 1, chamadasRpc: 0, veioDoCache: false,
    oQueBloqueia: 'a API da Morpho: HTTP 429',
});

test('6/7. uma falha POSTERIOR não apaga o último resultado válido', () => {
    // A regra dura dela, e é ela que decide o desenho de dois registros.
    const comSucesso = juntar(null, bom(AGORA));
    assert.equal(comSucesso.ultimoSucesso?.mercadosConfirmados, 7);

    const depoisDaFalha = juntar(comSucesso, ruim(AGORA + 60_000));
    assert.equal(
        depoisDaFalha.ultimoSucesso?.em, AGORA,
        'a falha apagou o último sucesso — era exatamente o que não podia acontecer',
    );
    assert.equal(depoisDaFalha.ultimoSucesso?.mercadosConfirmados, 7);
    assert.equal(depoisDaFalha.ultimaTentativa?.falha, 'HTTP 429 na página 0');

    // E a frase DIZ as duas coisas: há resultado, e a tentativa de agora falhou.
    const f = resumoCurto(depoisDaFalha, AGORA + 61_000);
    assert.match(f, /7 CONFIRMADOS/);
    assert.match(f, /tentativa posterior FALHOU/);
});

test('7. a reinicialização preserva o resultado: round-trip pelo disco', () => {
    const antes = juntar(juntar(null, bom(AGORA)), ruim(AGORA + 1000));
    // Pelo JSON, como o disco faz.
    const depois = lerMemoria(JSON.parse(JSON.stringify(antes)));
    assert.deepEqual(depois.ultimoSucesso, antes.ultimoSucesso);
    assert.deepEqual(depois.ultimaTentativa, antes.ultimaTentativa);
    assert.equal(depois.versao, VERSAO_DA_MEMORIA);
    // E a frase sobrevive igual: é ela que a dona do bot lê.
    assert.equal(resumoCurto(depois, AGORA + 2000), resumoCurto(antes, AGORA + 2000));
});

test('8. memória corrompida NÃO lança e lê como NUNCA EXECUTADO', () => {
    // *"Cache corrompido sem derrubar o monitoramento."* E o estado que sai é
    // sobre o que EU SEI, não sobre o que aconteceu — a frase diz isso.
    for (const lixo of [null, undefined, 42, 'texto', [], { versao: 'x' },
        { ultimoSucesso: 'nada' }, { ultimoSucesso: { mercadosEnumerados: 9 } }]) {
        const m = lerMemoria(lixo);
        assert.equal(m.ultimoSucesso, null, `${JSON.stringify(lixo)} produziu sucesso falso`);
        assert.equal(frescor(m, AGORA).estado, 'nuncaExecutado');
        // Nunca lança: a chamada acima já prova, mas a frase também não pode.
        assert.ok(resumoCurto(m, AGORA).length > 0);
    }
    // REGISTRO SEM DATA NÃO É REGISTRO: ele não responde "está atualizado?".
    const semData = lerMemoria({ ultimoSucesso: { ...bom(AGORA), em: undefined } });
    assert.equal(semData.ultimoSucesso, null);
});

test('os TRÊS estados são distinguíveis, e nenhum deles é "não há mercados"', () => {
    const nunca = resumoCurto(null, AGORA);
    const atual = resumoCurto(juntar(null, bom(AGORA)), AGORA + 1000);
    const antigo = resumoCurto(juntar(null, bom(AGORA)), AGORA + RESULTADO_ENVELHECE_EM_MS + 1);

    assert.match(nunca, /NUNCA EXECUTADO/);
    assert.match(nunca, /não é "não há mercados"/);
    assert.match(atual, /morpho ATUAL/);
    assert.match(antigo, /morpho ANTIGO/);
    assert.equal(new Set([nunca, atual, antigo]).size, 3);

    // "tentou e nunca deu certo" é um QUARTO caso, e não se confunde com
    // "nunca tentou": eles pedem consertos opostos.
    const soFalha = resumoCurto(juntar(null, ruim(AGORA)), AGORA + 1000);
    assert.match(soFalha, /SEM SUCESSO ainda/);
    assert.match(soFalha, /HTTP 429/);
    assert.notEqual(soFalha, nunca);
});

test('a frase responde as CINCO perguntas dela, e cabe numa linha', () => {
    const f = resumoCurto(juntar(null, bom(AGORA, {
        coberturaCompleta: false,
        oQueBloqueia: 'nenhum devedor passou a validação por eth_call',
    })), AGORA + 120_000);
    // executou? / quantos achou? / quantos validados? / atualizado? / o que bloqueia?
    assert.match(f, /morpho ATUAL/);
    assert.match(f, /40 enumerados/);
    assert.match(f, /7 CONFIRMADOS/);
    assert.match(f, /15\/120 devedores validados/);
    assert.match(f, /há 2 min/);
    assert.match(f, /bloqueia: nenhum devedor passou/);
    assert.match(f, /cobertura PARCIAL/);
    // *"sem produzir relatórios gigantes a cada ciclo"*: uma linha.
    assert.ok(f.length < 400, `a linha tem ${f.length} caracteres`);
    assert.ok(!f.includes('\n'));
});

test('zero MEDIDO não se confunde com campo AUSENTE', () => {
    // A assinatura deste projeto: campo ausente virando zero e o zero publicado
    // como fato. `blocoIndexado` é o caso que decide se o dado está atualizado.
    const medido = lerMemoria({ ultimoSucesso: { ...bom(AGORA), blocoIndexado: 0 } });
    assert.equal(medido.ultimoSucesso?.blocoIndexado, null,
        'bloco 0 não é bloco indexado plausível: entra como desconhecido');
    const ausente = lerMemoria({ ultimoSucesso: { ...bom(AGORA), blocoIndexado: undefined } });
    assert.equal(ausente.ultimoSucesso?.blocoIndexado, null);
    // E `tentou` ausente NÃO vira verdadeiro: afirmaria requisição que não houve.
    const semTentou = lerMemoria({ ultimoSucesso: { ...bom(AGORA), tentou: undefined } });
    assert.equal(semTentou.ultimoSucesso?.tentou, false);
});

test('enumerar com o RPC mudo CONTA como sucesso a preservar', () => {
    // Enumerou 40 mercados e não confirmou nenhum porque o RPC caiu: é
    // resultado válido e tem de sobreviver a uma falha seguinte — só não
    // autoriza decisão. Confundir "não confirmei" com "não consegui nada" faria
    // um soluço de RPC apagar a enumeração.
    const m = juntar(null, bom(AGORA, {
        mercadosConfirmados: 0, devedoresEncontrados: 0, devedoresValidados: 0,
        desfecho: 'A API ENUMEROU e o RPC não pôde confirmar',
        oQueBloqueia: 'o RPC não respondeu ao eth_getCode',
    }));
    assert.notEqual(m.ultimoSucesso, null, 'enumeração sem confirmação foi descartada');
    const depois = juntar(m, ruim(AGORA + 1000));
    assert.equal(depois.ultimoSucesso?.mercadosEnumerados, 40);
    // Mas a frase não deixa confundir com mercado utilizável.
    assert.match(resumoCurto(depois, AGORA + 2000), /0 CONFIRMADOS/);
});

test('o temporário tem nome ÚNICO por gravação', () => {
    // O defeito está medido: em 07/10 duas gravações disputaram `${caminho}.tmp`
    // e a segunda falhou com ENOENT. Pior que perder uma gravação, duas escritas
    // podem se intercalar e o `rename` publica um JSON cortado.
    const a = nomeTemporario('/app/data/x.json');
    const b = nomeTemporario('/app/data/x.json');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('/app/data/x.json.'));
    assert.ok(a.endsWith('.tmp'));
});

test('memória vazia é um objeto válido, não um lançamento', () => {
    const v = memoriaVazia();
    assert.equal(v.ultimoSucesso, null);
    assert.equal(v.ultimaTentativa, null);
    assert.equal(frescor(v, AGORA).estado, 'nuncaExecutado');
    assert.equal(frescor(v, AGORA).idadeMs, null, 'idade de nada é null, não zero');
});

test('cache SERVINDO não é sucesso novo: a idade do resultado não se renova', () => {
    // ACHADO pelo cenário 6 dela, e era defeito de verdade. Com a API fora do
    // ar a descoberta cai no cache e a lista vem CHEIA — `juntar` lia isso como
    // sucesso e renovava `ultimoSucesso`. A idade se renovaria a cada volta com
    // a API morta, e "os dados estão atualizados?" passaria a ser respondido
    // com mentira: o campo que existe para medir frescor mediria a si mesmo.
    const real = juntar(null, bom(AGORA));
    const doCache = juntar(real, bom(AGORA + 3_600_000, {
        veioDoCache: true, falha: 'o transporte falhou na página 0: fetch failed',
    }));
    assert.equal(
        doCache.ultimoSucesso?.em, AGORA,
        'uma volta servida pelo cache renovou a idade do último sucesso',
    );
    assert.equal(doCache.ultimaTentativa?.veioDoCache, true);
    // E a frase diz QUAL foi o desfecho da tentativa posterior, porque "caiu no
    // cache" e "falhou" pedem leituras diferentes.
    const f = resumoCurto(doCache, AGORA + 3_600_001);
    assert.match(f, /caiu no CACHE/);
    assert.match(f, /morpho ANTIGO/, 'o resultado tem 1h: não pode ler como ATUAL');
});
