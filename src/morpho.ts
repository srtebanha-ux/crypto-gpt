// Arquivo: src/morpho.ts
//
// A matematica do Morpho Blue — a parte que nao precisa de rede.
//
// POR QUE ESTE ARQUIVO EXISTE. A dona do bot disse "ATIRAR PRA GANHAR" depois
// de medido que o caminho da Aave na Base nao tem alvo ganhavel: 55
// oportunidades em 46,3 dias, e as que dao tempo de ler valem menos que o gas.
// O censo de 30 dias mediu que a Aave e 12% do bolo de bonus da Base e o
// Morpho e 81%.
//
// E ELE COMECA PELA CONTA, NAO PELO CONTRATO, de proposito: a REGRA 0 deste
// projeto proibe pedir deploy em cima de teste unitario, e construir o
// contrato antes de a conta estar conferida contra a rede seria construir em
// cima do meu palpite. Cada funcao aqui diz se esta VERIFICADA e contra o que.
import { Decimal } from 'decimal.js';

/** Uma unidade, na escala do Morpho (WAD). */
export const WAD = new Decimal(10).pow(18);

/**
 * A escala do preco que o oraculo do Morpho devolve.
 *
 * NAO VERIFICADO contra a rede ainda — e esta declarado porque importa: se
 * esta escala estiver errada, a saude sai por um fator de 10^n e o bot miraria
 * em posicao sadia (ou deixaria de ver a quebrada). O portao que fecha isto e
 * `saudeConfere`, abaixo: a conta so vale quando bate com o que o proprio
 * Morpho responde. Mesmo desenho do `limiaresConferem` da Aave, que recusou 10
 * medicoes erradas em vez de imprimi-las.
 */
export const ESCALA_DO_ORACULO = new Decimal(10).pow(36);

/**
 * O CURSOR e o TETO do incentivo de liquidacao do Morpho Blue.
 *
 * VERIFICADOS, e nao pela minha memoria: contra as SEIS medianas que o censo
 * de 10 dias deste projeto mediu (cobertura 100%, 1.385 janelas, 60
 * liquidacoes, bonus tirado dos proprios eventos sem preco externo):
 *
 *     LLTV    formula   censo    diferenca
 *     62,5%   12,68%   16,47%    -3,79   <- divergiu
 *     77,0%    7,41%    9,27%    -1,86   <- divergiu
 *     86,0%    4,38%    4,40%    -0,02   BATE
 *     91,5%    2,62%    2,73%    -0,11   BATE
 *     94,5%    1,68%    1,68%    -0,00   BATE
 *     96,5%    1,06%    1,11%    -0,05   BATE
 *
 * Quatro de seis dentro de 0,11 ponto e verificacao, nao coincidencia.
 *
 * E AS DUAS QUE DIVERGEM CORRIGEM UM NUMERO QUE ESTE PROJETO PUBLICOU. Elas
 * divergem para CIMA, e so nos LLTV baixos — que sao os pares exoticos
 * (cbZEC, cbDOGE, cbLTC, cbXRP), os mais volateis. E exatamente onde a
 * armadilha que o proprio censo DECLAROU morde: "o oraculo e lido AGORA e as
 * liquidacoes sao do passado".
 *
 * Entao o "bonus de 9-16% nos mercados de LLTV <= 77%" que o CLAUDE.md
 * registra estava inflado pela deriva: o teto do protocolo e 15%, e 16,47%
 * nao e alcancavel por incentivo nenhum. O numero certo a 62,5% e **12,68%**.
 *
 * A conclusao da estrategia SOBREVIVE — 12,68% contra os 4,56% medidos no alvo
 * real da Aave de 07/10 e 2,8x — mas quem citar 16,47% vai estar citando
 * deriva de oraculo como se fosse incentivo.
 */
export const CURSOR_DE_LIQUIDACAO = new Decimal('0.3');
export const TETO_DO_INCENTIVO = new Decimal('1.15');

/**
 * O fator de incentivo (LIF): quanto de garantia o liquidante leva por unidade
 * de divida que paga. `1.05` quer dizer 5% de bonus.
 *
 * `lltv` entra como fracao (0,77 e nao 77).
 */
export function incentivoDeLiquidacao(lltv: Decimal): Decimal | null {
    if (!lltv.isFinite() || lltv.lessThanOrEqualTo(0) || lltv.greaterThanOrEqualTo(1)) return null;
    const bruto = new Decimal(1).dividedBy(
        new Decimal(1).minus(CURSOR_DE_LIQUIDACAO.mul(new Decimal(1).minus(lltv))),
    );
    return Decimal.min(TETO_DO_INCENTIVO, bruto);
}

/** O bonus em porcentagem, que e o que o log mostra. */
export function bonusPct(lltv: Decimal): Decimal | null {
    const lif = incentivoDeLiquidacao(lltv);
    return lif === null ? null : lif.minus(1).mul(100);
}

