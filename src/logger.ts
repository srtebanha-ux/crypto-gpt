// Arquivo: src/logger.ts
//
// Logger mínimo com timestamp ISO e nível, para saída consistente em toda a
// aplicação (stdout para info/warn, stderr para warn/error, seguindo a
// convenção de streams do Node).
type LogFields = Record<string, unknown> | undefined;

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

// Padrão 'info' (nunca silencioso em produção — live.ts precisa dos logs de
// ciclo para observabilidade 24/7). Só relevante pra suprimir o volume de
// log de simulações em lote (ex.: várias rodadas de paperTradingSimulation.ts
// pra comparar seeds), onde milhares de linhas por ciclo lucrativo viram o
// gargalo real de I/O, não o cálculo em si — nunca setar isso em produção.
function resolveMinLevel(): number {
    const raw = process.env.LOG_LEVEL;
    return raw && raw in LOG_LEVELS ? LOG_LEVELS[raw as LogLevel] : LOG_LEVELS.info;
}
const minLevel = resolveMinLevel();

function formatFields(fields: LogFields): string {
    if (!fields || Object.keys(fields).length === 0) return '';
    return ' ' + JSON.stringify(fields, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}

function line(level: string, scope: string, message: string, fields: LogFields): string {
    return `${new Date().toISOString()} [${level}] [${scope}] ${message}${formatFields(fields)}`;
}

export interface Logger {
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export function createLogger(scope: string): Logger {
    return {
        info(message, fields) {
            if (LOG_LEVELS.info < minLevel) return;
            console.log(line('INFO', scope, message, fields));
        },
        warn(message, fields) {
            if (LOG_LEVELS.warn < minLevel) return;
            console.warn(line('WARN', scope, message, fields));
        },
        error(message, fields) {
            if (LOG_LEVELS.error < minLevel) return;
            console.error(line('ERROR', scope, message, fields));
        },
    };
}
