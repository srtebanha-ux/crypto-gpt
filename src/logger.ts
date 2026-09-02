// Arquivo: src/logger.ts
//
// Logger mínimo com timestamp ISO e nível, para saída consistente em toda a
// aplicação (stdout para info/warn, stderr para warn/error, seguindo a
// convenção de streams do Node).
type LogFields = Record<string, unknown> | undefined;

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
            console.log(line('INFO', scope, message, fields));
        },
        warn(message, fields) {
            console.warn(line('WARN', scope, message, fields));
        },
        error(message, fields) {
            console.error(line('ERROR', scope, message, fields));
        },
    };
}
