/**
 * O REGISTRO DE TOKENS HOSTIS — por token, rota, bloco e causa.
 *
 * A dona do bot pediu por nome: *"Registre resultados por token, rota, bloco e
 * causa, com invalidação quando o estado relevante mudar. Tokens com
 * comportamento não convencional não devem receber aprovação por cálculo
 * teórico. Exija simulação integral."*
 *
 * POR QUE ISTO E NECESSARIO, e nao arrumacao: medido em 2026-10-14, as oito
 * melhores rotas de um bloco atravessavam TODAS o mesmo token — `0x7787…734f`,
 * que cobra 48% de taxa de transferencia. Um token taxado faz a reserva do pool
 * parecer mal precificada, entao ele SOBE no ranking de sobra e domina o topo
 * da lista para sempre. Sem registro, o motor simula o mesmo token hostil
 * indefinidamente e nunca chega aos candidatos que importam.
 *
 * A REGRA DURA: um veredicto de hostil so vem de SIMULACAO. Calculo teorico
 * nunca condena nem absolve um token aqui — e e por isso que `marcar` exige
 * o bloco e a rota em que a simulacao falhou.
 *
 * E A INVALIDACAO, que foi a parte que precisou de pensamento: taxa de
 * transferencia e propriedade do CODIGO do token, nao do estado do pool. Ela
 * nao muda quando a reserva muda — entao expirar o veredicto por bloco seria
 * jogar fora uma medicao boa e repetir a simulacao caras. O que PODE mudar e o
 * codigo: um token atualizavel, um proxy que troca de implementacao, um
 * `pause` que e levantado. Entao o veredicto e amarrado ao **hash do codigo** do
 * token no momento em que foi dado, e invalida quando esse hash muda.
 */

/** As causas, separadas porque pedem leituras diferentes. */
export type CausaHostil =
    /** A transferencia entrega menos do que manda. MEDIDO, nao suposto. */
    | 'taxaDeTransferencia'
    /** O pool recusou pelo invariante: o pagamento chegou curto. */
    | 'invarianteDoPool'
    /** O contrato tentou sacar mais do que tinha em maos. */
    | 'saldoInsuficiente'
    /** A transferencia reverteu entre contas arbitrarias. */
    | 'transferenciaRecusada'
    /** Reverteu sem motivo legivel. Hostil por precaucao, nao por prova. */
    | 'reversaoOpaca';

export interface VeredictoHostil {
    token: string;
    causa: CausaHostil;
    /** O bloco em que a simulacao falhou. */
    bloco: number;
    /** Os pools da rota que falhou, para o registro ser auditavel. */
    rota: string[];
    /**
     * O hash do codigo do token quando o veredicto foi dado.
     *
     * E a ANCORA da invalidacao: taxa de transferencia e propriedade do
     * codigo, e o que muda o comportamento e o codigo mudar. `null` quando nao
     * deu para ler — e aí o veredicto vale, mas nao sabe se envelheceu.
     */
    hashDoCodigo: string | null;
    em: number;
    /** A medida, quando houver: fracao retida na transferencia, em por mil. */
    retidoPorMil: number | null;
    /**
     * O veredicto veio POR ASSOCIACAO, e nao por medicao sobre este token.
     *
     * Uma rota de tres ou quatro pernas tem dois ou tres tokens incomuns. Se
     * ela reverte, qualquer um deles pode ser o culpado — e condenar os tres
     * pune inocente. Este campo separa as duas coisas, que pedem leituras
     * diferentes:
     *
     *   false  medido SOBRE ESTE TOKEN (transferencia real, fracao retida)
     *   true   suspeito por estar numa rota que falhou. Poda, nao prova
     *
     * A poda por associacao continua valendo — gastar gas de novo na mesma rota
     * e certo de perder — mas um veredicto `true` cede lugar a qualquer medicao
     * posterior, e a frase do log diz qual dos dois e.
     */
    porAssociacao: boolean;
}

export const VERSAO_DO_REGISTRO = 1;

export interface RegistroDeHostis {
    versao: number;
    /** chave: token minusculo. */
    porToken: Record<string, VeredictoHostil>;
}

export const registroVazio = (): RegistroDeHostis => ({
    versao: VERSAO_DO_REGISTRO, porToken: {},
});

export function comoLerACausa(c: CausaHostil): string {
    switch (c) {
        case 'taxaDeTransferencia':
            return 'a transferência entrega MENOS do que manda: medido por transferência real, '
                + 'não calculado. O pagamento do flash swap chega curto';
        case 'invarianteDoPool':
            return 'o pool recusou pelo invariante (UniswapV2: K): o que voltou não bastou';
        case 'saldoInsuficiente':
            return 'a perna seguinte tentou sacar mais do que havia em mãos — o que entra numa '
                + 'perna não é o que a conta previu';
        case 'transferenciaRecusada':
            return 'o token não transfere entre contas arbitrárias: um flash swap exige duas '
                + 'transferências, então a rota é inexecutável';
        case 'reversaoOpaca':
            return 'reverteu sem motivo legível. É hostil por PRECAUÇÃO e não por prova: sem '
                + 'identificação positiva não se gasta gás de novo no mesmo token';
    }
}

/**
 * Le a causa a partir da mensagem de reversao da SIMULACAO.
 *
 * Nao aceita mensagem vazia como nada: ausencia vira `reversaoOpaca`, que e um
 * veredicto declarado como precaucao — e nao silencio.
 */
