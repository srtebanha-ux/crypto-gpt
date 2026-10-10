// Arquivo: src/pisoDaSaude.ts
//
// ATE ONDE O PRECO CONSEGUE DERRUBAR ESTA POSICAO — e, para muitas delas, a
// resposta e "nao consegue".
//
// Isto sai de uma medicao de 2026-09-28, depois de um aviso do Gemini sobre o
// alvo `0xc4d36f95` ter aparecido no log com garantia e divida na MESMA moeda.
// Conferido na rede, com as funcoes deste repositorio:
//
//     garantia  WETH  1,223621  (US$ 3.277,19)   usadaComoGarantia=true
//     garantia  cbBTC 0,000500  (US$    41,64)   usadaComoGarantia=true
//     divida    WETH  1,133676  (US$ 3.036,29)
//     getUserEMode = 1,  limiar misturado da Aave = 92,81%,  saude = 1,014468
//
// O bot publicava, para essa posicao, "precisa cair 1,4278%". Esse numero vem
// de `quedaAteLiquidar`, que responde "quanto a GARANTIA pode cair com a divida
// parada" — a pergunta certa para garantia em WETH e divida em USDC. Aqui a
// divida e WETH tambem: quando o ETH cai, os DOIS lados caem juntos e o preco
// se cancela.
//
// A conta fechada, com LT do E-Mode = 93% e do cbBTC = 78% (os dois conferidos
// contra o limiar misturado que a propria Aave devolve):
//
//     ETH  -50%  ->  saude 1,025110      <- CAIR deixa a posicao MAIS SEGURA
//     ETH  -10%  ->  saude 1,015633
//     ETH    0%  ->  saude 1,014448      (a Aave diz 1,014468)
//     ETH  +10%  ->  saude 1,013479
//     ETH +1000% ->  saude 1,004756
//     ETH -> infinito, BTC -> 0:  1,003786   <- O PISO
//
// NENHUM movimento de preco, de nenhum ativo, em nenhuma direcao e por nenhum
// tamanho, leva essa posicao abaixo de 1,003786. A queda de 1,4278% que o bot
// esperava e inalcancavel por preco. So o JURO chega la — e para isso este
// repositorio ja tem `src/deriva.ts`, que projeta a hora da chegada.
//
// A CONTA, e ela e exata:
//
//     saude(p) = SOMA_i C_i p_i LT_i / SOMA_j D_j p_j
//
// com os precos `p` livres e positivos. Uma razao de duas formas lineares
// positivas tem infimo num vertice: joga-se todo o peso num preco so. Os
// ativos sem divida mandam a razao para o infinito; entao
//
//     piso = MENOR, entre os ativos k em que ha divida, de
//            (garantia em k) x (limiar de k) / (divida em k)
//
// Precos andam juntos no mundo real, e correlacao so ENCOLHE o conjunto
// alcancavel. Entao este piso e um limite INFERIOR: se ele ja esta acima de 1,
// a posicao nao cai por preco, e isso e conclusao, nao estimativa. Se esta
// abaixo de 1, ele nao promete que o preco chega la — diz so que a conta nao
// proibe.
import { Decimal } from 'decimal.js';

/** Um ativo da posicao, ja convertido a dolar pelo preco de hoje. */
export interface ParteDaPosicao {
    ativo: string;
    /** Valor DEPOSITADO e contado como garantia. Zero se a Aave nao conta. */
    garantiaUsd: Decimal;
    /** Valor DEVIDO neste ativo. */
    dividaUsd: Decimal;
    /** Limiar de liquidacao efetivo deste ativo para ESTE usuario, de 0 a 1. */
    limiar: Decimal;
}

export interface PisoDaSaude {
    /** O menor valor que a saude pode assumir por PRECO. `null` = sem dívida. */
    piso: Decimal | null;
    /** `true` quando nenhum preco derruba a posicao: o piso ficou em 1 ou acima. */
    imuneAPreco: boolean;
    leitura: string;
}

/**
 * Ate onde o preco consegue empurrar a saude desta posicao.
 *
 * Sem divida nenhuma nao ha piso e nao ha liquidacao: devolve `null`, e nao
 * zero. Zero seria "cai a qualquer momento", o oposto da verdade, e e
 * exatamente o tipo de ausencia com cara de resposta que este projeto persegue.
 */
export function pisoDaSaudePorPreco(partes: ParteDaPosicao[]): PisoDaSaude {
    const comDivida = partes.filter((p) => p.dividaUsd.greaterThan(0));
    if (comDivida.length === 0) {
        return { piso: null, imuneAPreco: true, leitura: 'sem dívida: não há o que liquidar' };
    }

    let piso: Decimal | null = null;
    let onde = '';
    for (const p of comDivida) {
        // O vertice deste ativo: todo o peso no preco dele. Os outros vao a
        // zero, e some tudo que nao esta nas duas pontas deste mesmo ativo.
        const razao = p.garantiaUsd.mul(p.limiar).dividedBy(p.dividaUsd);
        if (piso === null || razao.lessThan(piso)) { piso = razao; onde = p.ativo; }
    }

    const imune = piso!.greaterThanOrEqualTo(1);
    const nome = onde.length > 10 ? `${onde.slice(0, 10)}…` : onde;
    return {
        piso,
        imuneAPreco: imune,
        leitura: imune
            ? `preço NÃO derruba: por mais que ande, a saúde não desce de ${piso!.toFixed(6)} `
              + `(a garantia e a dívida são o mesmo ativo ${nome}, e o preço se cancela) — só o juro chega lá`
            : `preço pode derrubar: a saúde chega a ${piso!.toFixed(6)} no pior caso de preço (pelo lado do ${nome})`,
    };
}

/**
 * Os limiares batem com o que a Aave diz?
 *
 * O limiar de cada ativo muda com o E-Mode do usuario, e modelar as regras do
 * E-Mode aqui seria reescrever a Aave de cabeca — o jeito mais rapido de
 * publicar um numero inventado. Entao nao se modela: confere-se.
 *
 * `getUserAccountData` devolve o limiar MISTURADO, que e a media dos limiares
 * pesada pela garantia. Se a mistura dos meus limiares nao reproduz o numero
 * dela, os meus estao errados e o piso nao sai — sai "nao deu para medir".
 *
 * Tolerancia de 0,5 ponto percentual: os precos das duas leituras sao de
 * instantes diferentes, e a Aave arredonda o limiar em centesimos.
 */
export function limiaresConferem(
    partes: ParteDaPosicao[],
    limiarMisturadoDaAave: Decimal,
    tolerancia = new Decimal('0.005'),
): { confere: boolean; meu: Decimal | null; leitura: string } {
    const totalGarantia = partes.reduce((s, p) => s.plus(p.garantiaUsd), new Decimal(0));
    if (totalGarantia.lessThanOrEqualTo(0)) {
        return { confere: false, meu: null, leitura: 'sem garantia contada: não dá para conferir o limiar' };
    }
    const meu = partes
        .reduce((s, p) => s.plus(p.garantiaUsd.mul(p.limiar)), new Decimal(0))
        .dividedBy(totalGarantia);
    const erro = meu.minus(limiarMisturadoDaAave).abs();
    return {
        confere: erro.lessThanOrEqualTo(tolerancia),
        meu,
        leitura: `limiar misturado: meu ${meu.mul(100).toFixed(2)}% contra ${limiarMisturadoDaAave.mul(100).toFixed(2)}% da Aave`
            + (erro.lessThanOrEqualTo(tolerancia) ? '' : ` — ERRO de ${erro.mul(100).toFixed(2)} pontos: não publico o piso`),
    };
}
