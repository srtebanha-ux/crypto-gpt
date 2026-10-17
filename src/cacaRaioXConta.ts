/**
 * Diagnostico somente leitura para contas Aave V3 Base.
 * Descobre E-Mode e bitmap cru diretamente no Pool. Para o mapa de tokens,
 * usa getUserReserveData por ativo (respeita IDs de reserva que podem ter
 * lacunas; NUNCA confunde ordem da getReservesList com ID on-chain).
 *
 * Nao emite transacao, nem mexe no orcamento de gas.
 */
import { getAddress, id } from 'ethers';

export const SELETOR_EMODE_USUARIO=id('getUserEMode(address)').slice(0,10);
export const SELETOR_CONFIG_USUARIO=id('getUserConfiguration(address)').slice(0,10);

export function calldataDaConta(seletor:string,usuario:string):string{
    if(!/^0x[0-9a-fA-F]{8}$/.test(seletor))throw new Error('seletor invalido');
    return seletor+getAddress(usuario).slice(2).toLowerCase().padStart(64,'0');
}
export function lerPalavraDeConta(raw:string|null|undefined):bigint|null{
    if(!raw||!/^0x[0-9a-fA-F]{64}$/.test(raw))return null;
    return BigInt(raw);
}
export function lerEModeUsuario(raw:string|null|undefined):number|null{
    const b=lerPalavraDeConta(raw);
    if(b===null||b>255n)return null;
    return Number(b);
}
export interface ReservaObservada{
    token:string;
    saldoDeAToken:bigint;
    dividaVariavel:bigint;
    garantiaHabilitada:boolean;
}
export function resumirReservas(reservas:readonly ReservaObservada[]):{
    garantias:string[];
    devedores:string[];
    depositadosSemGarantia:string[];
}{
    const garantias:string[]=[],devedores:string[]=[],depositadosSemGarantia:string[]=[];
    for(const r of reservas){
        if(r.saldoDeAToken>0n && r.garantiaHabilitada) garantias.push(r.token.toLowerCase());
        else if(r.saldoDeAToken>0n)depositadosSemGarantia.push(r.token.toLowerCase());
        if(r.dividaVariavel>0n)devedores.push(r.token.toLowerCase());
    }
    return {garantias,devedores,depositadosSemGarantia};
}
