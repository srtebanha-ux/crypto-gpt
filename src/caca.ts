// Arquivo: src/caca.ts
//
// Montar a caçada e LER o que a rede responde sem enviar nada.
//
// O truque que faz este arquivo valer mais que um executor simples está no
// piso. `cacar` reverte com `LucroInsuficiente(obtido, exigido)` quando o
// lucro fica abaixo do mínimo — e essa reversão CARREGA o lucro que teria
// saído. Então mandar um piso impossível de propósito, por `eth_call`, faz o
// contrato executar a caçada inteira contra a Aave de verdade e o pool de
// verdade e devolver, no erro, quanto ela teria rendido.
//
// Isso mede o que este projeto ainda estava supondo: o ágio real daquela
// moeda (eu chutava 5%), a perda real na venda (eu chutava 0,3%), e se o
// formato da chamada está certo. Sem gás, sem risco, com números da rede.
//
// E resolve o problema de "consertar com ele rodando". Ao vivo, uma tentativa
// perdida reverte — e reverte igual se foi concorrente mais rápido, preço que
// mexeu, ou código errado. Pelo `eth_call` a resposta vem com nome: o erro é
// da Aave, é do pool, é do piso, ou é meu.
import { AbiCoder, id } from 'ethers';
import { Decimal } from 'decimal.js';

const coder = AbiCoder.defaultAbiCoder();

export const ASSINATURA_CACAR = 'cacar(address,address,address,uint256,address,uint256)';
export const SELETOR_CACAR = id(ASSINATURA_CACAR).slice(0, 10);

/** Um piso que nenhum lucro alcança. Serve só para forçar a reversão que mede. */
export const PISO_IMPOSSIVEL = (1n << 255n);

export interface PedidoDeCaca {
    garantia: string;
    divida: string;
    devedor: string;
    quantoCobrir: bigint;
    poolDeVenda: string;
    lucroMinimo: bigint;
}

export function codificarCaca(p: PedidoDeCaca): string {
    return (
        SELETOR_CACAR +
        coder
            .encode(
                ['address', 'address', 'address', 'uint256', 'address', 'uint256'],
                [p.garantia, p.divida, p.devedor, p.quantoCobrir, p.poolDeVenda, p.lucroMinimo],
            )
            .slice(2)
    );
}

export const NOMES_DE_ERRO_DO_CACADOR = [
    'NaoAutorizado()',
    'ChamadaInesperada()',
    'LucroInsuficiente(uint256,uint256)',
    'PoolSemLiquidez()',
    'CofreInvalido()',
];

export const SELETOR_LUCRO_INSUFICIENTE = id('LucroInsuficiente(uint256,uint256)').slice(0, 10);

export type Desfecho =
    | 'passaria' // o eth_call não reverteu: a caçada inteira executaria
    | 'mediu' // reverteu no piso, e o erro trouxe o lucro real
    | 'pool' // a venda não tinha liquidez
    | 'aave' // a Aave recusou (posição saudável, par errado, formato)
    | 'permissao' // guarda do contrato recusou quem chamou
    | 'rede' // o provedor não respondeu; não é veredicto sobre a caçada
    | 'desconhecido';

export interface LeituraDaCaca {
    desfecho: Desfecho;
    /** Quanto a caçada teria rendido, em unidades cruas da moeda da dívida. */
    lucroCru: bigint | null;
    erro: string | null;
    leitura: string;
}

/**
 * O que a rede respondeu, com nome.
 *
 * A separação que importa é entre "não deu certo" e "não deu para saber". Um
 * limite de provedor e uma posição saudável produzem o mesmo silêncio no log
 * de quem só conta sucessos — e são coisas opostas: uma é para tentar de novo,
 * a outra é para desistir desta posição.
 */
