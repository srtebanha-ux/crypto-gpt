/**
 * TITAN: autorizacao permanente, com orcamento DIARIO acumulado e trava duravel.
 * Nenhum prazo de validade: so desliga por TITAN_ENVIAR=0 ou retirada do modo.
 * O arquivo fica em volume Railway: nunca considerar ausencia/JSON torto
 * como permissao de zerar um historico que foi perdido.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Registro {
    hash: string;
    diaUtc: string;
    tetoGasWei: string;
    estado: 'pendente' | 'confirmado' | 'revertido';
    enviadoEm: string;
    lucroRealizadoWei?: string;
    gasRealL2Wei?: string;
}
interface Diario {
    versao: 1;
    registros: Registro[];
}
const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^\d+$/;
const maxRegistros = 100_000;

export function parametrosTitanContinuo(env: NodeJS.ProcessEnv): {
    arquivo: string; tetoGasDia: bigint; maxTxDia: number;
} {
    const arquivo = env.TITAN_DIARIO_OPERACOES;
    if (!arquivo || !arquivo.startsWith('/app/data/') || arquivo.includes('..')
        || !arquivo.endsWith('.json')) {
        throw new Error('diario persistente em /app/data/*.json obrigatorio');
    }
    const limite = env.TITAN_GAS_DIA_WEI;
    const quantidade = env.TITAN_MAX_TX_DIA;
    if (!limite || !DECIMAL.test(limite) || BigInt(limite) <= 0n
        || !quantidade || !DECIMAL.test(quantidade)) {
        throw new Error('limites diarios de gas e quantidade ausentes ou invalidos');
    }
    const maxTxDia = Number(quantidade);
    if (!Number.isSafeInteger(maxTxDia) || maxTxDia < 1 || maxTxDia > 10_000) {
        throw new Error('TITAN_MAX_TX_DIA fora de 1 a 10000');
    }
    return { arquivo, tetoGasDia: BigInt(limite), maxTxDia };
}

function lerDiario(arquivo: string): Diario {
    if (!fs.existsSync(arquivo)) return { versao: 1, registros: [] };
    const raw = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || (raw as Diario).versao !== 1
        || !Array.isArray((raw as Diario).registros)
        || (raw as Diario).registros.length > maxRegistros) {
        throw new Error('diario do TITAN invalido; envio bloqueado');
    }
    const d = raw as Diario;
    if (!d.registros.every(x=>x && HASH.test(x.hash)
        && /^\d{4}-\d{2}-\d{2}$/.test(x.diaUtc)
        && DECIMAL.test(x.tetoGasWei)
        && ['pendente','confirmado','revertido'].includes(x.estado))) {
        throw new Error('registro do TITAN invalido; envio bloqueado');
    }
    return d;
}
function salvarDiario(arquivo: string, dados: Diario): void {
    const tmp = arquivo + '.tmp';
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(dados));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, arquivo);
    const pasta = fs.openSync(path.dirname(arquivo), 'r');
    try { fs.fsyncSync(pasta); } finally { fs.closeSync(pasta); }
}
function travar<T>(arquivo: string, fn: () => T): T {
    // No caso de queda do processo, a trava fica. Reconciliacao manual necessaria;
    // NUNCA roubar trava automaticamente, que pode pertencer a outro container.
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const lock = arquivo + '.lock';
    const fd = fs.openSync(lock, 'wx', 0o600);
    try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
/** Logica pura do orcamento conservador; nunca devolve permissao com hash pendente. */
export function avaliarLimitesDiariosTitan(
    registros: ReadonlyArray<Pick<Registro,'diaUtc'|'tetoGasWei'|'estado'>>,
    custoReservadoWei: bigint, tetoGasDia: bigint, maxTxDia: number, agora = new Date(),
): string | null {
    if (registros.some(x=>x.estado === 'pendente')) {
        return 'existe hash pendente, conferir recibo antes de nova operacao';
    }
    const hoje = agora.toISOString().slice(0, 10);
    const feitos = registros.filter(x=>x.diaUtc === hoje);
    if (feitos.length >= maxTxDia) return 'limite de transacoes por dia atingido';
    const gastoReservado = feitos.reduce((t,x)=>t+BigInt(x.tetoGasWei),0n);
    if (custoReservadoWei < 0n || gastoReservado+custoReservadoWei > tetoGasDia) {
        return 'limite diario conservador de gas atingido';
    }
    return null;
}
export function impedimentoTitanContinuo(
    env: NodeJS.ProcessEnv, custoReservadoWei: bigint, agora = new Date(),
): string | null {
    const { arquivo, tetoGasDia, maxTxDia } = parametrosTitanContinuo(env);
    const livro = lerDiario(arquivo);
    return avaliarLimitesDiariosTitan(
        livro.registros, custoReservadoWei, tetoGasDia, maxTxDia, agora,
    );
}
/** Reserva ENQUANTO o lock exclusivo esta mantido, ANTES do broadcast. */
export function reservarTitanContinuo(
    env: NodeJS.ProcessEnv, hash: string, custoReservadoWei: bigint, agora = new Date(),
): void {
    if (!HASH.test(hash) || custoReservadoWei <= 0n) throw new Error('reserva invalida');
    const { arquivo } = parametrosTitanContinuo(env);
    travar(arquivo, () => {
        const impedimento = impedimentoTitanContinuo(env,custoReservadoWei,agora);
        if (impedimento) throw new Error(impedimento);
        const dados = lerDiario(arquivo);
        if (dados.registros.some(x=>x.hash.toLowerCase()===hash.toLowerCase())) {
            throw new Error('hash ja reservado');
        }
        dados.registros.push({ hash, diaUtc: agora.toISOString().slice(0,10),
            tetoGasWei: custoReservadoWei.toString(), estado: 'pendente',
            enviadoEm: agora.toISOString() });
        salvarDiario(arquivo,dados);
    });
}
export function fecharTitanContinuo(
    env: NodeJS.ProcessEnv, hash: string, estado: 'confirmado' | 'revertido',
    gasRealL2Wei?: bigint, lucroRealizadoWei?: bigint,
): void {
    const { arquivo } = parametrosTitanContinuo(env);
    travar(arquivo, () => {
        const dados = lerDiario(arquivo);
        const r = dados.registros.find(x=>x.hash.toLowerCase()===hash.toLowerCase());
        if (!r || r.estado !== 'pendente') throw new Error('hash nao pendente no diario');
        r.estado=estado;
        if (gasRealL2Wei!==undefined) r.gasRealL2Wei=gasRealL2Wei.toString();
        if (lucroRealizadoWei!==undefined) r.lucroRealizadoWei=lucroRealizadoWei.toString();
        salvarDiario(arquivo,dados);
    });
}