export interface PosicaoNoMorpho {
    /** Garantia depositada, em unidades CRUAS do token de garantia. */
    garantiaCrua: Decimal;
    /** A divida JA convertida de shares para assets, em unidades cruas. */
    dividaCrua: Decimal;
    /** `price()` do oraculo do mercado, na escala de 1e36. */
    precoDoOraculo: Decimal;
    /** O LLTV do mercado, como fracao (0,77). */
    lltv: Decimal;
}

/**
 * A SAUDE de uma posicao do Morpho — acima de 1 esta sadia.
 *
 * No Morpho a saude e POR MERCADO, e nao uma por carteira como a Aave: a mesma
 * pessoa pode estar quebrada num mercado e folgada em outro. Isto muda o
 * desenho do cacador e e a razao de este arquivo existir separado.
 *
 *     maxDivida = garantia x preco / 1e36 x lltv
 *     saude     = maxDivida / divida
 *
 * `null` quando a divida e zero (nao ha o que liquidar) ou quando algum numero
 * nao da para usar. **Ausencia nao vira 1 nem vira 0**: as duas mentiriam em
 * direcoes opostas, e este projeto perdeu dias por isso.
 */
export function saudeNoMorpho(p: PosicaoNoMorpho): Decimal | null {
    for (const v of [p.garantiaCrua, p.dividaCrua, p.precoDoOraculo, p.lltv]) {
        if (!v.isFinite() || v.isNegative()) return null;
    }
    if (p.dividaCrua.lessThanOrEqualTo(0)) return null;
    if (p.lltv.lessThanOrEqualTo(0) || p.lltv.greaterThanOrEqualTo(1)) return null;
    const maxDivida = p.garantiaCrua.mul(p.precoDoOraculo).dividedBy(ESCALA_DO_ORACULO).mul(p.lltv);
    return maxDivida.dividedBy(p.dividaCrua);
}

/**
 * Quanto a GARANTIA precisa cair, em %, para a posicao ficar liquidavel.
 *
 * E a gemea de `quedaAteLiquidar` da Aave, e herda a mesma ressalva que custou
 * um capitulo do CLAUDE.md: isto responde "quanto a garantia pode cair com a
 * divida parada". Quando garantia e divida sao a MESMA moeda o preco se
 * cancela e a resposta e falsa — por isso quem usa tem de passar pelo corte de
 * par imune, como o caminho da Aave ja faz.
 *
 * `null` sem saude; ZERO quando ja esta liquidavel.
 */
export function quedaAteLiquidarNoMorpho(p: PosicaoNoMorpho): Decimal | null {
    const saude = saudeNoMorpho(p);
    if (saude === null) return null;
    if (saude.lessThanOrEqualTo(1)) return new Decimal(0);
    return new Decimal(1).minus(new Decimal(1).dividedBy(saude)).mul(100);
}

/**
 * O PORTAO que impede publicar saude errada — e ele e o motivo de a escala do
 * oraculo poder estar nao verificada sem isso ser perigoso.
 *
 * O Morpho nao expoe um `getUserAccountData` com a saude pronta como a Aave.
 * Entao a conferencia possivel e outra: o proprio protocolo decide se aceita
 * uma liquidacao. Se a nossa conta diz "liquidavel" e o `eth_call` da
 * liquidacao reverte por saude, a conta esta errada — e e ISSO que tem de
 * aparecer, em vez de o bot atirar dinheiro numa escala trocada.
 *
 * Esta funcao existe para o chamador registrar a discordancia. Ela nao
 * adivinha: devolve o veredicto para o log.
 */
export function saudeConfere(
    nossa: Decimal | null,
    oProtocoloAceitouLiquidar: boolean,
): { confere: boolean; porque: string } {
    if (nossa === null) {
        return {
            confere: !oProtocoloAceitouLiquidar,
            porque: oProtocoloAceitouLiquidar
                ? 'O PROTOCOLO ACEITOU liquidar e eu não soube calcular a saúde: '
                  + 'minha conta está cega onde ele vê alvo'
                : 'não calculei a saúde e ele também não aceitou: nada a conferir',
        };
    }
    const euDigoLiquidavel = nossa.lessThanOrEqualTo(1);
    if (euDigoLiquidavel === oProtocoloAceitouLiquidar) {
        return {
            confere: true,
            porque: `minha saúde ${nossa.toFixed(8)} e o protocolo concordam `
                + `(${euDigoLiquidavel ? 'liquidável' : 'sadia'})`,
        };
    }
    return {
        confere: false,
        porque: euDigoLiquidavel
            ? `EU digo liquidável (saúde ${nossa.toFixed(8)}) e o protocolo RECUSOU: `
              + 'minha escala ou meu LLTV estão errados, e atirar aqui é pagar gás por nada'
            : `EU digo sadia (saúde ${nossa.toFixed(8)}) e o protocolo ACEITOU: `
              + 'estou deixando alvo passar por erro de conta',
    };
}
