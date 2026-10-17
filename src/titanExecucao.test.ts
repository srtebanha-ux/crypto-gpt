import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularPisoTitan, motivoDaRecusaTitan, avaliarEnsaioTitan, type PlanoTitan } from './titanExecucao';
import { avaliarLimitesDiariosTitan } from './titanAutorizacaoContinua';

const END_A = '0x0000000000000000000000000000000000000011';
const END_B = '0x0000000000000000000000000000000000000022';
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6EDb6E08f4c7C32D4f71b54bdA02913';

const plano = (): PlanoTitan => ({
    rota: [
        { pool: END_A, tokenEntra: WETH, tipo: 0, pagamento: 0n },
        { pool: END_B, tokenEntra: USDC, tipo: 1, pagamento: 0n },
    ],
    quantia: 1_000_000_000_000_000n,
    brutoEstimado: 30_000_000_000_000n,
    liquidoEstimado: 15_000_000_000_000n,
    bloco: 52000000,
    estadoConsistente: true,
});
const ambiente = (): NodeJS.ProcessEnv => ({
    TITAN_ENVIAR: '1', TITAN_CONFIRMAR: 'OPERAR_BASE_REAL',
    TITAN_NONCE_EXCLUSIVO: '1', TITAN_JANELAS_EXCLUSIVAS: '1',
    TITAN_CONTRATO: END_A, TITAN_CHAVE_PRIVADA: 'TEST_KEY_NAO_UTILIZADA_PELA_VALIDACAO',
    TITAN_COFRE: END_B, TITAN_MIN_LUCRO_WEI: '1000000000000',
    TITAN_ORCAMENTO_GAS_WEI: '100000000000000',
    TITAN_OPERAR_ATE_UTC: new Date(Date.now() + 60_000).toISOString(),
    TITAN_MARCADOR_ENVIO: '/app/data/titan-teste-puro-sem-envio.json',
});

test('envio e desligado por padrao', () => {
    assert.match(motivoDaRecusaTitan(plano(), {} )!, /desligado/);
});
test('cotacao inconsistente nunca executa', () => {
    assert.match(motivoDaRecusaTitan({ ...plano(), estadoConsistente: false }, ambiente())!, /estado/);
});
test('saldo negativo nunca executa', () => {
    assert.match(motivoDaRecusaTitan({ ...plano(), liquidoEstimado: -1n }, ambiente())!, /sem lucro/);
});
test('rota com 5 pernas nunca executa', () => {
    const p = plano(); p.rota = [...p.rota, ...p.rota, p.rota[0]!];
    assert.match(motivoDaRecusaTitan(p, ambiente())!, /2 a 4/);
});
test('nao aceita token ou pool com endereco corrompido', () => {
    const p = plano(); p.rota[0]!.pool = '0x123';
    assert.match(motivoDaRecusaTitan(p, ambiente())!, /invalido/);
});
test('sem exclusividade de nonce a carteira nao opera', () => {
    const e = ambiente(); delete e.TITAN_NONCE_EXCLUSIVO;
    assert.match(motivoDaRecusaTitan(plano(), e)!, /nonce exclusivo/);
});
test('sem teto de gas nao opera', () => {
    const e = ambiente(); delete e.TITAN_ORCAMENTO_GAS_WEI;
    assert.match(motivoDaRecusaTitan(plano(), e)!, /teto financeiro/);
});
test('sem contrato nem chave nem cofre nao opera', () => {
    const e = ambiente(); delete e.TITAN_CONTRATO;
    assert.match(motivoDaRecusaTitan(plano(), e)!, /contrato/);
});
test('plano corretamente habilitado passa prevalidacao pura', () => {
    assert.equal(motivoDaRecusaTitan(plano(), ambiente()), null);
});

test('autorizacao expirada nunca envia', () => {
    const e = ambiente(); e.TITAN_OPERAR_ATE_UTC = '2020-01-01T00:00:00.000Z';
    assert.match(motivoDaRecusaTitan(plano(), e)!, /expirada/);
});
test('sem trava persistente nao envia', () => {
    const e = ambiente(); delete e.TITAN_MARCADOR_ENVIO;
    assert.match(motivoDaRecusaTitan(plano(), e)!, /trava/);
});
test('janela acima de 24h nao aceita', () => {
    const e = ambiente(); e.TITAN_OPERAR_ATE_UTC = new Date(Date.now()+30*86400_000).toISOString();
    assert.match(motivoDaRecusaTitan(plano(), e)!, /expirada/);
});

