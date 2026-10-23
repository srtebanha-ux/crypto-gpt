/** Politica V2: pedir envio implica rodar a prova somente-leitura primeiro. */
export function politicaDeSondaV2(env: NodeJS.ProcessEnv = process.env): {
    habilitada: boolean;
    ativadaPorEnvio: boolean;
    envioSolicitado: boolean;
} {
    const envioSolicitado = env.TITAN_V2_ENVIAR === '1';
    const sondaExplicita = env.TITAN_V2_SONDA === '1';
    return {
        habilitada: sondaExplicita || envioSolicitado,
        ativadaPorEnvio: envioSolicitado && !sondaExplicita,
        envioSolicitado,
    };
}
