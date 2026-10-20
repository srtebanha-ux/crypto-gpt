/** Recover the onchain reason for a failed atomic liquidation WITHOUT leaking
 * calldata, private keys or full provider request/response objects. */
const STANDARD={
 '0x08c379a0':'Error(string)',
 '0x4e487b71':'Panic(uint256)',
} as const;
export function motivoDoRevertMorpho(err:unknown):string{
 const root=err&&typeof err==='object'?err as Record<string,unknown>:{};
 const nested=root.error&&typeof root.error==='object'
   ?root.error as Record<string,unknown>:{};
 const data=[root.data,nested.data].find(x=>typeof x==='string'&&/^0x[0-9a-fA-F]{8}/.test(x)) as string|undefined;
 const selector=data?.slice(0,10).toLowerCase();
 const detail=[root.reason,nested.reason,root.shortMessage,nested.shortMessage,root.message]
   .find(x=>typeof x==='string'&&x.trim().length>0) as string|undefined;
 // Provider messages can contain huge serialized RPC calldata: truncate, and
 // strip long hex strings and URL credentials before recording any diagnostics.
 const safe=detail?.replace(/0x[0-9a-fA-F]{36,}/g,'0x[omitted]')
   .replace(/https?:\/\/[^\s]+/g,'[rpc omitted]')
   .replace(/\s+/g,' ').slice(0,110);
 return [selector?(STANDARD[selector as keyof typeof STANDARD]??selector):null,safe]
   .filter(Boolean).join(' | ')||'sem dados de reversao do RPC';
}
export function resumoRevertsMorpho(
 faults:ReadonlyMap<string,number>,limit=3,
):string{
 return [...faults.entries()].sort((a,b)=>b[1]-a[1])
   .slice(0,limit).map(([reason,n])=>n+'x '+reason).join(' ; ').slice(0,380);
}