export function causaDaReversao(mensagem: string | undefined): CausaHostil {
    const m = (mensagem ?? '').toLowerCase();
    if (m.includes('uniswapv2: k') || m.includes('invariant')) return 'invarianteDoPool';
    if (m.includes('insufficient account balance') || m.includes('subtraction overflow')
        || m.includes('transfer amount exceeds balance')) return 'saldoInsuficiente';
    if (m.includes('transfer') && (m.includes('fail') || m.includes('revert'))) {
        return 'transferenciaRecusada';
    }
    return 'reversaoOpaca';
}

export class Hostis {
    private readonly porToken = new Map<string, VeredictoHostil>();

    constructor(private readonly agora: () => number = () => Date.now()) {}

    /**
     * Condena um token, SO a partir de simulacao que falhou.
     *
     * Idempotente no sentido que importa: uma causa MEDIDA
     * (`taxaDeTransferencia`) nao e sobrescrita por uma de precaucao
     * (`reversaoOpaca`) — perder a medicao e trocar fato por suspeita.
     */
    marcar(v: Omit<VeredictoHostil, 'em'>): void {
        const k = v.token.toLowerCase();
        const antes = this.porToken.get(k);
        // MEDICAO NAO CEDE A ASSOCIACAO: perder um numero medido para uma
        // suspeita e trocar fato por palpite.
        if (antes !== undefined && antes.porAssociacao === false && v.porAssociacao === true) {
            return;
        }
        if (antes !== undefined
            && antes.causa === 'taxaDeTransferencia' && v.causa !== 'taxaDeTransferencia'
            && antes.porAssociacao === v.porAssociacao) {
            return;
        }
        this.porToken.set(k, { ...v, token: k, em: this.agora() });
    }

    /**
     * O veredicto, ou `null`.
     *
     * `hashAgora` permite a INVALIDACAO: se o codigo do token mudou desde o
     * veredicto, ele e descartado e o token volta a ser desconhecido — e
     * desconhecido nao e aprovado, e so nao e condenado.
     */
    veredicto(token: string, hashAgora?: string | null): VeredictoHostil | null {
        const k = token.toLowerCase();
        const v = this.porToken.get(k);
        if (v === undefined) return null;
        if (hashAgora !== undefined && hashAgora !== null
            && v.hashDoCodigo !== null && v.hashDoCodigo !== hashAgora) {
            this.porToken.delete(k);
            return null;
        }
        return v;
    }

    ehHostil(token: string, hashAgora?: string | null): boolean {
        return this.veredicto(token, hashAgora) !== null;
    }

    /** Alguma perna da rota passa por token condenado? */
    rotaTemHostil(tokens: string[]): { tem: boolean; qual: VeredictoHostil | null } {
        for (const t of tokens) {
            const v = this.veredicto(t);
            if (v !== null) return { tem: true, qual: v };
        }
        return { tem: false, qual: null };
    }

    get quantos(): number { return this.porToken.size; }
    todos(): VeredictoHostil[] { return [...this.porToken.values()]; }

    paraDisco(): RegistroDeHostis {
        const porToken: Record<string, VeredictoHostil> = {};
        for (const [k, v] of this.porToken) porToken[k] = v;
        return { versao: VERSAO_DO_REGISTRO, porToken };
    }

    /** Le do disco. Arquivo torto devolve registro VAZIO, nunca lanca. */
    doDisco(cru: unknown): void {
        if (typeof cru !== 'object' || cru === null) return;
        const r = (cru as RegistroDeHostis).porToken;
        if (typeof r !== 'object' || r === null) return;
        for (const [k, v] of Object.entries(r)) {
            if (typeof v !== 'object' || v === null) continue;
            const t = v as Partial<VeredictoHostil>;
            if (typeof t.token !== 'string' || typeof t.causa !== 'string') continue;
            if (typeof t.bloco !== 'number' || typeof t.em !== 'number') continue;
            this.porToken.set(k.toLowerCase(), {
                token: k.toLowerCase(),
                causa: t.causa as CausaHostil,
                bloco: t.bloco,
                rota: Array.isArray(t.rota) ? t.rota.filter((x) => typeof x === 'string') : [],
                hashDoCodigo: typeof t.hashDoCodigo === 'string' ? t.hashDoCodigo : null,
                em: t.em,
                retidoPorMil: typeof t.retidoPorMil === 'number' ? t.retidoPorMil : null,
                // AUSENTE vira `true`: um registro velho nao sabe se foi medido,
                // e tratar duvida como medicao seria afirmar o que nao se tem.
                porAssociacao: t.porAssociacao !== false,
            });
        }
    }

    comoLer(): string {
        if (this.porToken.size === 0) {
            return 'nenhum token condenado — e isto NÃO é "não há token hostil": é "nenhuma '
                + 'simulação condenou um ainda"';
        }
        const porCausa = new Map<CausaHostil, number>();
        for (const v of this.porToken.values()) {
            porCausa.set(v.causa, (porCausa.get(v.causa) ?? 0) + 1);
        }
        const partes = [...porCausa.entries()].map(([c, n]) => `${n} por ${c}`);
        const medidos = [...this.porToken.values()].filter((v) => !v.porAssociacao).length;
        const porAssoc = this.porToken.size - medidos;
        return `${this.porToken.size} token(s) condenado(s) por SIMULAÇÃO: ${partes.join(', ')}`
            + ` | ${medidos} MEDIDO(S) sobre o próprio token, ${porAssoc} por ASSOCIAÇÃO`
            + (porAssoc > 0
                ? ' (suspeitos por estarem numa rota que falhou — é poda, não prova, e pode'
                    + ' excluir token inocente)'
                : '');
    }
}