test('500 bps exigem precisamente 5% liquido sobre o gas L1+L2', () => {
    const custo = 40_000_000_000_000n;
    const r = calcularPisoTitan(custo, { TITAN_LUCRO_GAS_BPS: '500' });
    assert.equal(r.margemBps, 500n);
    assert.equal(r.margemWei, 2_000_000_000_000n);
    assert.equal(r.lucroBrutoMinimoWei, 42_000_000_000_000n);
});
test('lucro de 5% substitui o piso fixo de 0.00002 WETH', () => {
    const r = calcularPisoTitan(40_000_000_000_000n, {
        TITAN_LUCRO_GAS_BPS: '500', TITAN_MIN_LUCRO_WEI: '20000000000000',
    });
    assert.equal(r.margemWei, 2_000_000_000_000n);
});
test('arredonda lucro percentual PARA CIMA e nunca o zera', () => {
    assert.equal(calcularPisoTitan(1n, { TITAN_LUCRO_GAS_BPS: '500' }).margemWei, 1n);
    assert.equal(calcularPisoTitan(101n, { TITAN_LUCRO_GAS_BPS: '500' }).margemWei, 6n);
});
test('percentagem 0, negativa, maior que 100% e malformada sao barradas', () => {
    for (const bps of ['0','-1','10001','abc','5.0','']) {
        assert.throws(() => calcularPisoTitan(100n, { TITAN_LUCRO_GAS_BPS: bps }));
    }
    const e = ambiente(); e.TITAN_LUCRO_GAS_BPS = '0';
    assert.match(motivoDaRecusaTitan(plano(), e)!, /politica de lucro invalida/);
});
test('gas nulo nunca permite piso dinamico', () => {
    assert.throws(() => calcularPisoTitan(0n, { TITAN_LUCRO_GAS_BPS: '500' }));
});
test('piso fixo historico continua para quem nao configurou percentual', () => {
    const r = calcularPisoTitan(40_000_000_000_000n, { TITAN_MIN_LUCRO_WEI: '20000000000000' });
    assert.equal(r.margemBps, null);
    assert.equal(r.lucroBrutoMinimoWei, 60_000_000_000_000n);
});

test('circuit breaker: qualquer reversao proibe novas tentativas inclusive outro dia', () => {
    const r = [{ estado:'revertido' as const, tetoGasWei:'100', diaUtc:'2026-10-15' }];
    assert.match(avaliarLimitesDiariosTitan(r,10n,10000n,10,new Date('2026-10-16T12:00:00Z'))!, /circuit breaker/);
});
test('circuit breaker: sem evento de lucro verificavel nao tenta novamente', () => {
    const r = [{ estado:'confirmado' as const, tetoGasWei:'100', diaUtc:'2026-10-16', gasRealL2Wei:'20' }];
    assert.match(avaliarLimitesDiariosTitan(r,10n,10000n,10)!, /lucro real nao comprovado/);
});
test('circuit breaker: sucesso que nao paga teto conservador proibe insistencia', () => {
    const r = [{ estado:'confirmado' as const, tetoGasWei:'100', diaUtc:'2026-10-16', gasRealL2Wei:'20', lucroRealizadoWei:'90' }];
    assert.match(avaliarLimitesDiariosTitan(r,10n,10000n,10)!, /lucro real nao comprovado/);
});
test('confirmacao comprovadamente lucrativa permite proxima avaliacao', () => {
    const r = [{ estado:'confirmado' as const, tetoGasWei:'100', diaUtc:'2026-10-16', gasRealL2Wei:'20', lucroRealizadoWei:'110' }];
    assert.equal(avaliarLimitesDiariosTitan(r,10n,10000n,10,new Date('2026-10-16T12:00:00Z')),null);
});

test('fonte Morpho nunca e habilitada sem contrato de arbitragem especifico', () => {
    const e=ambiente(); e.TITAN_FONTE_CREDITO='morpho';
    assert.match(motivoDaRecusaTitan(plano(),e)!, /contrato Morpho da arbitragem nao implantado/);
});
test('nao admite fonte de credito desconhecida', () => {
    const e=ambiente(); e.TITAN_FONTE_CREDITO='aave-gratuito-imaginario';
    assert.match(motivoDaRecusaTitan(plano(),e)!, /fonte de credito nao reconhecida/);
});
test('fonte Morpho so calcula gas em WETH e segue os mesmos portoes', () => {
    const e=ambiente(); e.TITAN_FONTE_CREDITO='morpho'; e.TITAN_CONTRATO_MORPHO=END_A;
    assert.equal(motivoDaRecusaTitan(plano(),e),null);
    const p=plano(); p.rota[0]!.tokenEntra=USDC;
    assert.match(motivoDaRecusaTitan(p,e)!, /base WETH/);
    e.TITAN_ENVIAR='0';
    assert.match(motivoDaRecusaTitan(plano(),e)!, /desligado/);
});

test('cotacao atomica de arbitragem considera gas L2, L1 em dobro e margem',()=>{
    const r=avaliarEnsaioTitan(1_000_000_000_000_000n,350_000n,
        30_000_000n,20_000_000n,100_000_000_000n,
        650_000n,1_000_000_000_000_000n,
        {TITAN_LUCRO_GAS_BPS:'500'});
    assert.equal(r.situacao,'executavel');
    assert.ok(BigInt(r.liquidoConservadorWei!)>0n);
    assert.equal(r.gasLimite,'420000');
});
test('gas, orcamento, retorno ou oracle L1 insuficientes nao autorizam envio',()=>{
    const env={TITAN_LUCRO_GAS_BPS:'500'};
    assert.equal(avaliarEnsaioTitan(1000n,350_000n,30_000_000n,
        20_000_000n,100_000_000_000n,650_000n,1_000_000n,env).situacao,'inviavel');
    assert.equal(avaliarEnsaioTitan(10_000_000_000_000n,600_000n,30_000_000n,
        20_000_000n,100_000_000_000n,650_000n,1_000_000_000_000_000n,env).situacao,'inviavel');
    assert.equal(avaliarEnsaioTitan(10_000_000_000_000n,350_000n,30_000_000n,
        20_000_000n,0n,650_000n,1_000_000_000_000_000n,env).situacao,'desconhecido');
});
