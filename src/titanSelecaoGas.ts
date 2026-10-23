/**
 * Selection of V2 opportunities with gas and profit denominated in the SAME token.
 * Comparing raw wei amounts across arbitrary ERC20 decimals is meaningless.
 * Unknown-price tokens remain visible as uncovered, never falsely profitable.
 */
export function selecionarRotasComGasComparavel<T extends { U:string }>(
    candidatos:readonly T[],tokenDoGas:string,teto:number,
):{selecionados:T[];semConversao:number;comConversao:number}{
    if(!/^0x[0-9a-fA-F]{40}$/.test(tokenDoGas)
        ||!Number.isSafeInteger(teto)||teto<1||teto>10_000)
        throw new Error('token ou limite da triagem de gas invalido');
    const token=tokenDoGas.toLowerCase();
    const comConversao=candidatos.filter(c=>c.U.toLowerCase()===token);
    // Caller already sorts same-token candidates by maximum gross output.
    // Never include unknown-unit routes just to fill the requested quota.
    return {
        selecionados:comConversao.slice(0,teto),
        comConversao:comConversao.length,
        semConversao:candidatos.length-comConversao.length,
    };
}
