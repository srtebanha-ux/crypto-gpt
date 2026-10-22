/**
 * Read-only flash arbitrage readiness. No RPC, wallet or secret in the output.
 * A scanner can report profitable models while never calling eth_call or
 * broadcasting: no contract means the execution function returns immediately.
 */
export type FlashArbReadiness = Readonly<{
  modo: 'scanner-sem-executor'|'ensaio-onchain'|'envio-real'|'configuracao-bloqueada';
  contratoConfigurado: boolean;
  preflightDisponivel: boolean;
  envioAutorizado: boolean;
  bloqueios: string[];
}>;

/** Only names and status, never env values or a wallet private key. */
export function diagnosticarFlashArb(env: NodeJS.ProcessEnv = process.env): FlashArbReadiness {
  const contratoConfigurado = Boolean(env.FLASH_ARB_CONTRACT?.trim());
  const live = env.FLASH_ARB_LIVE === 'true';
  const confirmada = env.FLASH_ARB_CONFIRM === 'I_UNDERSTAND_THE_RISK';
  const chavePresente = Boolean(env.FLASH_ARB_PRIVATE_KEY?.trim());
  const bloqueios: string[] = [];

  if (!contratoConfigurado) bloqueios.push('FLASH_ARB_CONTRACT ausente: ciclo teorico nao chega ao eth_call');
  if (!live) bloqueios.push('FLASH_ARB_LIVE nao esta true: nada sera transmitido');
  if (live && !confirmada) bloqueios.push('FLASH_ARB_CONFIRM nao confirma envio real');
  if (live && !chavePresente) bloqueios.push('FLASH_ARB_PRIVATE_KEY ausente');
  const envioAutorizado = contratoConfigurado && live && confirmada && chavePresente;

  return {
    modo: envioAutorizado ? 'envio-real'
      : live ? 'configuracao-bloqueada'
      : contratoConfigurado ? 'ensaio-onchain' : 'scanner-sem-executor',
    contratoConfigurado,
    preflightDisponivel: contratoConfigurado,
    envioAutorizado,
    bloqueios,
  };
}
