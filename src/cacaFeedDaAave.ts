/**
 * AaveOracle.getSourceOfAsset(address): identifica o feed realmente consumido
 * pela Aave na Base; a cotacao da exchange nao substitui esse endereco.
 *
 * Puro, sem chamadas RPC. O bot usa estes bytes apenas em leituras e logs.
 */
import { getAddress, id } from 'ethers';

const SELETOR=id('getSourceOfAsset(address)').slice(0,10);
export function dadosDaFonteNoAaveOracle(token:string):string{
    const endereco=getAddress(token);
    return SELETOR+endereco.slice(2).toLowerCase().padStart(64,'0');
}
export function lerFonteDoAaveOracle(hex:string):string|null{
    if(!/^0x[0-9a-fA-F]{64}$/.test(hex))return null;
    const valor=hex.slice(-40);
    if(/^0{40}$/i.test(valor))return null;
    try{return getAddress('0x'+valor)}catch{return null}
}
