/**
 * Escolha de cotações do TITAN. Nenhum corte econômico aqui: as rotas não
 * selecionadas ficam como NÃO COTADAS POR LIMITE DE CAPACIDADE, não descartadas.
 * Reservamos vagas para rotas sem teto matemático (stable/sem leitura).
 */
import type { CandidataMista, Triagem, RazaoMaxima } from './rotasMistas';

export interface SelecaoDeCotacao {
    selecionadas: CandidataMista[];
    adiadas: number;
    conhecidas: number;
    semProva: number;
}
function fracao(r: { emprestimo: RazaoMaxima; venda: RazaoMaxima }) {
    return { num: r.emprestimo.num * r.venda.num, den: r.emprestimo.den * r.venda.den };
}
export function priorizarCotacoes(
    afetadas: CandidataMista[], tri: Triagem, teto: number, rodada: number,
    rotacionarComProva=false,
): SelecaoDeCotacao {
    if (!Number.isSafeInteger(teto) || teto < 1 || teto > 256) {
        throw new Error('ARB_COTAR_MAX_ROTAS deve estar entre 1 e 256');
    }
    if (!Number.isSafeInteger(rodada) || rodada < 0) throw new Error('rodada invalida');
    if (afetadas.length <= teto) return {
        selecionadas: afetadas, adiadas: 0, conhecidas: afetadas.length, semProva: 0,
    };
    const comRazao: Array<{ c: CandidataMista; num: bigint; den: bigint }> = [];
    const semRazao: CandidataMista[] = [];
    for (const c of afetadas) {
        const r = tri.veredictos.get(c.chave)?.razoes;
        if (!r || !r.emprestimo || !r.venda || r.emprestimo.den <= 0n
            || r.venda.den <= 0n) {
            semRazao.push(c);
        } else {
            comRazao.push({ c, ...fracao({ emprestimo: r.emprestimo, venda: r.venda }) });
        }
    }
    // Comparação exata: nenhum float, nenhum overflow de Number, nenhuma
    // conversão de tokens de decimais diferentes.
    comRazao.sort((a, b) => {
        const dif = a.num * b.den - b.num * a.den;
        if (dif > 0n) return -1;
        if (dif < 0n) return 1;
        return a.c.chave.localeCompare(b.c.chave);
    });
    const vagasSemProva = semRazao.length > 0 ? Math.max(1, Math.floor(teto / 4)) : 0;
    const conhecidasDisponiveis=teto-vagasSemProva;
    // Metade das vagas para maiores spreads comprovados; metade rota
    // entre candidatos menores que ficariam eternamente atras da fila.
    // O filtro economico nao muda: todas estas rotas passaram pela triagem.
    const fixas=rotacionarComProva
        ? Math.max(1,Math.ceil(conhecidasDisponiveis/2)) : conhecidasDisponiveis;
    const principais=comRazao.slice(0,fixas).map(x=>x.c);
    const fundo=comRazao.slice(fixas).map(x=>x.c);
    const vagasRotativas=Math.max(0,conhecidasDisponiveis-principais.length);
    const rotativas=fundo.length===0 ? [] : Array.from({
        length:Math.min(vagasRotativas,fundo.length),
    },(_,i)=>fundo[(rodada*Math.max(1,vagasRotativas)+i)%fundo.length]!);
    const remanescentes=rotacionarComProva?rotativas
        :comRazao.slice(conhecidasDisponiveis).map(x=>x.c);
    const disponiveis = teto - principais.length-(rotacionarComProva?rotativas.length:0);
    const desconhecidas = semRazao.length > 0 ? Array.from(
        { length: Math.min(disponiveis, semRazao.length) },
        (_, i) => semRazao[(rodada * Math.max(1, disponiveis) + i) % semRazao.length]!,
    ) : [];
    const sobra = rotacionarComProva?[]:remanescentes.slice(0, Math.max(0, disponiveis - desconhecidas.length));
    const selecionadas = [...principais, ...rotacionarComProva?rotativas:[], ...desconhecidas, ...sobra];
    return {
        selecionadas, adiadas: afetadas.length - selecionadas.length,
        conhecidas: principais.length + rotativas.length + sobra.length, semProva: desconhecidas.length,
    };
}
