/**
 * TITAN / Chainlink SVR Atlas v1.6.4.
 * Reproduces the SOLVER operation typed-data hashing and signing documented
 * in FastLane-Labs/atlas-sdk-go/types/solver_operation.go.
 *
 * Absolutely no gateway submit, wallet loading, transfer or bond action here.
 * This module formats a validated signed payload for final simulation.
 * Signing is a separate opt-in invocation requiring a supplied Wallet.
 */
import {
  getAddress,isAddress,TypedDataEncoder,verifyTypedData,
  Wallet,Signature,hexlify
} from 'ethers';
import type {LeilaoSvr} from './titanSvr';
import {BASE_CHAIN_ID} from './titanSvr';

export const BASE_ATLAS='0x583dcFef0D240DC80753F0F0B26513feE27D9B77';
export const BASE_CONTROL='0xa5E1a36938769cbd5a26f5e19D8FCB379f597c83';
export const ETH_ZERO='0x0000000000000000000000000000000000000000';

export const ATLAS_SOLVER_TYPES={
 SolverOperation:[
  {name:'from',type:'address'},
  {name:'to',type:'address'},
  {name:'value',type:'uint256'},
  {name:'gas',type:'uint256'},
  {name:'maxFeePerGas',type:'uint256'},
  {name:'deadline',type:'uint256'},
  {name:'solver',type:'address'},
  {name:'control',type:'address'},
  {name:'userOpHash',type:'bytes32'},
  {name:'bidToken',type:'address'},
  {name:'bidAmount',type:'uint256'},
  {name:'data',type:'bytes'},
 ]} as const;

export type OpAtlas={
 from:string;to:string;value:bigint;gas:bigint;maxFeePerGas:bigint;
 deadline:bigint;solver:string;control:string;userOpHash:string;
 bidToken:string;bidAmount:bigint;data:string;
};
export type OpAtlasRaw={
 from:string;to:string;value:string;gas:string;maxFeePerGas:string;
 deadline:string;solver:string;control:string;userOpHash:string;
 bidToken:string;bidAmount:string;data:string;signature:string;
};
export interface ContextoAtlas{
 signer:string;solverContract:string;verificationContract:string;
 atlasVersion:string;currentBlock:bigint;maxSolverGas:bigint;
 bondedWei:bigint;estimatedTotalGasWei:bigint;
}
function address(x:string):string{
 if(!isAddress(x))throw Error('Endereco invalido');
 return getAddress(x);
}
function bytes(x:string):string{
 if(typeof x!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(x))throw Error('Calldata invalido');
 return x;
}
export function validarEPlanejarOperacao(
 auction:LeilaoSvr,ctx:ContextoAtlas,bidWei:bigint,
 gasWei:bigint,calldata:string
):OpAtlas{
 if(auction.atlas.toLowerCase()!==BASE_ATLAS.toLowerCase()||
    auction.control.toLowerCase()!==BASE_CONTROL.toLowerCase())
   throw Error('Leilao nao e do Atlas/Base e control Chainlink esperados');
 if(!/^1\.6\.4$/.test(ctx.atlasVersion))throw Error('Versao Atlas nao validada');
 if(!/^0x[0-9a-fA-F]{64}$/.test(auction.hash))throw Error('userOpHash invalido');
 if(auction.deadline<=ctx.currentBlock)throw Error('Leilao expirado');
 if(bidWei<=0n||gasWei<=0n||gasWei>ctx.maxSolverGas)
   throw Error('Bid ou gas acima dos limites');
 if(ctx.bondedWei<ctx.estimatedTotalGasWei||ctx.estimatedTotalGasWei<=0n)
   throw Error('Bond Atlas insuficiente para reembolsar gas+oraculo');
 if(auction.maxFeePerGas<=0n)throw Error('Preco de gas invalido');
 const signer=address(ctx.signer),solver=address(ctx.solverContract);
 // Domain contract must be read from IAtlas.VERIFICATION() onchain,
 // not inferred to be the Atlas dispatcher contract.
 address(ctx.verificationContract);
 if(solver===ETH_ZERO)throw Error('Executor SVR nao implantado');
 return {
  from:signer,to:getAddress(auction.atlas),value:0n,gas:gasWei,
  maxFeePerGas:auction.maxFeePerGas,deadline:auction.deadline,
  solver,control:getAddress(auction.control),userOpHash:auction.hash,
  bidToken:ETH_ZERO,bidAmount:bidWei,data:bytes(calldata),
 };
}
export function dominioAtlas(c:ContextoAtlas){
 return {
  name:'AtlasVerification',version:c.atlasVersion,
  chainId:BASE_CHAIN_ID,verifyingContract:address(c.verificationContract)
 };
}
export function hashOperacaoAtlas(op:OpAtlas,c:ContextoAtlas):string{
 return TypedDataEncoder.hash(dominioAtlas(c),ATLAS_SOLVER_TYPES as any,op);
}
export function rawOpAtlas(op:OpAtlas,signature:string):OpAtlasRaw{
 if(!/^0x[a-fA-F0-9]{130}$/.test(signature))throw Error('Assinatura inválida');
 const h=(x:bigint)=>'0x'+x.toString(16);
 return{
  from:op.from,to:op.to,value:h(op.value),gas:h(op.gas),
  maxFeePerGas:h(op.maxFeePerGas),deadline:h(op.deadline),
  solver:op.solver,control:op.control,userOpHash:op.userOpHash,
  bidToken:op.bidToken,bidAmount:h(op.bidAmount),
  data:op.data,signature
 };
}
export interface OfertaAtlas{
 auction_id:string;auction_solution:OpAtlasRaw;
}
/**
 * Wallet.signMessage() would add an EIP-191 prefix and be WRONG here.
 * The Atlas SDK signs the EIP-712 typed hash directly using secp256k1.
 * Use Wallet.signingKey.sign(typedHash) and verify signer afterward.
 */
export function assinarOperacaoAtlasSomentePreparacao(
 auction:LeilaoSvr,ctx:ContextoAtlas,op:OpAtlas,
 wallet:Wallet
):OfertaAtlas{
 if(address(wallet.address)!==address(ctx.signer)||address(op.from)!==address(wallet.address))
  throw Error('Signer não corresponde ao dono/conta bonded');
 if(op.userOpHash.toLowerCase()!==auction.hash.toLowerCase()||
    op.deadline!==auction.deadline||op.to.toLowerCase()!==auction.atlas.toLowerCase())
  throw Error('Operacao nao corresponde ao leilao');
 const digest=hashOperacaoAtlas(op,ctx);
 const signature=Signature.from(wallet.signingKey.sign(digest)).serialized;
 const recovered=verifyTypedData(dominioAtlas(ctx),ATLAS_SOLVER_TYPES as any,op,signature);
 if(address(recovered)!==address(wallet.address))
  throw Error('Falha de verificacao EIP712');
 return{auction_id:auction.id,auction_solution:rawOpAtlas(op,signature)};
}
export function envelopeJsonRpcDeEnvio(signed:OfertaAtlas,requestId=1){
 if(!Number.isSafeInteger(requestId)||requestId<1)throw Error('request id invalido');
 return {jsonrpc:'2.0' as const,id:requestId,method:'solver_submitSolverOperation' as const,
  params:[signed]};
}
