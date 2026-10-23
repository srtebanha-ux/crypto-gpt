/**
 * Seletor de rota Aerodrome V2 para liquidacao Aave.
 * Enderecos sao obtidos somente de getPool(tokenA,tokenB,stable) on-chain.
 * Nao confunde "pool existe" com liquidez, lucro ou permissao para enviar.
 */
export interface PoolsAerodromeConfirmados{
  estavel:string|null;
  volatil:string|null;
}
export function modosV2ParaSimular(
  confirmado:PoolsAerodromeConfirmados|null,
  mesmoAtivo:boolean,
):boolean[]{
  // Contrato V2 pula a troca para garantia == divida.
  if(mesmoAtivo)return [false];
  // Nao inferir ausencia de pool de RPC indisponivel. Manter caminho
  // legado sujeito a simulacao completa e revert antes de usar nonce.
  if(confirmado===null)return [false];
  const modos:boolean[]=[];
  if(confirmado.volatil)modos.push(false);
  if(confirmado.estavel)modos.push(true);
  return modos;
}
