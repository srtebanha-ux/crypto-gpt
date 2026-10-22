/** Resolve identidade PUBLICA para simulações read-only, sem exigir signer. */
import {Wallet,getAddress} from 'ethers';

export function identidadeDeProvaV2(env: NodeJS.ProcessEnv):string|null {
  const publicValue=env.TITAN_ENDERECO_PUBLICO
    ?? env.MEGAZORD_ENDERECO_PUBLICO ?? env.CACA_ENDERECO_PUBLICO;
  const publicAddress=publicValue ? getAddress(publicValue) : null;
  if (publicAddress && env.TITAN_CHAVE_PRIVADA) {
    // Nunca simular como dono diferente de quem assinaria de verdade.
    if(new Wallet(env.TITAN_CHAVE_PRIVADA).address!==publicAddress)
      throw Error('endereco publico nao corresponde ao assinador configurado');
  }
  if(publicAddress)return publicAddress;
  return env.TITAN_CHAVE_PRIVADA ? new Wallet(env.TITAN_CHAVE_PRIVADA).address : null;
}