export function lerRespostaDaCaca(
    r: { ok: true; dados: string } | { ok: false; mensagem: string; dados?: string },
): LeituraDaCaca {
    if (r.ok) {
        return {
            desfecho: 'passaria',
            lucroCru: null,
            erro: null,
            leitura: 'a caçada inteira executaria: empréstimo, liquidação, venda e devolução',
        };
    }

    const dados = (r.dados ?? r.mensagem.match(/0x[0-9a-fA-F]{8,}/)?.[0] ?? '').toLowerCase();
    const seletor = dados.slice(0, 10);

    if (seletor === SELETOR_LUCRO_INSUFICIENTE && dados.length >= 10 + 128) {
        // O erro carrega (obtido, exigido). O primeiro é a medição.
        const [obtido] = coder.decode(['uint256', 'uint256'], '0x' + dados.slice(10));
        const lucroCru = BigInt(obtido.toString());
        return {
            desfecho: 'mediu',
            lucroCru,
            erro: null,
            leitura:
                lucroCru > 0n
                    ? `a caçada executou e renderia ${lucroCru} em unidades cruas da moeda da dívida`
                    : 'a caçada executou e renderia ZERO: os custos comeram o ágio inteiro',
        };
    }

    for (const nome of NOMES_DE_ERRO_DO_CACADOR) {
        if (seletor !== id(nome).slice(0, 10)) continue;
        if (nome === 'PoolSemLiquidez()') {
            return {
                desfecho: 'pool',
                lucroCru: null,
                erro: nome,
                leitura: 'o pool de venda não tinha o que entregar — endereço errado ou pool vazio',
            };
        }
        return {
            desfecho: 'permissao',
            lucroCru: null,
            erro: nome,
            leitura: `o próprio contrato recusou: ${nome}. Não é a rede, é quem chamou ou o estado dele`,
        };
    }

    if (/rate limit|429|too many requests|timeout|capacity/i.test(r.mensagem)) {
        return {
            desfecho: 'rede',
            lucroCru: null,
            erro: r.mensagem,
            leitura: 'o provedor não respondeu. Isto NÃO é veredicto sobre a caçada — é para tentar de novo',
        };
    }

    // Qualquer outra reversão veio de dentro da Aave durante a liquidação.
    if (seletor.length === 10 || /revert|execution reverted/i.test(r.mensagem)) {
        return {
            desfecho: 'aave',
            lucroCru: null,
            erro: r.mensagem.slice(0, 200),
            leitura: 'a Aave recusou a liquidação: posição já não está liquidável, ou o par escolhido não serve',
        };
    }

    return {
        desfecho: 'desconhecido',
        lucroCru: null,
        erro: r.mensagem.slice(0, 200),
        leitura: 'resposta que eu não sei classificar — vale ler inteira antes de concluir qualquer coisa',
    };
}

/** O lucro medido, em dólares, quando se sabe as casas e o preço da moeda. */
export function lucroEmDolar(lucroCru: bigint, decimais: number, precoUsd: Decimal): Decimal {
    return new Decimal(lucroCru.toString()).dividedBy(new Decimal(10).pow(decimais)).mul(precoUsd);
}

export interface Comparacao {
    medidoUsd: Decimal;
    previstoUsd: Decimal;
    diferencaPct: Decimal;
    bate: boolean;
    leitura: string;
}

/**
 * O medido contra o previsto — porque prever e nunca conferir é como as
 * suposições deste projeto viraram números de relatório.
 *
 * `perdaNaTroca: 0.003` e `AGIO_SUPOSTO: 0.05` são palpites que atravessaram a
 * noite inteira decidindo o que vale a pena. Esta função é onde eles param de
 * ser palpite: se o medido ficar longe do previsto, um dos dois está errado, e
 * o relatório tem de dizer isso em vez de mostrar só o número bonito.
 */
export function compararComPrevisto(medidoUsd: Decimal, previstoUsd: Decimal, tolerancia = 0.25): Comparacao {
    if (previstoUsd.lessThanOrEqualTo(0)) {
        return {
            medidoUsd,
            previstoUsd,
            diferencaPct: new Decimal(0),
            bate: false,
            leitura: 'não havia previsão positiva para comparar',
        };
    }
    const diferencaPct = medidoUsd.minus(previstoUsd).dividedBy(previstoUsd).mul(100);
    const bate = diferencaPct.abs().dividedBy(100).lessThanOrEqualTo(tolerancia);
    return {
        medidoUsd,
        previstoUsd,
        diferencaPct,
        bate,
        leitura: bate
            ? `medido US$${medidoUsd.toFixed(2)} contra US$${previstoUsd.toFixed(2)} previstos — as suposições se sustentam`
            : `medido US$${medidoUsd.toFixed(2)} contra US$${previstoUsd.toFixed(2)} previstos ` +
              `(${diferencaPct.toFixed(1)}%). O ágio ou a perda na venda que eu suponho está errado`,
    };
}
