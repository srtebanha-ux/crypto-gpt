// Arquivo: src/ativacao.ts
//
// Um interruptor para os pontos de entrada que NÃO deveriam estar rodando.
//
// O repositório tem vários executáveis — motor de arbitragem, farejadores,
// teste de ordem real. O Railway sobe um serviço por ponto de entrada, e um
// push na branch reimplanta TODOS eles de uma vez. Pausar pela interface não
// resolve: a implantação seguinte religa o serviço pausado.
//
// O efeito prático era que toda correção no motor de scalping ressuscitava
// meia dúzia de processos que ninguém pediu — queimando crédito, gastando
// peso de API e, no caso de smokeTestOrder, mandando ordem de verdade.
//
// Aqui a decisão passa a morar no código: cada entrada perigosa exige uma
// variável própria para funcionar. Sem ela o processo anuncia o que é, diz
// como se livrar dele, e fica quieto — sem rede, sem ordem, sem custo além
// do contêiner que o Railway já cobraria de qualquer jeito.
//
// Fica QUIETO em vez de encerrar de propósito: um processo que sai é
// reiniciado pelo Railway em laço, e o laço enche o log de ruído justamente
// quando se está tentando ler a medição de outro serviço.
import { createLogger } from './logger';

const log = createLogger('ativacao');

/** Nome da variável que liga um ponto de entrada. */
export function chaveDeAtivacao(nome: string): string {
    return `ATIVAR_${nome.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Está ligado? Puro, para poder ser testado sem efeito nenhum. */
export function estaAtivado(nome: string, ambiente: NodeJS.ProcessEnv = process.env): boolean {
    return ambiente[chaveDeAtivacao(nome)] === '1';
}

/**
 * Barra a execução se o ponto de entrada não foi ligado explicitamente.
 *
 * Devolve `true` quando pode seguir. Quando barra, deixa o processo vivo e
 * ocioso e devolve `false` — cabe a quem chama simplesmente não continuar.
 */
export function exigirAtivacao(nome: string, ambiente: NodeJS.ProcessEnv = process.env): boolean {
    if (estaAtivado(nome, ambiente)) return true;

    const chave = chaveDeAtivacao(nome);
    log.warn(`SERVIÇO DESLIGADO: ${nome}.`, {
        porque: 'Este ponto de entrada não roda sem ativação explícita.',
        paraLigar: `defina ${chave}=1 nas variáveis do serviço`,
        paraRemover: 'apague este serviço no Railway — pausar não basta, o próximo deploy religa',
    });
    // Mantém o processo vivo sem fazer nada. Sair faria o Railway reiniciar em
    // laço, e o laço polui o log do serviço que está de fato medindo.
    setInterval(() => {}, 1 << 30);
    return false;
}
