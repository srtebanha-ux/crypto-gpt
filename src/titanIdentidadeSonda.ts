/**
 * Remetente da prova atomica somente-leitura do CacadorV3.
 * eth_call/estimateGas nao assinam; omitir "from" chama como endereco
 * padrao do RPC e reverte NaoEDono() antes de medir a economia.
 *
 * Nunca aceita identidade publica diferente de dono() onchain e nunca
 * fornece permissao de broadcast. Executar de verdade ainda exige o
 * assinador privado, a exclusividade de nonce e todos os gates financeiros.
 */
import {getAddress,Wallet} from 'ethers';

export type IdentidadeSondaTitan =
    'chave-conferida'|'endereco-publico-conferido'|'dono-onchain-somente-leitura';

export function remetenteDaSondaTitan(
    donoOnchain:string, env:NodeJS.ProcessEnv,
):{from:string;identidade:IdentidadeSondaTitan}{
    const dono=getAddress(donoOnchain);
    const nomes=['TITAN_ENDERECO_PUBLICO','MEGAZORD_ENDERECO_PUBLICO','CACA_ENDERECO_PUBLICO'] as const;
    let publicou=false;
    for(const nome of nomes){
        const valor=env[nome]?.trim();
        if(!valor)continue;
        publicou=true;
        // Todos os aliases declarados precisam concordar com o dono real.
        if(getAddress(valor)!==dono)
            throw Error(nome+' nao corresponde ao dono onchain; sonda cancelada');
    }
    if(env.TITAN_CHAVE_PRIVADA){
        if(new Wallet(env.TITAN_CHAVE_PRIVADA).address!==dono)
            throw Error('assinador TITAN nao corresponde ao dono onchain; sonda cancelada');
        return {from:dono,identidade:'chave-conferida'};
    }
    return {from:dono,identidade:publicou?'endereco-publico-conferido':
        'dono-onchain-somente-leitura'};
}
