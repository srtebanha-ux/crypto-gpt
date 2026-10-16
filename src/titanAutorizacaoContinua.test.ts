import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parametrosTitanContinuo, avaliarLimitesDiariosTitan,
} from './titanAutorizacaoContinua';
import { motivoDaRecusaTitan, type PlanoTitan } from './titanExecucao';

const DIA = new Date('2026-10-16T10:00:00Z');
const registro = (estado: 'pendente'|'confirmado'|'revertido', wei: string,
    diaUtc='2026-10-16') => ({
        estado, tetoGasWei:wei, diaUtc,
        lucroRealizadoWei:estado === 'confirmado' ? (2n*BigInt(wei)).toString() : undefined,
        gasRealL2Wei:estado === 'confirmado' ? '1' : undefined,
    });
const config = ():NodeJS.ProcessEnv => ({
    TITAN_DIARIO_OPERACOES:'/app/data/titan-diario-testes.json',
    TITAN_GAS_DIA_WEI:'100000000000000',
    TITAN_MAX_TX_DIA:'10',
});
test('configuracao de autorizacao permanente exige volume e dois limites', () => {
    const c=config();
    assert.equal(parametrosTitanContinuo(c).maxTxDia,10);
    for(const nome of ['TITAN_DIARIO_OPERACOES','TITAN_GAS_DIA_WEI','TITAN_MAX_TX_DIA']) {
        const x=config();delete x[nome];
        assert.throws(()=>parametrosTitanContinuo(x));
    }
});
test('custo do dia inteiro e reservado pelo TETO, nao pelo usado', () => {
    const r=[registro('confirmado','60000000000000'),registro('confirmado','20000000000000')];
    assert.equal(avaliarLimitesDiariosTitan(r,20000000000000n,100000000000000n,10,DIA),null);
    assert.match(avaliarLimitesDiariosTitan(r,20000000000001n,100000000000000n,10,DIA)!,/limite diario/);
});
test('hash pendente bloqueia novos envios mesmo no dia seguinte', () => {
    const ontem=[registro('pendente','10000000000000','2026-10-15')];
    assert.match(avaliarLimitesDiariosTitan(ontem,1n,100000000000000n,10,DIA)!,/pendente/);
});
test('limite diario de quantidade vale entre transacoes confirmadas', () => {
    const r=[registro('confirmado','1'),registro('confirmado','1')];
    assert.match(avaliarLimitesDiariosTitan(r,1n,100000000000000n,2,DIA)!,/transacoes/);
});
test('custo passado nao zera margem do dia corrente nem da permissao', () => {
    const r=[registro('confirmado','100000000000000','2026-10-15')];
    assert.equal(avaliarLimitesDiariosTitan(r,50000000000000n,100000000000000n,10,DIA),null);
});
test('custo negativo nunca e autorizado', () => {
    assert.match(avaliarLimitesDiariosTitan([], -1n,1000n,10,DIA)!,/limite diario/);
});
test('modo permanente nao usa relogio da autorizacao antiga', () => {
    const env:NodeJS.ProcessEnv={
        ...config(),
        TITAN_ENVIAR:'1',TITAN_CONFIRMAR:'OPERAR_BASE_REAL',
        TITAN_AUTORIZACAO_CONTINUA:'1',
        TITAN_NONCE_EXCLUSIVO:'1',
        TITAN_CONTRATO:'0x0000000000000000000000000000000000000011',
        TITAN_COFRE:'0x0000000000000000000000000000000000000022',
        TITAN_CHAVE_PRIVADA:'TEST_KEY_TEST_ONLY',
        TITAN_LUCRO_GAS_BPS:'500',TITAN_ORCAMENTO_GAS_WEI:'100000000000000',
        TITAN_OPERAR_ATE_UTC:'2020-01-01T00:00:00.000Z',
    };
    const plano:PlanoTitan={
        rota:[
            {pool:env.TITAN_CONTRATO!,tokenEntra:env.TITAN_COFRE!,tipo:0,pagamento:0n},
            {pool:env.TITAN_COFRE!,tokenEntra:env.TITAN_CONTRATO!,tipo:1,pagamento:0n},
        ],
        quantia:1n,bloco:52000000,brutoEstimado:100n,liquidoEstimado:5n,
        estadoConsistente:true,
    };
    // O journal da test-run nao existe no GitHub Actions, por isso esta
    // prevalidacao e pura; nenhum RPC nem chave valida sao usados.
    assert.equal(motivoDaRecusaTitan(plano,env),null);
    delete env.TITAN_GAS_DIA_WEI;
    assert.match(motivoDaRecusaTitan(plano,env)!,/controle duravel/);
});
