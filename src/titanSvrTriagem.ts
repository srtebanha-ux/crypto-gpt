/**
 * Explicitly fail closed on Chainlink SVR auctions until a verifiable market
 * and executable solver are available. No wallet, RPC broadcast or secret.
 * A price hint is NOT a Morpho oracle price nor an authorized liquidation.
 */
import {isAddress} from 'ethers';
import {BASE_ATLAS,BASE_CONTROL} from './titanSvrOperacao';
import type {LeilaoSvr} from './titanSvr';

export interface TriagemLeilaoSvr {
 prontoParaEnviar:false;
 bloqueios:string[];
}

export function triarLeilaoSvr(
 leilao:LeilaoSvr,env:NodeJS.ProcessEnv={}
):TriagemLeilaoSvr{
 const bloqueios:string[]=[];
 if(leilao.atlas.toLowerCase()!==BASE_ATLAS.toLowerCase()||
    leilao.control.toLowerCase()!==BASE_CONTROL.toLowerCase())
   bloqueios.push('Atlas/DAppControl nao conferem com a Base Chainlink');
 if(!leilao.dapp)bloqueios.push('DApp da atualizacao nao identificado');
 if(!leilao.precoPrevisto)
   bloqueios.push('Sem aggregator e medianPrice futuros validos: nao inferir preco');
 else {
  const supported=(env.TITAN_SVR_FEEDS??'')
    .split(',').map(x=>x.trim().toLowerCase())
    .filter(x=>isAddress(x));
  if(!supported.includes(leilao.precoPrevisto.aggregador.toLowerCase()))
   bloqueios.push('Feed nao habilitado/mapeado a mercado e oraculo verificados');
 }
 if(!env.TITAN_SVR_SOLVER_ADDRESS||!isAddress(env.TITAN_SVR_SOLVER_ADDRESS))
   bloqueios.push('Executor SVR nao configurado/implantacao nao comprovada');
 // This MUST NOT automatically become true when an address/price exists.
 // Before changing this, implement simulated next-oracle state and verified
 // position, DEX output, bid, L1+L2 gas and bonded ETH gate.
 bloqueios.push('Sem simulacao atomica da posicao sob PRECO FUTURO do oraculo');
 bloqueios.push('Sem prova de bond, lucro liquido e recebimento do leilao');
 return {prontoParaEnviar:false,bloqueios};
}
